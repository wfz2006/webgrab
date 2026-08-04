import assert from 'node:assert/strict';
import test from 'node:test';

const realSetTimeout = globalThis.setTimeout;
let importSequence = 0;

/**
 * 复现真实 chrome.offscreen 的关键约束：整个扩展同时只能存在一个 offscreen
 * document，创建又是有真实耗时的异步操作。第二次 createDocument（哪怕第一次
 * 还在创建中）会直接抛错，而不是排队等待。
 */
function createChromeMock() {
  const createCalls = [];
  const runtimeMessages = [];
  const storage = {};
  let documentState = 'none'; // none | creating | open

  const chromeMock = {
    runtime: {
      async getContexts() {
        // 创建完成前 getContexts 查不到这个文档。
        return documentState === 'open' ? [{ contextType: 'OFFSCREEN_DOCUMENT' }] : [];
      },
      async sendMessage(message) {
        runtimeMessages.push(structuredClone(message));
        return { ok: true };
      },
    },
    storage: {
      local: {
        // 不加人为延迟：任务落盘要尽快让出，好让几个并发任务在同一轮里
        // 都走到 ensureOffscreen，稳定复现"文档还在创建中就来第二个"的时序。
        async get(key) {
          return { [key]: structuredClone(storage[key]) };
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    offscreen: {
      async createDocument(options) {
        createCalls.push(structuredClone(options));
        if (documentState !== 'none') {
          throw new Error('Only a single offscreen document may be created.');
        }
        documentState = 'creating';
        await new Promise((resolve) => realSetTimeout(resolve, 15));
        documentState = 'open';
      },
      async closeDocument() {
        documentState = 'none';
      },
    },
    declarativeNetRequest: {
      async updateSessionRules() {},
      async getSessionRules() {
        return [];
      },
    },
  };

  return { chromeMock, createCalls, runtimeMessages, storage };
}

async function importFreshManager() {
  const url = new URL('../background/download-manager.js', import.meta.url);
  url.searchParams.set('offscreen-lifecycle-test', String(importSequence++));
  return import(url.href);
}

/**
 * @param {boolean} [shrinkReadyTimeout] 把 5 秒的"就绪超时兜底"压缩掉。
 *   只在不关心就绪时序的用例里开，避免每个用例白等 5 秒。
 */
function installHarness(t, shrinkReadyTimeout = true) {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  if (shrinkReadyTimeout) {
    globalThis.setTimeout = (callback, delay, ...args) =>
      realSetTimeout(callback, delay === 5000 ? 20 : delay === 30_000 ? 5 : delay, ...args);
  }
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });
  return mock;
}

test('并发 ensureOffscreen 只创建一个 offscreen document，全部调用方都正常返回', async (t) => {
  const mock = installHarness(t);
  const manager = await importFreshManager();

  const results = await Promise.allSettled([
    manager.ensureOffscreen(),
    manager.ensureOffscreen(),
    manager.ensureOffscreen(),
  ]);

  const rejected = results.filter((result) => result.status === 'rejected');
  assert.deepEqual(
    rejected.map((result) => result.reason?.message),
    [],
    '并发调用不能因为"只能创建一个 offscreen document"而失败'
  );
  assert.equal(
    mock.createCalls.length,
    1,
    `chrome.offscreen.createDocument 只能被调用一次，实际 ${mock.createCalls.length} 次`
  );
});

test('同时开始的多个 offscreen 下载任务全部派发成功，没有任务因创建竞态被判失败', async (t) => {
  const mock = installHarness(t);
  const manager = await importFreshManager();

  // 用户在列表里连点两个视频：popup 依次发 START_DOWNLOAD，SW 每次都会
  // 异步走 executeWithHandle → dispatchOffscreenTask → ensureOffscreen，
  // 第一个还没建好文档时第二个就进来了。
  await Promise.all(
    ['task-a', 'task-b', 'task-c'].map((taskId) =>
      manager.executeWithHandle(taskId, null, {
        url: `https://cdn.example.test/${taskId}.mp4`,
        title: taskId,
        ext: 'mp4',
        kind: 'video',
        size: 120 * 1024 * 1024,
      })
    )
  );

  const dispatched = mock.runtimeMessages.filter((message) => message.type === 'EXECUTE_TASK');
  assert.equal(dispatched.length, 3, '三个任务都必须真正派发到 offscreen');

  const failed = (mock.storage.webgrab_tasks || []).filter((task) => task.status === 'failed');
  assert.deepEqual(
    failed.map((task) => `${task.id}: ${task.error}`),
    [],
    '不能有任务因为 offscreen 创建竞态被标记为失败'
  );
});

test('offscreen 就绪通知早于 createDocument 返回时也能立即解除等待，不空等 5 秒超时', async (t) => {
  // 这个用例要区分"被就绪通知唤醒"和"被超时兜底唤醒"，必须保留真实的 5 秒超时。
  const mock = installHarness(t, false);
  const manager = await importFreshManager();

  // 真实环境里 offscreen 文档加载很快，OFFSCREEN_READY 完全可能在
  // createDocument 的 Promise resolve 之前就送达 SW。
  let readyDelivered = false;
  const originalCreate = mock.chromeMock.offscreen.createDocument;
  mock.chromeMock.offscreen.createDocument = async function (options) {
    realSetTimeout(() => {
      readyDelivered = true;
      manager.handleOffscreenReady();
    }, 1);
    return originalCreate.call(this, options);
  };

  const startedAt = Date.now();
  await manager.ensureOffscreen();
  const elapsed = Date.now() - startedAt;

  assert.equal(readyDelivered, true, '测试前提：就绪通知必须在等待期间送达');
  assert.ok(
    elapsed < 1000,
    `就绪通知已送达就不该继续等超时兜底，实际等了 ${elapsed}ms`
  );
});
