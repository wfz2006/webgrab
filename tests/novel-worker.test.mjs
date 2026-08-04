import test from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/novel-heuristics.js');
const { executeNovelTask, fetchStaticDocument } = await import('../offscreen/novel-worker.js');

function makeStore(book) {
  const events = [];
  const chapters = [];
  return {
    events,
    chapters,
    async getBook() { return structuredClone(book); },
    async markExtracting(id) { events.push(['extracting', id]); },
    async setCurrentChapter(_id, index) { events.push(['current', index]); },
    async recordChapterSuccess(_id, chapter) {
      chapters.push(structuredClone(chapter));
      events.push(['success', chapter.index]);
    },
    async recordChapterFailure(_id, chapter, error) {
      events.push(['failure', chapter.index, error.message]);
    },
    async markBookTerminal(_id, status) { events.push(['terminal', status]); },
  };
}

test('全本任务严格串行、每章等待 300–800ms，失败后继续', async () => {
  const book = {
    id: 'book-1',
    catalogUrl: 'https://novel.example/book/1/',
    plannedCount: 3,
    plan: [0, 1, 2].map((index) => ({
      index,
      title: `第${index + 1}章`,
      url: `https://novel.example/book/1/${index + 1}.html`,
    })),
  };
  const store = makeStore(book);
  const delays = [];
  let active = 0;
  let maxActive = 0;
  const task = { streamMeta: { kind: 'novel', bookId: book.id } };

  await executeNovelTask(task, {
    store,
    random: () => 0.5,
    delay: async (ms) => { delays.push(ms); },
    fetchDocument: async (url) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active -= 1;
      if (url.endsWith('/2.html')) throw new Error('HTTP 524');
      return { document: {}, finalUrl: url };
    },
    extractChapter: (_document, url) => ({
      title: `正文 ${url}`,
      html: '<p>正文</p>',
      text: '正文'.repeat(60),
    }),
  });

  assert.equal(maxActive, 1);
  assert.deepEqual(delays, [550, 550, 550]);
  assert.equal(task.status, 'done', JSON.stringify(store.events));
  assert.equal(task.successCount, 2);
  assert.equal(task.failureCount, 1);
  assert.deepEqual(
    store.events.filter((event) => ['success', 'failure'].includes(event[0])).map((event) => event.slice(0, 2)),
    [['success', 0], ['failure', 1], ['success', 2]]
  );
  assert.deepEqual(store.events.at(-1), ['terminal', 'done']);
});

test('同一章三个物理页串行延迟抓取后拼成一章再落库', async () => {
  const book = {
    id: 'book-paged',
    catalogUrl: 'https://novel.example/book/',
    plannedCount: 1,
    plan: [{ index: 0, title: '第一章', url: 'https://novel.example/book/943662.html' }],
  };
  const store = makeStore(book);
  const fetches = [];
  const delays = [];
  const pages = {
    'https://novel.example/book/943662.html': {
      links: [{ href: '/book/943662_2.html', text: '下一章', order: 0 }],
      part: 1,
    },
    'https://novel.example/book/943662_2.html': {
      links: [{ href: '/book/943662_3.html', text: '下一章', order: 0 }],
      part: 2,
    },
    'https://novel.example/book/943662_3.html': {
      links: [{ href: '/book/943663.html', text: '下一章', order: 0 }],
      part: 3,
    },
  };
  const task = { streamMeta: { kind: 'novel', bookId: book.id } };
  await executeNovelTask(task, {
    store,
    random: () => 0.5,
    delay: async (ms) => { delays.push(ms); },
    projectLinks: (document) => document.links,
    fetchDocument: async (url) => {
      fetches.push(url);
      return { document: pages[url], finalUrl: url };
    },
    extractChapter: (document, url) => ({
      title: '页面标题',
      html: `<p>第${document.part}页正文</p>`,
      text: `第${document.part}页正文`.repeat(12),
      url,
      paragraphCount: 1,
    }),
  });

  assert.deepEqual(fetches, Object.keys(pages));
  assert.deepEqual(delays, [550, 550, 550]);
  assert.equal(store.chapters.length, 1, JSON.stringify(store.events));
  assert.match(store.chapters[0].html, /第1页正文[\s\S]*第2页正文[\s\S]*第3页正文/);
  assert.match(store.chapters[0].text, /第1页正文[\s\S]*第3页正文/);
  assert.equal(store.chapters[0].url, 'https://novel.example/book/943662.html');
  assert.equal(task.successCount, 1);
});

test('物理页硬上限停止后保存已拼内容，不继续请求也不算章节失败', async () => {
  const book = {
    id: 'book-page-cap',
    catalogUrl: 'https://novel.example/book/',
    plannedCount: 1,
    plan: [{ index: 0, title: '第一章', url: 'https://novel.example/book/943662.html' }],
  };
  const store = makeStore(book);
  const fetches = [];
  const task = { streamMeta: { kind: 'novel', bookId: book.id } };
  await executeNovelTask(task, {
    store,
    maxPhysicalPages: 2,
    delay: async () => {},
    projectLinks: (document) => document.links,
    fetchDocument: async (url) => {
      fetches.push(url);
      const pageNumber = url.includes('_2.') ? 2 : 1;
      return {
        finalUrl: url,
        document: {
          pageNumber,
          links: [{ href: `/book/943662_${pageNumber + 1}.html`, text: '下一章' }],
        },
      };
    },
    extractChapter: (document) => ({
      title: '第一章',
      html: `<p>${`第${document.pageNumber}页`.repeat(30)}</p>`,
      text: `第${document.pageNumber}页`.repeat(30),
      paragraphCount: 1,
    }),
  });

  assert.deepEqual(fetches, [
    'https://novel.example/book/943662.html',
    'https://novel.example/book/943662_2.html',
  ]);
  assert.equal(task.status, 'done', JSON.stringify(store.events));
  assert.equal(task.failureCount, 0);
  assert.equal(store.chapters.length, 1);
  assert.doesNotMatch(store.chapters[0].text, /第3页/);
});

test('取消能中止同章下一物理页之前的礼貌等待', async () => {
  const book = {
    id: 'book-page-cancel',
    catalogUrl: 'https://novel.example/book/',
    plannedCount: 1,
    plan: [{ index: 0, title: '第一章', url: 'https://novel.example/book/943662.html' }],
  };
  const store = makeStore(book);
  const task = { streamMeta: { kind: 'novel', bookId: book.id } };
  let delayCalls = 0;
  let markSecondDelayStarted;
  const secondDelayStarted = new Promise((resolve) => { markSecondDelayStarted = resolve; });
  const fetches = [];
  const running = executeNovelTask(task, {
    store,
    projectLinks: (document) => document.links,
    delay: async (_ms, signal) => {
      delayCalls++;
      if (delayCalls === 1) return;
      markSecondDelayStarted();
      await new Promise((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
      });
    },
    fetchDocument: async (url) => {
      fetches.push(url);
      return {
        finalUrl: url,
        document: { links: [{ href: '/book/943662_2.html', text: '下一章' }] },
      };
    },
    extractChapter: () => ({
      title: '第一章', html: `<p>${'正文'.repeat(60)}</p>`, text: '正文'.repeat(60), paragraphCount: 1,
    }),
  });
  await secondDelayStarted;
  task._abortController.abort();
  await running;

  assert.equal(task.status, 'canceled');
  assert.equal(delayCalls, 2);
  assert.deepEqual(fetches, ['https://novel.example/book/943662.html']);
  assert.equal(store.chapters.length, 0);
});

test('取消能中止礼貌等待并保留已落库计数语义', async () => {
  const book = {
    id: 'book-cancel',
    catalogUrl: 'https://novel.example/book/2/',
    plannedCount: 1,
    plan: [{ index: 0, title: '第一章', url: 'https://novel.example/book/2/1.html' }],
  };
  const store = makeStore(book);
  const task = { streamMeta: { kind: 'novel', bookId: book.id } };
  const running = executeNovelTask(task, {
    store,
    delay: (_ms, signal) => new Promise((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('已取消', 'AbortError')), { once: true });
    }),
  });
  await new Promise((resolve) => setImmediate(resolve));
  task._abortController.abort();
  await running;

  assert.equal(task.status, 'canceled');
  assert.equal(task.downloaded, 0);
  assert.deepEqual(store.events.at(-1), ['terminal', 'canceled']);
});

test('外域章节链接不访问，记录失败并继续', async () => {
  const book = {
    id: 'book-external',
    catalogUrl: 'https://novel.example/book/3/',
    plannedCount: 1,
    plan: [{ index: 0, title: '广告链接', url: 'https://ads.example/landing' }],
  };
  const store = makeStore(book);
  let fetched = false;
  const task = { streamMeta: { kind: 'novel', bookId: book.id } };
  await executeNovelTask(task, {
    store,
    delay: async () => {},
    fetchDocument: async () => { fetched = true; throw new Error('不应访问'); },
  });
  assert.equal(fetched, false);
  assert.equal(task.status, 'failed');
  assert.equal(task.failureCount, 1);
});

test('单章网络超时转成普通失败，不伪装成用户取消', async () => {
  const controller = new AbortController();
  const neverRespond = (_url, options) => new Promise((_resolve, reject) => {
    options.signal.addEventListener(
      'abort',
      () => reject(new DOMException('aborted', 'AbortError')),
      { once: true }
    );
  });
  await assert.rejects(
    fetchStaticDocument('https://novel.example/book/1.html', controller.signal, neverRespond, 10),
    /请求超时（0\.01 秒）/
  );
  assert.equal(controller.signal.aborted, false);
});
