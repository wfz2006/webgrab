import assert from 'node:assert/strict';
import test from 'node:test';

/**
 * 无文件句柄的降级路径（悬浮窗 iframe、File System Access API 不可用等）：
 * offscreen 把数据攒成 Blob，再让 SW 用 chrome.downloads.download() 落盘。
 * 这一步失败时任务必须如实报失败——否则用户看到"已完成"，磁盘上却没有文件。
 */

const realSetTimeout = globalThis.setTimeout;

/** 由各测试改写的可变行为钩子 */
const behavior = {
  downloadOutcome: { state: 'complete' },
  downloadThrows: null,
  blobDownloadResponse: null,
};

const taskReports = [];
const terminalWaiters = new Map();
let runtimeListener = null;
const downloadCalls = [];
const storage = {};
let nextDownloadId = 1;
const downloadListeners = new Set();
const downloadItems = new Map();

globalThis.indexedDB = {
  open() {
    const request = {};
    queueMicrotask(() => {
      request.result = {
        objectStoreNames: { contains: () => true },
        createObjectStore() {},
        transaction() {
          return {
            objectStore: () => ({
              get() {
                const result = {};
                queueMicrotask(() => {
                  result.result = undefined;
                  result.onsuccess?.();
                });
                return result;
              },
              put() {},
              delete() {},
            }),
          };
        },
      };
      request.onupgradeneeded?.();
      request.onsuccess?.();
    });
    return request;
  },
};

globalThis.chrome = {
  runtime: {
    lastError: null,
    getURL(path) { return `chrome-extension://test/${path}`; },
    onMessage: { addListener(listener) { runtimeListener = listener; } },
    async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
    async sendMessage(message) {
      if (message.type === 'TASK_UPDATE') {
        const report = structuredClone(message.task);
        taskReports.push(report);
        if (['done', 'failed', 'canceled'].includes(report.status)) {
          terminalWaiters.get(report.id)?.(report);
          terminalWaiters.delete(report.id);
        }
        return { ok: true };
      }
      if (message.type === 'BLOB_DOWNLOAD') {
        return behavior.blobDownloadResponse ?? { ok: true };
      }
      return { ok: true };
    },
  },
  storage: {
    local: {
      async get(key) {
        if (key === 'webgrab_download_settings') {
          return { [key]: { retryCount: 0, segmentConcurrency: 2 } };
        }
        return { [key]: structuredClone(storage[key]) };
      },
      async set(values) { Object.assign(storage, structuredClone(values)); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  downloads: {
    onChanged: {
      addListener(listener) { downloadListeners.add(listener); },
      removeListener(listener) { downloadListeners.delete(listener); },
    },
    download(options, callback) {
      downloadCalls.push(structuredClone(options));
      if (behavior.downloadThrows) {
        chrome.runtime.lastError = { message: behavior.downloadThrows };
        callback(undefined);
        chrome.runtime.lastError = null;
        return;
      }
      const id = nextDownloadId++;
      const outcome = behavior.downloadOutcome;
      downloadItems.set(id, { id, state: outcome.state, error: outcome.error });
      callback(id);
      for (const listener of [...downloadListeners]) {
        listener({ id, state: { current: outcome.state } });
      }
    },
    search(query) {
      const item = downloadItems.get(query.id);
      return Promise.resolve(item ? [item] : []);
    },
    async cancel() {},
    async erase() { return []; },
  },
  declarativeNetRequest: {
    async updateSessionRules() {},
    async getSessionRules() { return []; },
  },
};

await import('../offscreen/queue.js');
await new Promise((resolve) => realSetTimeout(resolve, 0));

function stubFetchWithBody(bytes) {
  globalThis.fetch = async (url, init) => {
    const isProbe = init?.headers?.Range === 'bytes=0-0';
    return {
      ok: true,
      status: 200,
      // 不声明 accept-ranges/content-range → 走单线程流式下载
      headers: { get: (name) => (name.toLowerCase() === 'content-length' ? String(bytes.length) : null) },
      body: isProbe ? undefined : {
        getReader() {
          let sent = false;
          return {
            async read() {
              if (sent) return { done: true, value: undefined };
              sent = true;
              return { done: false, value: bytes };
            },
            cancel() {},
          };
        },
      },
      async arrayBuffer() { return bytes.buffer; },
    };
  };
}

async function runDirectBlobTask(taskId) {
  const terminal = new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new Error('等待任务终态超时')), 3000);
    terminalWaiters.set(taskId, (task) => {
      clearTimeout(timer);
      resolve(task);
    });
  });

  await new Promise((resolve, reject) => {
    runtimeListener({
      type: 'EXECUTE_TASK',
      target: 'offscreen',
      task: {
        id: taskId,
        url: 'https://cdn.example.test/clip.mp4',
        fileName: 'clip.mp4',
        kind: 'video',
        size: 8,
        fileHandleKey: null, // 关键：没有句柄 → FileWriter 走 Blob 降级
        headers: {},
      },
    }, {}, (response) => {
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || 'EXECUTE_TASK 失败'));
    });
  });

  return terminal;
}

test('Blob 降级路径保存失败时任务必须标记为 failed，不能谎报 done', async () => {
  stubFetchWithBody(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  behavior.blobDownloadResponse = { ok: false, error: '磁盘空间不足' };

  const task = await runDirectBlobTask(`blob_fail_${Date.now()}`);

  assert.equal(task.status, 'failed', 'Blob 落盘失败却报 done 等于骗用户文件已保存');
  assert.match(String(task.error), /磁盘空间不足/);
});

test('Blob 降级路径保存成功时任务正常标记为 done', async () => {
  stubFetchWithBody(Uint8Array.of(1, 2, 3, 4, 5, 6, 7, 8));
  behavior.blobDownloadResponse = { ok: true };

  const task = await runDirectBlobTask(`blob_ok_${Date.now()}`);

  assert.equal(task.status, 'done');
  assert.equal(task.error, null);
});

test('handleBlobDownload 在 chrome.downloads.download 启动失败时抛错而不是静默吞掉', async () => {
  const url = new URL('../background/download-manager.js', import.meta.url);
  url.searchParams.set('blob-outcome-test', 'start-failure');
  const manager = await import(url.href);

  behavior.downloadThrows = 'Invalid filename';
  try {
    await assert.rejects(
      () => manager.handleBlobDownload('t1', 'blob:chrome-extension://test/abc', 'clip.mp4'),
      /Invalid filename/
    );
  } finally {
    behavior.downloadThrows = null;
  }
});

test('handleBlobDownload 在下载被中断时抛错，成功时正常返回', async () => {
  const url = new URL('../background/download-manager.js', import.meta.url);
  url.searchParams.set('blob-outcome-test', 'interrupted');
  const manager = await import(url.href);

  behavior.downloadOutcome = { state: 'interrupted', error: 'FILE_NO_SPACE' };
  await assert.rejects(
    () => manager.handleBlobDownload('t2', 'blob:chrome-extension://test/abc', 'clip.mp4'),
    /FILE_NO_SPACE/
  );

  behavior.downloadOutcome = { state: 'complete' };
  await manager.handleBlobDownload('t3', 'blob:chrome-extension://test/abc', 'clip.mp4');
});
