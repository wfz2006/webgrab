import test from 'node:test';
import assert from 'node:assert/strict';

const handles = new Map();
const terminalWaiters = new Map();
let runtimeListener = null;
let fallbackHandler = async () => ({ ok: true });
const realConsoleWarn = console.warn;
const realConsoleError = console.error;

console.warn = () => {};
console.error = () => {};
test.after(() => {
  console.warn = realConsoleWarn;
  console.error = realConsoleError;
});

function createIndexedDbMock() {
  const db = {
    objectStoreNames: {
      contains() {
        return true;
      },
    },
    createObjectStore() {},
    transaction() {
      const tx = {
        objectStore() {
          return {
            get(key) {
              const request = {};
              queueMicrotask(() => {
                request.result = handles.get(key);
                request.onsuccess?.();
              });
              return request;
            },
            delete(key) {
              handles.delete(key);
              queueMicrotask(() => tx.oncomplete?.());
            },
          };
        },
      };
      return tx;
    },
  };

  return {
    open() {
      const request = {};
      queueMicrotask(() => {
        request.result = db;
        request.onupgradeneeded?.();
        request.onsuccess?.();
      });
      return request;
    },
  };
}

globalThis.indexedDB = createIndexedDbMock();
globalThis.chrome = {
  runtime: {
    lastError: null,
    getURL(path) {
      return `chrome-extension://test/${path}`;
    },
    onMessage: {
      addListener(listener) {
        runtimeListener = listener;
      },
    },
    async sendMessage(message) {
      if (message.type === 'TASK_UPDATE') {
        const report = structuredClone(message.task);
        if (['done', 'failed', 'canceled'].includes(report.status)) {
          terminalWaiters.get(report.id)?.(report);
          terminalWaiters.delete(report.id);
        }
        return { ok: true };
      }
      if (message.type === 'BATCH_FALLBACK_DOWNLOAD') {
        return fallbackHandler(message);
      }
      return { ok: true };
    },
  },
};

await import('../offscreen/queue.js');

function createDirectoryHandle({ writeError = null } = {}) {
  return {
    async getFileHandle() {
      return {
        async createWritable() {
          return {
            async write() {
              if (writeError) throw writeError;
            },
            async close() {},
          };
        },
      };
    },
  };
}

async function runBatch(resources, dirHandle) {
  const taskId = `batch_diag_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dirHandleKey = `${taskId}_dir`;
  handles.set(dirHandleKey, dirHandle);

  const terminalReport = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待批量任务终态超时')), 1000);
    terminalWaiters.set(taskId, (task) => {
      clearTimeout(timeout);
      resolve(task);
    });
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
          streamMeta: {
            kind: 'batch',
            resources,
            dirHandleKey,
          },
        },
      },
      {},
      (response) => {
        if (response?.ok) resolve(response);
        else reject(new Error(response?.error || 'EXECUTE_TASK 失败'));
      }
    );
  });

  return terminalReport;
}

test('批量 fetch 的 HTTP 失败和 fallback 失败会分阶段写入 diagnostics', async () => {
  globalThis.fetch = async () => ({
    ok: false,
    status: 503,
    async arrayBuffer() {
      return new ArrayBuffer(0);
    },
  });
  fallbackHandler = async () => ({ ok: false, error: '备用下载被拒绝' });

  const task = await runBatch(
    [{ url: 'https://cdn.example.test/a.jpg', title: 'a', ext: 'jpg' }],
    createDirectoryHandle()
  );

  assert.deepEqual(task.diagnostics, [
    {
      url: 'https://cdn.example.test/a.jpg',
      fileName: 'a.jpg',
      stage: 'fetch',
      errName: 'Error',
      errMessage: 'HTTP 503',
      httpStatus: 503,
    },
    {
      url: 'https://cdn.example.test/a.jpg',
      fileName: 'a.jpg',
      stage: 'fallback',
      errName: 'Error',
      errMessage: '备用下载被拒绝',
      httpStatus: null,
    },
  ]);
});

test('批量写盘失败会记录 write 阶段，而不是误记为 fetch', async () => {
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    async arrayBuffer() {
      return Uint8Array.from([0xff, 0xd8, 0xff]).buffer;
    },
  });
  fallbackHandler = async () => ({ ok: true });

  const writeError = new DOMException('目录句柄没有写权限', 'NotAllowedError');
  const task = await runBatch(
    [{ url: 'https://cdn.example.test/b.jpg', title: 'b', ext: 'jpg' }],
    createDirectoryHandle({ writeError })
  );

  assert.deepEqual(task.diagnostics, [
    {
      url: 'https://cdn.example.test/b.jpg',
      fileName: 'b.jpg',
      stage: 'write',
      errName: 'NotAllowedError',
      errMessage: '目录句柄没有写权限',
      httpStatus: 200,
    },
  ]);
});

test('批量 diagnostics 最多保留 20 条', async () => {
  globalThis.fetch = async () => {
    throw new TypeError('Failed to fetch');
  };
  fallbackHandler = async () => ({ ok: true });

  const resources = Array.from({ length: 25 }, (_, index) => ({
    url: `https://cdn.example.test/${index + 1}.jpg`,
    title: String(index + 1),
    ext: 'jpg',
  }));
  const task = await runBatch(resources, createDirectoryHandle());

  assert.equal(task.diagnostics.length, 20);
  assert.ok(task.diagnostics.every((item) => item.stage === 'fetch'));
  assert.ok(task.diagnostics.every((item) => item.httpStatus === null));
});
