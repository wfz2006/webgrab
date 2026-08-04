import test from 'node:test';
import assert from 'node:assert/strict';

import {
  handleTaskUpdate,
  startDownload,
  startDownloadAndWait,
} from '../background/download-manager.js';
import { getActiveCount } from '../background/dnr-manager.js';
import { BilibiliAdapter } from '../adapters/bilibili.js';

const realSetTimeout = globalThis.setTimeout;

function createChromeMock(outcomes) {
  const listeners = new Set();
  const downloads = new Map();
  const attempts = [];
  const dnrRules = new Map();
  const dnrUpdates = [];
  const runtimeMessages = [];
  const storage = {};
  let nextDownloadId = 1;

  const chromeMock = {
    runtime: {
      lastError: null,
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
          return { [key]: storage[key] };
        },
        async set(values) {
          Object.assign(storage, structuredClone(values));
        },
      },
    },
    downloads: {
      onChanged: {
        addListener(listener) {
          listeners.add(listener);
        },
        removeListener(listener) {
          listeners.delete(listener);
        },
      },
      download(options, callback) {
        const id = nextDownloadId++;
        const outcome = outcomes[attempts.length];
        attempts.push({ id, options });
        downloads.set(id, {
          id,
          state: outcome.state,
          error: outcome.error,
        });

        // 精确复现 Chrome 的最坏时序：终态事件已经发出，download() 回调才返回 ID。
        for (const listener of [...listeners]) {
          listener({ id, state: { current: outcome.state } });
        }
        callback(id);
      },
      search(query, callback) {
        const item = downloads.get(query.id);
        const result = item ? [item] : [];
        if (callback) callback(result);
        return Promise.resolve(result);
      },
      async cancel() {},
      async erase(query) {
        downloads.delete(query.id);
        return [query.id];
      },
    },
    declarativeNetRequest: {
      async updateSessionRules(update) {
        dnrUpdates.push(structuredClone(update));
        for (const rule of update.addRules || []) dnrRules.set(rule.id, rule);
        for (const id of update.removeRuleIds || []) dnrRules.delete(id);
      },
      async getSessionRules() {
        return [...dnrRules.values()];
      },
    },
  };

  return {
    chromeMock,
    storage,
    attempts,
    dnrRules,
    dnrUpdates,
    runtimeMessages,
    listeners,
  };
}

async function waitForTaskTerminal(storage, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const task = storage.webgrab_tasks?.[0];
    if (task?.status === 'done' || task?.status === 'failed') return task;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  return storage.webgrab_tasks?.[0];
}

test('瞬时 SERVER_FORBIDDEN 会改走 offscreen/fetch 且不再调用第二次 chrome.downloads', async (t) => {
  const mock = createChromeMock([{ state: 'interrupted', error: 'SERVER_FORBIDDEN' }]);
  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay >= 300_000 ? 30 : delay === 30_000 ? 1 : delay, ...args);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  await startDownload(
    {
      url: 'https://manhua.example-cdn.test/chapter/1.jpg',
      pageUrl: 'https://www.dm5.com/m12345/',
      title: '1',
      ext: 'jpg',
      kind: 'image',
      size: -1,
    },
    null
  );

  const startedAt = Date.now();
  while (
    !mock.runtimeMessages.some((message) => message.type === 'EXECUTE_TASK') &&
    Date.now() - startedAt < 500
  ) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }

  const executeMessage = mock.runtimeMessages.find((message) => message.type === 'EXECUTE_TASK');
  assert.equal(mock.attempts.length, 1, '防盗链 fallback 禁止再调 chrome.downloads.download()');
  assert.ok(executeMessage, '必须向 offscreen 派发 EXECUTE_TASK');
  assert.equal(executeMessage.task.url, 'https://manhua.example-cdn.test/chapter/1.jpg');
  assert.equal(executeMessage.task.fileHandleKey, null);
  assert.deepEqual(executeMessage.task.headers, {});
  assert.equal(mock.dnrUpdates.filter((update) => update.addRules).length, 1);
  assert.deepEqual(
    mock.dnrUpdates.find((update) => update.addRules).addRules[0].condition.resourceTypes,
    ['xmlhttprequest']
  );
  assert.equal(mock.dnrRules.size, 1, 'offscreen 终态前 DNR 必须保持生效');

  await handleTaskUpdate({
    id: executeMessage.task.id,
    status: 'done',
    downloaded: 154_917,
    total: 154_917,
    completedAt: Date.now(),
  });

  const task = mock.storage.webgrab_tasks?.find((item) => item.id === executeMessage.task.id);
  assert.equal(task?.status, 'done');
  assert.equal(task?.downloaded, 154_917);
  assert.equal(mock.dnrUpdates.filter((update) => update.removeRuleIds).length, 1);
  assert.equal(mock.dnrRules.size, 0, 'offscreen 终态后 DNR 必须回收');
  assert.equal(getActiveCount(), 0);
});

test('无防盗链下载即使在回调前完成也只下载一次并标记 done', async (t) => {
  const mock = createChromeMock([{ state: 'complete' }]);
  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay >= 300_000 ? 30 : delay, ...args);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  await startDownload(
    {
      url: 'https://images.example.test/chapter/1.jpg',
      pageUrl: 'https://haoduoman.example.test/chapter/1',
      title: '1',
      ext: 'jpg',
      kind: 'image',
      size: -1,
    },
    null
  );

  const task = await waitForTaskTerminal(mock.storage);

  assert.equal(mock.attempts.length, 1);
  assert.equal(task?.status, 'done');
  assert.equal(mock.dnrUpdates.length, 0);
});

test('HLS 清单无文件句柄时仍强制走 offscreen 合并，并以 MP4 文件名落盘', async (t) => {
  const mock = createChromeMock([]);
  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 30_000 ? 1 : delay, ...args);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  const result = await startDownload(
    {
      url: 'https://hls.example.test/movie/master.m3u8?token=short-lived',
      pageUrl: 'https://example.test/article/1',
      title: 'movie.m3u8',
      ext: 'm3u8',
      kind: 'stream',
      size: -1,
      organizedPath: 'WebGrab/视频/example/movie.m3u8',
    },
    null
  );

  const startedAt = Date.now();
  while (
    !mock.runtimeMessages.some((message) => message.type === 'EXECUTE_TASK') &&
    Date.now() - startedAt < 500
  ) {
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }

  const executeMessage = mock.runtimeMessages.find((message) => message.type === 'EXECUTE_TASK');
  assert.equal(result.method, 'offscreen');
  assert.equal(mock.attempts.length, 0, '清单 URL 不能交给 chrome.downloads 直接保存');
  assert.ok(executeMessage, '必须向 offscreen 派发 HLS 合并任务');
  assert.equal(executeMessage.task.streamType, 'hls');
  assert.equal(executeMessage.task.fileName, 'WebGrab/视频/example/movie.mp4');

  await handleTaskUpdate({
    id: executeMessage.task.id,
    status: 'done',
    downloaded: 101,
    total: 101,
    completedAt: Date.now(),
  });
});

test('BilibiliAdapter 继续忽略 pageUrl 并返回固定请求头', () => {
  const adapter = new BilibiliAdapter();
  assert.deepEqual(
    adapter.requiredHeaders(
      'https://upos-sz-mirror.example.test/video.m4s',
      'https://attacker.example.test/'
    ),
    {
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
    }
  );
});

test('超时时 search 返回 in_progress 不会覆盖 timeout 终态', async (t) => {
  const mock = createChromeMock([{ state: 'in_progress' }]);
  globalThis.chrome = mock.chromeMock;
  t.after(() => {
    delete globalThis.chrome;
  });

  const attempt = startDownloadAndWait(
    {
      url: 'https://images.example.test/slow.jpg',
      filename: 'slow.jpg',
      saveAs: false,
    },
    15
  );
  const result = await attempt.completion;

  assert.equal(result.state, 'timeout');
  assert.equal(mock.listeners.size, 0);
});
