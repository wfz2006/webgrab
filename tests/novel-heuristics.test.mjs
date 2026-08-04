import test from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/novel-heuristics.js');
const H = globalThis.WebGrabNovelHeuristics;

function chapterLinks(count, origin = 'https://novel.example') {
  return Array.from({ length: count }, (_, index) => ({
    href: `${origin}/book/42/${index + 1}.html`,
    text: `第${index + 1}章 这是章节标题`,
    order: index,
    containerKey: 'main>dl:nth-of-type(1)',
  }));
}

test('明确目录文字优先于父路径回退', () => {
  const result = H.findCatalogCandidate({
    pageUrl: 'https://novel.example/book/42/3.html',
    links: [
      { href: '/book/42/', text: '作品页', order: 0 },
      { href: '/book/42/catalog.html', text: '返回目录', order: 1 },
    ],
  });
  assert.equal(result.url, 'https://novel.example/book/42/catalog.html');
  assert.equal(result.reason, 'explicit-text');
});

test('页面没有目录文字或真实父路径链接时不猜目录 URL', () => {
  const result = H.findCatalogCandidate({
    pageUrl: 'https://novel.example/book/42/3.html',
    links: [{ href: '/unrelated/', text: '首页', order: 0 }],
  });
  assert.equal(result, null);
});

test('章节列表要求同源 HTTP(S)、至少十条并保持 DOM 顺序', () => {
  const links = chapterLinks(12);
  links.splice(4, 0, {
    href: 'https://ads.example/jump',
    text: '第999章 广告导流',
    order: 4.5,
    containerKey: 'main>dl:nth-of-type(1)',
  });
  const result = H.identifyChapterList(links, 'https://novel.example/book/42/');
  assert.equal(result.chapters.length, 12);
  assert.deepEqual(result.chapters.map((item) => item.index), [...Array(12).keys()]);
  assert.equal(result.skippedExternalCount, 1);
  assert.equal(result.skippedExternal[0].url, 'https://ads.example/jump');
});

test('不足十条或标题长度分布离散的链接组不算章节列表', () => {
  assert.equal(
    H.identifyChapterList(chapterLinks(9), 'https://novel.example/book/42/').chapters.length,
    0
  );
  const noisy = chapterLinks(10).map((item, index) => ({
    ...item,
    text: index < 6 ? '章' : '极其冗长且完全不像章节标题的推广链接'.repeat(8),
  }));
  assert.equal(
    H.identifyChapterList(noisy, 'https://novel.example/book/42/').chapters.length,
    0
  );
});

test('只共享网站根路径的导航链接不是章节列表', () => {
  const navigation = Array.from({ length: 12 }, (_, index) => ({
    href: `https://novel.example/category-${index}.html`,
    text: `分类频道${index}`,
    order: index,
    containerKey: 'body',
  }));
  assert.equal(
    H.identifyChapterList(navigation, 'https://novel.example/current.html').chapters.length,
    0
  );
});

test('500 章为硬上限且估时只计算礼貌等待', () => {
  const plan = H.capChapterPlan(chapterLinks(620), 500);
  assert.equal(plan.detectedCount, 620);
  assert.equal(plan.plannedCount, 500);
  assert.equal(plan.truncated, true);
  assert.deepEqual(plan.estimatedDelayMinutes, { min: 2.5, max: 6.7 });
});

test('同章分页只按 URL 的 _数字 后缀识别，不依赖错误的链接文字', () => {
  const current = 'https://novel.example/book/943662.html';
  const next = H.findNextChapterPage({
    pageUrl: current,
    links: [
      { href: '/book/943663.html', text: '下一页', order: 0 },
      { href: '/book/943662_2.html', text: '下一章', order: 1 },
    ],
  });
  assert.deepEqual(next, {
    url: 'https://novel.example/book/943662_2.html',
    pageNumber: 2,
    order: 1,
  });
});

test('分页候选必须与当前页归一化 URL 完全一致，并跳过已访问页防循环', () => {
  const pageUrl = 'https://novel.example/book/943662_2.html';
  const links = [
    { href: '/book/943662.html', text: '上一章', order: 0 },
    { href: '/book/943662_2.html', text: '当前页', order: 1 },
    { href: '/book/943662_3.html', text: '任意错误文字', order: 2 },
    { href: 'https://other.example/book/943662_4.html', text: '广告', order: 3 },
  ];
  assert.equal(
    H.findNextChapterPage({ pageUrl, links, visitedUrls: ['https://novel.example/book/943662_3.html'] }),
    null
  );
  assert.equal(H.findNextChapterPage({
    pageUrl: 'https://novel.example/book/ordinary.html',
    links: [{ href: '/book/ordinary-next.html', text: '下一章' }],
  }), null);
});
