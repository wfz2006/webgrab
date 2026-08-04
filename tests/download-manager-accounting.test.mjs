import assert from 'node:assert/strict';
import test from 'node:test';

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
let importSequence = 0;

function createChromeMock(initialTasks = []) {
  const storage = { webgrab_tasks: structuredClone(initialTasks) };
  const runtimeMessages = [];
  const offscreenCloseCalls = [];
  const dnrRules = new Map();

  const chromeMock = {
    runtime: {
      async getContexts() {
        return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
      },
      async sendMessage(message) {
        runtimeMessages.push(structuredClone(message));
        return { ok: true };
      },
    },
    storage: {
      local: {
        async get(key) {
          const snapshot = structuredClone(storage[key]);
          await Promise.resolve();
          return { [key]: snapshot };
        },
        async set(values) {
          await Promise.resolve();
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    offscreen: {
      async createDocument() {},
      async closeDocument() {
        offscreenCloseCalls.push(Date.now());
      },
    },
    declarativeNetRequest: {
      async updateSessionRules(update) {
        for (const rule of update.addRules || []) dnrRules.set(rule.id, structuredClone(rule));
        for (const id of update.removeRuleIds || []) dnrRules.delete(id);
      },
      async getSessionRules() {
        return [...dnrRules.values()];
      },
    },
  };

  return { chromeMock, storage, runtimeMessages, offscreenCloseCalls };
}

async function importFreshManager() {
  const url = new URL('../background/download-manager.js', import.meta.url);
  url.searchParams.set('accounting-test', String(importSequence++));
  return import(url.href);
}

function installHarness(t, initialTasks = []) {
  const mock = createChromeMock(initialTasks);
  const closeTimers = new Map();
  let nextTimerId = 1;

  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) => {
    if (delay === 30_000) {
      const id = nextTimerId++;
      closeTimers.set(id, () => callback(...args));
      return id;
    }
    return realSetTimeout(callback, delay, ...args);
  };
  globalThis.clearTimeout = (id) => {
    if (!closeTimers.delete(id)) realClearTimeout(id);
  };

  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    delete globalThis.chrome;
  });

  return {
    ...mock,
    async flushOffscreenCloseTimers() {
      const callbacks = [...closeTimers.values()];
      closeTimers.clear();
      for (const callback of callbacks) await callback();
    },
  };
}

function resource(name) {
  return {
    url: `https://assets.example.test/${name}.jpg`,
    title: name,
    ext: 'jpg',
    kind: 'image',
    size: 1024,
  };
}

async function waitForExecuteMessage(runtimeMessages, taskId) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 500) {
    const message = runtimeMessages.find(
      (item) => item.type === 'EXECUTE_TASK' && item.task?.id === taskId
    );
    if (message) return message;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  return null;
}

test('批量任务完成时不会关闭仍有普通任务使用的 offscreen', async (t) => {
  const mock = installHarness(t);
  const manager = await importFreshManager();

  const batch = await manager.startBatchDownload([resource('batch')], 'dir-key');
  assert.ok(await waitForExecuteMessage(mock.runtimeMessages, batch.taskId));
  await manager.executeWithHandle('ordinary-running', 'file-key', resource('ordinary'));

  await manager.handleTaskUpdate({ id: batch.taskId, status: 'done', completedAt: Date.now() });
  await mock.flushOffscreenCloseTimers();
  assert.equal(mock.offscreenCloseCalls.length, 0, '另一个任务仍活跃时不得关闭 offscreen');

  await manager.handleTaskUpdate({ id: 'ordinary-running', status: 'done', completedAt: Date.now() });
  await mock.flushOffscreenCloseTimers();
  assert.equal(mock.offscreenCloseCalls.length, 1, '全部任务终态后应正常关闭 offscreen');
});

test('取消一个任务并收到重复 canceled 上报不会关闭另一个活跃任务', async (t) => {
  const mock = installHarness(t);
  const manager = await importFreshManager();

  await manager.executeWithHandle('cancel-me', 'file-a', resource('cancel-me'));
  await manager.executeWithHandle('keep-running', 'file-b', resource('keep-running'));

  await manager.cancelTask('cancel-me');
  await manager.handleTaskUpdate({ id: 'cancel-me', status: 'canceled', completedAt: Date.now() });
  await manager.handleTaskUpdate({ id: 'cancel-me', status: 'canceled', completedAt: Date.now() });
  await mock.flushOffscreenCloseTimers();

  assert.equal(mock.offscreenCloseCalls.length, 0, '重复取消终态只能释放同一 taskId 一次');
  await manager.handleTaskUpdate({ id: 'keep-running', status: 'done', completedAt: Date.now() });
  await mock.flushOffscreenCloseTimers();
  assert.equal(mock.offscreenCloseCalls.length, 1);
});

test('同一 taskId 任意多次终态上报都是幂等的', async (t) => {
  const mock = installHarness(t);
  const manager = await importFreshManager();

  await manager.executeWithHandle('repeat-terminal', 'file-a', resource('repeat-terminal'));
  await manager.executeWithHandle('still-active', 'file-b', resource('still-active'));

  await Promise.all(Array.from({ length: 6 }, () => manager.handleTaskUpdate({
    id: 'repeat-terminal',
    status: 'done',
    completedAt: Date.now(),
  })));
  await mock.flushOffscreenCloseTimers();

  assert.equal(mock.offscreenCloseCalls.length, 0);
  await manager.handleTaskUpdate({ id: 'still-active', status: 'done', completedAt: Date.now() });
  await mock.flushOffscreenCloseTimers();
  assert.equal(mock.offscreenCloseCalls.length, 1);
});

test('两个任务并发上报终态时两条 done 都会落库', async (t) => {
  const mock = installHarness(t, [
    { id: 'task-a', status: 'downloading', downloaded: 10 },
    { id: 'task-b', status: 'downloading', downloaded: 20 },
  ]);
  const manager = await importFreshManager();

  await Promise.all([
    manager.handleTaskUpdate({ id: 'task-a', status: 'done', completedAt: 1 }),
    manager.handleTaskUpdate({ id: 'task-b', status: 'done', completedAt: 2 }),
  ]);

  assert.equal(mock.storage.webgrab_tasks.find((task) => task.id === 'task-a')?.status, 'done');
  assert.equal(mock.storage.webgrab_tasks.find((task) => task.id === 'task-b')?.status, 'done');
});

test('高频进度更新与新任务建档并发时不会丢掉整条任务', async (t) => {
  const mock = installHarness(t, [
    { id: 'progress-task', status: 'downloading', downloaded: 0 },
  ]);
  const manager = await importFreshManager();

  await Promise.all([
    manager.handleTaskUpdate({ id: 'new-task', status: 'pending', downloaded: 0 }),
    ...Array.from({ length: 20 }, (_, index) => manager.handleTaskUpdate({
      id: 'progress-task',
      status: 'downloading',
      downloaded: index + 1,
    })),
  ]);

  assert.ok(mock.storage.webgrab_tasks.some((task) => task.id === 'new-task'));
  assert.ok(mock.storage.webgrab_tasks.some((task) => task.id === 'progress-task'));
  assert.equal(mock.storage.webgrab_tasks.find((task) => task.id === 'progress-task')?.downloaded, 20);
});
