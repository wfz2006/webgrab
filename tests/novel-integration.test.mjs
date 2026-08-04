import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  handleTaskUpdate,
  startNovelExtraction,
} from '../background/download-manager.js';

test('全局只允许一个全本任务，持久化任务不携带正文或章节计划', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (callback, delay, ...args) =>
    realSetTimeout(callback, delay === 30_000 ? 1 : delay, ...args);
  const storage = {};
  const messages = [];
  globalThis.chrome = {
    runtime: {
      async getContexts() { return [{ contextType: 'OFFSCREEN_DOCUMENT' }]; },
      async sendMessage(message) { messages.push(structuredClone(message)); return { ok: true }; },
    },
    storage: {
      local: {
        async get(key) { return { [key]: storage[key] }; },
        async set(value) { Object.assign(storage, structuredClone(value)); },
      },
    },
    declarativeNetRequest: {
      async getSessionRules() { return []; },
      async updateSessionRules() {},
    },
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    delete globalThis.chrome;
  });

  const starts = await Promise.allSettled([
    startNovelExtraction({
      id: 'book-1',
      title: '测试小说',
      source: 'https://novel.example/book/1.html',
      plannedCount: 20,
      plan: [{ index: 0, html: '<p>绝不能进任务存储</p>' }],
    }),
    startNovelExtraction({
      id: 'book-2',
      title: '第二本',
      source: 'https://novel.example/book/2.html',
      plannedCount: 10,
    }),
  ]);
  assert.deepEqual(starts.map((result) => result.status), ['fulfilled', 'rejected']);
  assert.match(starts[1].reason.message, /已有一本小说正在提取/);
  const first = starts[0].value;

  const stored = storage.webgrab_tasks[0];
  assert.equal(stored.kind, 'novel');
  assert.deepEqual(stored.streamMeta, { kind: 'novel', bookId: 'book-1' });
  assert.equal('plan' in stored, false);
  assert.equal(JSON.stringify(stored).includes('绝不能进任务存储'), false);
  assert.equal(messages.filter((message) => message.type === 'EXECUTE_TASK').length, 1);

  await handleTaskUpdate({ ...stored, id: first.taskId, status: 'done', completedAt: Date.now() });
});

test('popup 文案、恢复和进度契约符合 P4-1 决策', async () => {
  const [html, js] = await Promise.all([
    readFile(new URL('../ui/popup.html', import.meta.url), 'utf8'),
    readFile(new URL('../ui/popup.js', import.meta.url), 'utf8'),
  ]);
  const combined = `${html}\n${js}`;
  assert.match(html, />文本</);
  assert.match(html, />提取本章</);
  assert.match(html, />提取全本</);
  assert.doesNotMatch(combined, /下载全本/);
  assert.match(combined, /500 章是硬上限/);
  assert.match(combined, /不含网络响应时间/);
  assert.match(combined, /外域链接跳过/);
  assert.match(combined, /成功.*失败/s);
  assert.match(combined, /取消提取/);
  assert.match(combined, /P4-1 不生成文件/);
  assert.match(combined, /检测到本章还有更多分页未提取，仅显示当前页内容/);
  assert.match(js, /NOVEL_GET_BOOK_STATUS/);
  assert.match(js, /webgrab_novel_prepared_book_id/);
});

test('Readability 固定本地版本并保留 Apache-2.0 声明', async () => {
  const [manifestText, html, source, notices] = await Promise.all([
    readFile(new URL('../manifest.json', import.meta.url), 'utf8'),
    readFile(new URL('../offscreen/downloader.html', import.meta.url), 'utf8'),
    readFile(new URL('../lib/readability.js', import.meta.url), 'utf8'),
    readFile(new URL('../THIRD_PARTY_NOTICES.md', import.meta.url), 'utf8'),
  ]);
  const manifest = JSON.parse(manifestText);
  assert.match(html, /\.\.\/lib\/readability\.js/);
  assert.match(source.slice(0, 800), /Apache License, Version 2\.0/);
  assert.match(notices, /0\.6\.0/);
  assert.match(notices, /34DCAB3D0832D0019F02990EED6B6124E029E8C32B9F0C6F2550544FF8DFF174/);
  assert.doesNotMatch(JSON.stringify(manifest), /https?:\/\/.*readability/i);
});

test('核心小说代码不含站点域名硬编码', async () => {
  const files = [
    '../lib/novel-heuristics.js',
    '../lib/novel-extractor.js',
    '../offscreen/novel-worker.js',
    '../background/novel-manager.js',
  ];
  const source = (await Promise.all(files.map((file) => readFile(new URL(file, import.meta.url), 'utf8')))).join('\n');
  assert.doesNotMatch(source, /biqukong\.com|bqgnovels\.com|dm5\.com|haoduoman\.com/i);
});

test('offscreen 不抢答没有 target 的 popup 到 SW 消息', async () => {
  const source = await readFile(new URL('../offscreen/queue.js', import.meta.url), 'utf8');
  assert.match(source, /message\.target !== 'offscreen'/);
  assert.doesNotMatch(source, /message\.target && message\.target !== 'offscreen'/);
});
