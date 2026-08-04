import test from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/novel-heuristics.js');
const { prepareNovelExtraction } = await import('../offscreen/novel-worker.js');

function makeStore() {
  const created = [];
  return {
    created,
    async createPreparedBook(input) {
      const book = { id: 'book-1', status: 'prepared', ...input };
      created.push(book);
      return book;
    },
  };
}

function makeChapters(count, prefix = '/chapter/42/') {
  return Array.from({ length: count }, (_, i) => ({
    index: i,
    title: `第${i + 1}章：这是一个标题`,
    url: `https://read.example.test${prefix}${i + 1}.html`,
  }));
}

test('阅读页自带选章列表时，准备阶段直接信任传入结果，完全不发起 fetch', async () => {
  const store = makeStore();
  let fetchCalled = false;

  const result = await prepareNovelExtraction(
    {
      source: 'https://read.example.test/chapter/42/1.html',
      catalogUrl: 'https://read.example.test/chapter/42/1.html',
      pageTitle: '测试小说标题',
      catalogChapters: makeChapters(20),
    },
    {
      store,
      fetchDocument: async () => {
        fetchCalled = true;
        throw new Error('不该被调用');
      },
    }
  );

  assert.equal(fetchCalled, false, '有预识别的章节列表时不该再重新抓取目录页');
  assert.equal(store.created[0].title, '测试小说标题');
  assert.equal(store.created[0].catalogUrl, 'https://read.example.test/chapter/42/1.html');
  assert.equal(store.created[0].plan.length, 20);
  assert.equal(store.created[0].detectedCount, 20);
  assert.equal(result.id, 'book-1');
});

test('没有预识别章节列表时，维持原有行为——照常抓取目录页静态 HTML', async () => {
  const store = makeStore();
  let fetchCalled = false;

  // 这里的重点只是证明 fetchDocument 真的被调用了（走了原有的静态抓取路径），
  // 不是复现 identifyChapterList 的完整解析逻辑，所以给一个不含任何链接的最小
  // fake document 即可——自然会因为找不到 10 条章节链接而失败，这本身就是预期行为。
  await assert.rejects(
    () =>
      prepareNovelExtraction(
        {
          source: 'https://novel.example.test/book/1/',
          catalogUrl: 'https://novel.example.test/book/1/catalog.html',
          pageTitle: '兜底标题',
        },
        {
          store,
          fetchDocument: async (url) => {
            fetchCalled = true;
            const document = {
              title: '真实目录页标题',
              querySelector: () => null,
              querySelectorAll: () => [],
            };
            return { document, finalUrl: url };
          },
        }
      ),
    /未识别到至少 10 章的目录列表/
  );

  assert.equal(fetchCalled, true, '没有预识别列表时必须照常抓取目录页');
});

test('预识别列表不足十条时（理论上不该发生）安全回退到重新抓取，而不是直接用不合格数据建档', async () => {
  const store = makeStore();
  let fetchCalled = false;

  await assert.rejects(
    () =>
      prepareNovelExtraction(
        {
          source: 'https://novel.example.test/book/1/',
          catalogUrl: 'https://novel.example.test/book/1/catalog.html',
          catalogChapters: makeChapters(3), // 不足 10 条
        },
        {
          store,
          fetchDocument: async (url) => {
            fetchCalled = true;
            const document = { title: '目录页', querySelector: () => null };
            return { document, finalUrl: url };
          },
        }
      ),
    /未识别到至少 10 章的目录列表/
  );

  assert.equal(fetchCalled, true, '预识别列表不满足最低条数时应该回退到重新抓取而不是直接采信');
});
