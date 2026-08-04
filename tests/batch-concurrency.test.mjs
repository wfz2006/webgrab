import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const handles = new Map();
const terminalWaiters = new Map();
let runtimeListener = null;
const fallbackMessages = [];

class MemoryFileHandle {
  constructor(name) {
    this.name = name;
    this.content = new Uint8Array();
  }

  async createWritable() {
    const chunks = [];
    return {
      write: async (chunk) => chunks.push(new Uint8Array(chunk)),
      close: async () => {
        const size = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const output = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          output.set(chunk, offset);
          offset += chunk.length;
        }
        this.content = output;
      },
    };
  }
}

class MemoryDirectoryHandle {
  constructor() {
    this.files = new Map();
    this.directories = new Map();
  }

  async getFileHandle(name, options = {}) {
    const existed = this.files.has(name);
    await Promise.resolve();
    if (!existed && !options.create) throw new DOMException('missing', 'NotFoundError');
    if (!this.files.has(name)) this.files.set(name, new MemoryFileHandle(name));
    return this.files.get(name);
  }

  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name) && !options.create) throw new DOMException('missing', 'NotFoundError');
    if (!this.directories.has(name)) this.directories.set(name, new MemoryDirectoryHandle());
    return this.directories.get(name);
  }
}

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
                const result = {};
                queueMicrotask(() => {
                  result.result = handles.get(key);
                  result.onsuccess?.();
                });
                return result;
              },
              delete(key) {
                handles.delete(key);
              },
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
      if (message.type === 'BATCH_FALLBACK_DOWNLOAD') {
        fallbackMessages.push(structuredClone(message));
        return { ok: false, error: '测试不允许 fallback' };
      }
      return { ok: true };
    },
  },
  storage: {
    local: {
      async get(key) {
        return { [key]: { retryCount: 0, segmentConcurrency: 3 } };
      },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
};

await import('../offscreen/queue.js');
await new Promise((resolve) => setTimeout(resolve, 0));

async function startBatch(resources, directory) {
  const taskId = `batch_concurrency_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const dirHandleKey = `${taskId}_dir`;
  handles.set(dirHandleKey, directory);

  const terminal = new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待批量任务终态超时')), 1500);
    terminalWaiters.set(taskId, (task) => {
      clearTimeout(timeout);
      resolve(task);
    });
  });

  await new Promise((resolve, reject) => {
    runtimeListener({
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
    }, {}, (response) => {
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || 'EXECUTE_TASK 失败'));
    });
  });

  return { taskId, terminal };
}

async function cancelBatch(taskId) {
  await new Promise((resolve, reject) => {
    runtimeListener({ type: 'CANCEL_TASK', target: 'offscreen', taskId }, {}, (response) => {
      if (response?.ok) resolve(response);
      else reject(new Error(response?.error || 'CANCEL_TASK 失败'));
    });
  });
}

function batchResources(count, sameName = false) {
  return Array.from({ length: count }, (_, index) => ({
    url: `https://cdn.test/batch-${index + 1}.jpg`,
    title: `batch-${index + 1}`,
    ext: 'jpg',
    organizedPath: sameName ? 'image.jpg' : `image-${index + 1}.jpg`,
  }));
}

test('批量下载复用设置中的并发数并完整写入每个文件', async () => {
  const directory = new MemoryDirectoryHandle();
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 12));
    active--;
    const marker = Number(new URL(url).pathname.match(/\d+/)[0]);
    return { ok: true, status: 200, async arrayBuffer() { return Uint8Array.of(marker).buffer; } };
  };

  const { terminal } = await startBatch(batchResources(6), directory);
  const task = await terminal;

  assert.equal(maxActive, 3);
  assert.equal(task.status, 'done');
  assert.equal(task.downloaded, 6);
  assert.equal(directory.files.size, 6);
  for (let index = 1; index <= 6; index++) {
    assert.equal(directory.files.get(`image-${index}.jpg`).content[0], index);
  }
});

test('并发下载的两个同名资源会原子占名并生成 uniquify 后缀', async () => {
  const directory = new MemoryDirectoryHandle();
  let active = 0;
  let maxActive = 0;
  globalThis.fetch = async (url) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    const marker = url.includes('batch-1') ? 1 : 2;
    return { ok: true, status: 200, async arrayBuffer() { return Uint8Array.of(marker).buffer; } };
  };

  const { terminal } = await startBatch(batchResources(2, true), directory);
  const task = await terminal;

  assert.equal(maxActive, 2);
  assert.equal(task.downloaded, 2);
  assert.deepEqual([...directory.files.keys()].sort(), ['image (2).jpg', 'image.jpg']);
  assert.deepEqual([...directory.files.values()].map((file) => file.content[0]).sort(), [1, 2]);
});

test('批量并发取消后不再领取新资源', async () => {
  const directory = new MemoryDirectoryHandle();
  fallbackMessages.length = 0;
  let started = 0;
  let releaseRequests;
  const requestGate = new Promise((resolve) => { releaseRequests = resolve; });
  globalThis.fetch = async () => {
    started++;
    await requestGate;
    return { ok: false, status: 503, async arrayBuffer() { return new ArrayBuffer(0); } };
  };

  const { taskId, terminal } = await startBatch(batchResources(8), directory);
  const deadline = Date.now() + 50;
  while (started < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  await cancelBatch(taskId);
  releaseRequests();
  await terminal;
  await new Promise((resolve) => setTimeout(resolve, 20));

  assert.equal(started, 3);
  assert.equal(fallbackMessages.length, 0, '取消后不能再为已失败的主请求发起 fallback');
});

test('设置页并发说明同时覆盖单文件、批量下载与漫画打包', async () => {
  const html = await readFile(new URL('../ui/options.html', import.meta.url), 'utf8');
  assert.match(html, /单个视频\/音频/);
  assert.match(html, /批量下载/);
  assert.match(html, /漫画打包/);
});
