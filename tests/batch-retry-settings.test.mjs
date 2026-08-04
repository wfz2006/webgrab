import test from 'node:test';
import assert from 'node:assert/strict';

const handles = new Map();
const terminalWaiters = new Map();
let runtimeListener = null;

const realConsoleWarn = console.warn;
const realConsoleError = console.error;
console.warn = () => {};
console.error = () => {};
test.after(() => {
  console.warn = realConsoleWarn;
  console.error = realConsoleError;
});

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
              get(key) {
                const req = {};
                queueMicrotask(() => { req.result = handles.get(key); req.onsuccess?.(); });
                return req;
              },
              delete(key) { handles.delete(key); },
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
    async sendMessage(message) {
      if (message.type === 'TASK_UPDATE') {
        const report = structuredClone(message.task);
        if (['done', 'failed', 'canceled'].includes(report.status)) {
          terminalWaiters.get(report.id)?.(report);
          terminalWaiters.delete(report.id);
        }
        return { ok: true };
      }
      if (message.type === 'BATCH_FALLBACK_DOWNLOAD') return { ok: false, error: 'no fallback in this test' };
      return { ok: true };
    },
  },
  storage: {
    local: {
      async get(key) { return { [key]: { retryCount: 2, segmentConcurrency: 6 } }; },
    },
    // 顶层 watchDownloadSettings() 需要 onChanged.addListener 存在，否则会走空实现
    onChanged: { addListener() {}, removeListener() {} },
  },
};

await import('../offscreen/queue.js');
// 等待模块顶层的 loadDownloadSettings().then(...) 完成，确保 retryCount=2 已生效
await new Promise((resolve) => setTimeout(resolve, 0));

function createDirectoryHandle() {
  return {
    async getFileHandle() {
      return { async createWritable() { return { async write() {}, async close() {} }; } };
    },
  };
}

async function runBatch(resources, dirHandle) {
  const taskId = `batch_retry_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dirHandleKey = `${taskId}_dir`;
  handles.set(dirHandleKey, dirHandle);

  const terminalReport = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待批量任务终态超时')), 1000);
    terminalWaiters.set(taskId, (task) => { clearTimeout(timeout); resolve(task); });
  });

  await new Promise((resolve, reject) => {
    runtimeListener(
      {
        type: 'EXECUTE_TASK',
        target: 'offscreen',
        task: {
          id: taskId,
          url: resources[0]?.url || '',
          fileName: `批量下载(${resources.length}个文件)`,
          kind: 'image',
          size: -1,
          streamMeta: { kind: 'batch', resources, dirHandleKey },
        },
      },
      {},
      (response) => { if (response?.ok) resolve(response); else reject(new Error(response?.error || 'EXECUTE_TASK 失败')); }
    );
  });

  return terminalReport;
}

test('设置的重试次数用尽前，瞬时失败会自动重试并最终成功', async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls <= 2) throw new TypeError('Failed to fetch');
    return { ok: true, status: 200, async arrayBuffer() { return Uint8Array.from([1, 2, 3]).buffer; } };
  };

  const task = await runBatch(
    [{ url: 'https://cdn.example.test/retry-ok.jpg', title: 'r', ext: 'jpg' }],
    createDirectoryHandle()
  );

  assert.equal(calls, 3); // 首次 + 2 次重试后成功
  assert.equal(task.status, 'done');
  assert.equal(task.diagnostics.length, 0);
});

test('重试次数用尽后仍失败，只记一条 fetch 诊断（不因为中间重试重复记录），随后照常落到 fallback 阶段', async () => {
  let calls = 0;
  globalThis.fetch = async () => { calls++; throw new TypeError('Failed to fetch'); };

  const task = await runBatch(
    [{ url: 'https://cdn.example.test/retry-fail.jpg', title: 'f', ext: 'jpg' }],
    createDirectoryHandle()
  );

  assert.equal(calls, 3); // retryCount=2 → 共尝试 3 次
  const fetchDiagnostics = task.diagnostics.filter((item) => item.stage === 'fetch');
  assert.equal(fetchDiagnostics.length, 1);
});
