import test from 'node:test';
import assert from 'node:assert/strict';

await import('../lib/novel-heuristics.js');
await import('../lib/novel-extractor.js');
const extractor = globalThis.WebGrabNovelExtractor;

test('分页标记嵌在正文文本节点中时只删除标记并保留相邻正文', () => {
  assert.equal(
    extractor.stripPaginationMarkerText('  第(1/3)页 “为…什么？”'),
    '   “为…什么？”'
  );
  assert.equal(
    extractor.stripPaginationMarkerText('第（20 / 20）页\n最后一段'),
    '\n最后一段'
  );
});

// ─── detectDocument：正文页与选章列表共存时的目录识别 ──────────────
//
// 复现真实站点（纵横中文网 read.zongheng.com）的阅读页结构：同一个 DOM 里
// 既有可读正文（会被判定为 detected=true），又嵌了一份完整的选章列表
// （461 章，同源、同容器、标题长度分布一致、共享非根路径前缀）。
// 这里手搭一个只覆盖 detectDocument 实际会调用到的那几个 DOM 方法的最小桩，
// 项目里没有引入 jsdom，没必要为一个测试引入完整依赖。

function makeFakeDom({ articleText, chapterCount }) {
  const baseUrl = 'https://read.example.test/chapter/42/1.html';

  function makeElement(tagName, { textContent = '', children = [] } = {}) {
    const el = {
      tagName: tagName.toUpperCase(),
      textContent,
      innerText: textContent,
      children,
      parentNode: null,
      attrs: {},
      getAttribute(name) {
        return this.attrs[name] ?? null;
      },
      querySelectorAll(selector) {
        // 只需要支持源码里实际用到的两种查询：'p' 和 anchor closest 用到的容器标签枚举。
        if (selector === 'p') {
          return this.children.filter((c) => c.tagName === 'P');
        }
        return [];
      },
      closest(selector) {
        const tags = selector.split(',');
        let node = this;
        while (node) {
          if (tags.includes(node.tagName?.toLowerCase())) return node;
          node = node.parentNode;
        }
        return null;
      },
    };
    for (const child of children) child.parentNode = el;
    return el;
  }

  const paragraphs = Array.from({ length: 6 }, (_, i) =>
    makeElement('p', { textContent: articleText.slice(i * 40, (i + 1) * 40) || articleText })
  );
  const article = makeElement('article', { textContent: articleText, children: paragraphs });
  article.attrs.id = 'content';

  const chapterAnchors = Array.from({ length: chapterCount }, (_, i) => {
    const a = makeElement('a', { textContent: `第${i + 1}章：这是一个标题` });
    a.attrs.href = `/chapter/42/${i + 1}.html`;
    return a;
  });
  const chapterListContainer = makeElement('div', { children: chapterAnchors });

  const h1 = makeElement('h1', { textContent: '测试小说标题' });
  const body = makeElement('body', { children: [h1, article, chapterListContainer] });

  const allAnchors = chapterAnchors;

  const document = {
    title: '测试小说标题_在线阅读',
    body,
    querySelector(selector) {
      if (selector === 'h1') return h1;
      return null;
    },
    querySelectorAll(selector) {
      if (selector === 'a[href]') return allAnchors;
      if (selector.includes('article')) return [article];
      return [];
    },
  };
  return { document, baseUrl };
}

test('正文页自身嵌了完整选章列表时，提取全本目录识别不能因为"本页也是正文"而放弃', () => {
  const longArticle = '正文内容。'.repeat(40); // 远超 140 字的检测阈值
  const { document, baseUrl } = makeFakeDom({ articleText: longArticle, chapterCount: 20 });

  const result = extractor.detectDocument(document, baseUrl);

  assert.equal(result.detected, true, '这页本身应该被判定为可读正文（复现问题的前提条件）');
  // 20 条里第 1 章的链接和当前页 URL 完全相同（选章列表里通常会有一条指回当前页），
  // identifyChapterList 会正确排除这条自引用链接，因此是 19 而不是 20。
  assert.equal(result.currentPageChapterCount, 19, '章节列表识别本身应该成功找到章节分组（刨除指向当前页自身的那条）');
  assert.equal(
    result.catalogUrl,
    baseUrl,
    '正文检测通过不该否决"当前页也是目录候选"的判断——这正是纵横中文网复现的问题'
  );
  assert.equal(result.catalogReason, 'current-page');
});

test('正文页没有嵌选章列表时，仍然维持原有行为——不会凭空捏造目录', () => {
  const longArticle = '正文内容。'.repeat(40);
  const { document, baseUrl } = makeFakeDom({ articleText: longArticle, chapterCount: 3 }); // 不足 10 条

  const result = extractor.detectDocument(document, baseUrl);

  assert.equal(result.detected, true);
  assert.equal(result.currentPageChapterCount, 0, '3 条链接不满足 identifyChapterList 的十条门槛');
  assert.equal(result.catalogUrl, null);
});
