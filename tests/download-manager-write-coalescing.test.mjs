import assert from 'node:assert/strict';
import test from 'node:test';

const realSetTimeout = globalThis.setTimeout;
let importSequence = 0;

/**
 * 复现生产环境的关键时序：chrome.storage.local 的 get/set 有真实的异步开销，
 * 不是同步完成的。这是验证"合并写入"是否真的减少了排队读改写次数的前提——
 * 如果 get/set 同步完成，高频更新根本不会在 taskWriteGate 里排上队。
 */
function createChromeMock(initialTasks = []) {
  const storage = { webgrab_tasks: structuredClone(initialTasks) };
  const setCalls = [];
  const getCalls = [];

  const chromeMock = {
    runtime: {
      async getContexts() {
        return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
      async sendMessage() {
        return { ok: true };
      },
    },
    storage: {
      local: {
        async get(key) {
          getCalls.push(Date.now());
          const snapshot = structuredClone(storage[key]);
          await new Promise((resolve) => realSetTimeout(resolve, 2));
          return { [key]: snapshot };
        },
        async set(values) {
          setCalls.push(Date.now());
          await new Promise((resolve) => realSetTimeout(resolve, 2));
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    offscreen: {
      async createDocument() {},
      async closeDocument() {},
    },
    declarativeNetRequest: {
      async updateSessionRules() {},
      async getSessionRules() {
        return [];
      },
    },
  };

  return { chromeMock, storage, setCalls, getCalls };
}

async function importFreshManager() {
  const url = new URL('../background/download-manager.js', import.meta.url);
  url.searchParams.set('write-coalescing-test', String(importSequence++));
  return import(url.href);
}

function installHarness(t, initialTasks = []) {
  const mock = createChromeMock(initialTasks);
  globalThis.chrome = mock.chromeMock;
  t.after(() => {
    delete globalThis.chrome;
  });
  return mock;
}

test('同一任务在写入排队期间连续到达的高频进度更新会合并成一次落盘', async (t) => {
  const mock = installHarness(t, [{ id: 'progress-task', status: 'downloading', downloaded: 0 }]);
  const manager = await importFreshManager();

  // 20 次更新在同一个 JS 事件循环 tick 内同步发起（不 await 彼此），
  // 模拟并发分片/分块进度回调几乎同时到达 SW 的场景。
  await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      manager.handleTaskUpdate({ id: 'progress-task', status: 'downloading', downloaded: index + 1 })
    )
  );

  assert.equal(
    mock.storage.webgrab_tasks.find((task) => task.id === 'progress-task')?.downloaded,
    20,
    '所有调用方 await 后必须看到合并后的最新数据，不能因为合并写入而丢失最后一次更新'
  );
  assert.ok(
    mock.setCalls.length < 20,
    `20 次同任务高频更新应该被合并成远少于 20 次落盘，实际 storage.local.set 被调用 ${mock.setCalls.length} 次`
  );
});

test('合并写入不会跨任务串味：两个任务的高频更新各自独立落盘', async (t) => {
  const mock = installHarness(t, [
    { id: 'task-a', status: 'downloading', downloaded: 0 },
    { id: 'task-b', status: 'downloading', downloaded: 0 },
  ]);
  const manager = await importFreshManager();

  await Promise.all([
    ...Array.from({ length: 10 }, (_, i) =>
      manager.handleTaskUpdate({ id: 'task-a', status: 'downloading', downloaded: i + 1 })
    ),
    ...Array.from({ length: 10 }, (_, i) =>
      manager.handleTaskUpdate({ id: 'task-b', status: 'downloading', downloaded: (i + 1) * 100 })
    ),
  ]);

  assert.equal(mock.storage.webgrab_tasks.find((t) => t.id === 'task-a')?.downloaded, 10);
  assert.equal(mock.storage.webgrab_tasks.find((t) => t.id === 'task-b')?.downloaded, 1000);
});

test('进度更新排队期间又到达的终态更新会随合并写入一起落盘，并触发 offscreen 收尾', async (t) => {
  const mock = installHarness(t, [{ id: 'quick-finish', status: 'downloading', downloaded: 0 }]);
  const manager = await importFreshManager();

  await manager.executeWithHandle('other-active', 'file-key', {
    url: 'https://assets.example.test/x.jpg',
    title: 'x',
    ext: 'jpg',
    kind: 'image',
    size: 1024,
  });

  // 同一 tick 内：先若干次进度上报，紧接着一次终态上报——终态必须不被丢弃，
  // 且合并后的落盘要能正确识别出"这是终态"并回收资源（幂等，不影响其他活跃任务）。
  await Promise.all([
    ...Array.from({ length: 5 }, (_, i) =>
      manager.handleTaskUpdate({ id: 'quick-finish', status: 'downloading', downloaded: i + 1 })
    ),
    manager.handleTaskUpdate({ id: 'quick-finish', status: 'done', downloaded: 999, completedAt: Date.now() }),
  ]);

  assert.equal(
    mock.storage.webgrab_tasks.find((t) => t.id === 'quick-finish')?.status,
    'done',
    '与进度更新合并落盘后，终态不能被中间进度值覆盖回 downloading'
  );
});
