import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  acquire,
  getActiveCount,
  release,
} from '../background/dnr-manager.js';
import {
  handleTaskUpdate,
  startBatchDownload,
  startComicPackage,
  startEpubPackage,
} from '../background/download-manager.js';

const realSetTimeout = globalThis.setTimeout;

function createChromeMock() {
  const rules = new Map();
  const dnrUpdates = [];
  const runtimeMessages = [];
  const events = [];
  const storage = {};

  return {
    chromeMock: {
      runtime: {
        lastError: null,
        async getContexts() {
          return [{ contextType: 'OFFSCREEN_DOCUMENT' }];
        },
        async sendMessage(message) {
          runtimeMessages.push(structuredClone(message));
          events.push({ type: 'message', messageType: message.type });
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
            events.push({ type: 'storage:set' });
          },
        },
      },
      declarativeNetRequest: {
        async updateSessionRules(update) {
          dnrUpdates.push(structuredClone(update));
          for (const rule of update.addRules || []) {
            rules.set(rule.id, rule);
            events.push({ type: 'dnr:add', ruleId: rule.id });
          }
          for (const id of update.removeRuleIds || []) {
            rules.delete(id);
            events.push({ type: 'dnr:remove', ruleId: id });
          }
        },
        async getSessionRules() {
          return [...rules.values()];
        },
      },
    },
    rules,
    dnrUpdates,
    runtimeMessages,
    events,
    storage,
  };
}

async function waitForExecuteTask(mock, timeoutMs = 500) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const message = mock.runtimeMessages.find((item) => item.type === 'EXECUTE_TASK');
    if (message) return message;
    await new Promise((resolve) => realSetTimeout(resolve, 5));
  }
  return null;
}

test('同一 taskId 的多条 DNR 规则可一次性完整回收', async (t) => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  t.after(() => {
    delete globalThis.chrome;
  });

  await acquire('batch_multi_rule', {
    domains: ['cdn-a.example.test'],
    headers: { Referer: 'https://page-a.example.test/' },
  });
  await acquire('batch_multi_rule', {
    domains: ['cdn-b.example.test'],
    headers: { Referer: 'https://page-b.example.test/' },
  });

  assert.equal(mock.rules.size, 2);
  assert.equal(getActiveCount(), 1, '活跃计数继续按任务数计算，保持向后兼容');

  await release('batch_multi_rule');

  assert.equal(mock.rules.size, 0);
  assert.deepEqual(
    mock.dnrUpdates.at(-1).removeRuleIds.slice().sort((a, b) => a - b),
    [1000, 1001]
  );
  assert.equal(getActiveCount(), 0);
});

test('批量任务按 headers 分组并在派发 offscreen 前主动注册 DNR', async (t) => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 30_000 ? 1 : delay, ...args);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  const resources = [
    {
      url: 'https://cdn-a.dm5.test/1.jpg',
      pageUrl: 'https://www.dm5.com/chapter-a/',
      kind: 'image',
      ext: 'jpg',
      size: 100,
      title: '1',
    },
    {
      url: 'https://cdn-b.dm5.test/2.jpg',
      pageUrl: 'https://www.dm5.com/chapter-a/',
      kind: 'image',
      ext: 'jpg',
      size: 200,
      title: '2',
    },
    {
      url: 'https://cdn-c.dm5.test/3.jpg',
      pageUrl: 'https://www.dm5.com/chapter-b/',
      kind: 'image',
      ext: 'jpg',
      size: 300,
      title: '3',
    },
  ];

  const result = await startBatchDownload(resources, 'dir-handle-key');
  const executeMessage = await waitForExecuteTask(mock);

  assert.ok(executeMessage, '批量任务必须派发给 offscreen');
  assert.equal(executeMessage.task.id, result.taskId);
  assert.equal(mock.rules.size, 2, '两个 headers 分组应产生两条 DNR 规则');

  const rules = [...mock.rules.values()];
  const chapterARule = rules.find((rule) =>
    rule.action.requestHeaders.some(
      (header) => header.header === 'Referer' && header.value === 'https://www.dm5.com/chapter-a/'
    )
  );
  const chapterBRule = rules.find((rule) =>
    rule.action.requestHeaders.some(
      (header) => header.header === 'Referer' && header.value === 'https://www.dm5.com/chapter-b/'
    )
  );
  assert.deepEqual(chapterARule.condition.requestDomains.slice().sort(), [
    'cdn-a.dm5.test',
    'cdn-b.dm5.test',
  ]);
  assert.deepEqual(chapterBRule.condition.requestDomains, ['cdn-c.dm5.test']);
  assert.deepEqual(chapterARule.condition.resourceTypes, ['xmlhttprequest']);

  const messageIndex = mock.events.findIndex((event) => event.type === 'message');
  const taskPersistIndex = mock.events.findIndex((event) => event.type === 'storage:set');
  const addIndexes = mock.events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => event.type === 'dnr:add')
    .map(({ index }) => index);
  assert.ok(addIndexes.every((index) => index < messageIndex), '所有 DNR 必须先于 EXECUTE_TASK 注册');
  assert.ok(addIndexes.every((index) => index < taskPersistIndex), '所有 DNR 必须先于批量任务持久化');

  await handleTaskUpdate({
    id: result.taskId,
    status: 'done',
    downloaded: 3,
    total: 3,
    completedAt: Date.now(),
  });

  assert.equal(mock.rules.size, 0);
  assert.equal(getActiveCount(), 0);
});

test('无 pageUrl 的普通批量任务不注册多余 DNR', async (t) => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 30_000 ? 1 : delay, ...args);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  const result = await startBatchDownload(
    [
      {
        url: 'https://images.example.test/1.jpg',
        pageUrl: '',
        kind: 'image',
        ext: 'jpg',
        size: 100,
        title: '1',
      },
    ],
    'dir-handle-key'
  );
  const executeMessage = await waitForExecuteTask(mock);

  assert.ok(executeMessage);
  assert.equal(mock.rules.size, 0);
  assert.equal(mock.dnrUpdates.length, 0);

  await handleTaskUpdate({ id: result.taskId, status: 'done', completedAt: Date.now() });
});

test('漫画打包同样在 offscreen fetch 前注册 DNR，并在终态完整回收', async (t) => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  t.after(() => { delete globalThis.chrome; });

  const result = await startComicPackage({
    resources: [{
      url: 'https://cdn.dm5.test/page.jpg',
      pageUrl: 'https://www.dm5.com/chapter/',
      kind: 'image', ext: 'jpg', title: 'page.jpg', domIndex: 0,
    }],
    dirHandleKey: 'comic-dir',
    mode: 'both',
    title: '章节',
    source: 'https://www.dm5.com/chapter/',
  });
  const executeMessage = await waitForExecuteTask(mock);
  assert.equal(executeMessage.task.streamMeta.kind, 'comic-package');
  assert.equal(executeMessage.task.streamMeta.resources[0].domIndex, 0);
  assert.equal(mock.rules.size, 1);

  await handleTaskUpdate({ id: result.taskId, status: 'done', completedAt: Date.now() });
  assert.equal(mock.rules.size, 0);
});

test('EPUB 任务只向 offscreen 传 bookId 和文件句柄 key，不携带章节正文', async (t) => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  t.after(() => { delete globalThis.chrome; });

  await startEpubPackage({
    bookId: 'book-20',
    fileHandleKey: 'epub-file',
    title: '小说',
    source: 'https://book.test/',
    chapterCount: 20,
  });
  const executeMessage = await waitForExecuteTask(mock);
  assert.equal(executeMessage.task.streamMeta.kind, 'epub-package');
  assert.deepEqual(executeMessage.task.streamMeta, { kind: 'epub-package', bookId: 'book-20' });
  assert.equal(executeMessage.task.fileHandleKey, 'epub-file');
  assert.equal(JSON.stringify(executeMessage).includes('chapters'), false);

  await handleTaskUpdate({ id: executeMessage.task.id, status: 'done', completedAt: Date.now() });
});

test('popup 批量资源透传资源 pageUrl，并以当前页作为兜底', async () => {
  const source = await readFile(new URL('../ui/popup.js', import.meta.url), 'utf8');
  assert.match(source, /pageUrl:\s*r\.pageUrl\s*\|\|\s*currentPageUrl\s*\|\|\s*['"]['"]/);
});

test('offscreen 上报的 diagnostics 会原样持久化到 chrome.storage.local', async (t) => {
  const mock = createChromeMock();
  globalThis.chrome = mock.chromeMock;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 30_000 ? 1 : delay, ...args);
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  const diagnostics = [
    {
      url: 'https://cdn.example.test/a.jpg',
      fileName: 'a.jpg',
      stage: 'fetch',
      errName: 'TypeError',
      errMessage: 'Failed to fetch',
      httpStatus: null,
    },
  ];

  await handleTaskUpdate({
    id: 'batch_diagnostics_storage',
    status: 'failed',
    diagnostics,
    completedAt: Date.now(),
  });

  const storedTask = mock.storage.webgrab_tasks.find(
    (task) => task.id === 'batch_diagnostics_storage'
  );
  assert.deepEqual(storedTask.diagnostics, diagnostics);
});
