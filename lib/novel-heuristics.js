/**
 * WebGrab 小说通用启发式。
 *
 * 这是一个无站点知识的纯函数模块，同时供 content script、offscreen 和
 * Node 回归测试使用。浏览器上下文通过 globalThis.WebGrabNovelHeuristics 访问。
 */
(function initNovelHeuristics(global) {
  'use strict';

  const CATALOG_TEXT_RE = /^(?:返回)?(?:章节)?目录$|^书页$|^返回书页$/u;
  const HTTP_PROTOCOLS = new Set(['http:', 'https:']);

  function cleanText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function resolveHttpUrl(value, baseUrl) {
    try {
      const url = new URL(value, baseUrl);
      return HTTP_PROTOCOLS.has(url.protocol) ? url : null;
    } catch {
      return null;
    }
  }

  function normalizedPathPrefix(url) {
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length <= 1) return '/';
    return `/${parts.slice(0, -1).join('/')}/`;
  }

  function parentPageUrl(pageUrl) {
    const url = resolveHttpUrl(pageUrl, pageUrl);
    if (!url) return null;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length === 0) return null;
    parts.pop();
    url.pathname = `/${parts.join('/')}${parts.length ? '/' : ''}`;
    url.search = '';
    url.hash = '';
    return url.href;
  }

  /**
   * 将物理分页 URL 归一到章节首页。只识别紧挨扩展名前的 `_数字`，不读取
   * 链接文字。例如 943662_2.html 与 943662.html 的 baseUrl 相同。
   */
  function describeChapterPage(urlValue, baseUrl) {
    const url = resolveHttpUrl(urlValue, baseUrl);
    if (!url) return null;
    url.hash = '';
    const match = url.pathname.match(/^(.*)_([0-9]+)(\.[^./]+)$/u);
    const pageNumber = match ? Number(match[2]) : 1;
    const base = new URL(url.href);
    if (match) base.pathname = `${match[1]}${match[3]}`;
    return { url: url.href, baseUrl: base.href, pageNumber };
  }

  function findNextChapterPage({ pageUrl, links = [], visitedUrls = [] }) {
    const current = describeChapterPage(pageUrl, pageUrl);
    if (!current) return null;
    const visited = new Set(
      visitedUrls.map((value) => describeChapterPage(value, pageUrl)?.url).filter(Boolean)
    );
    return links
      .map((link, index) => {
        const candidate = describeChapterPage(link.href, pageUrl);
        if (!candidate) return null;
        return { ...candidate, order: link.order ?? index };
      })
      .filter((candidate) =>
        candidate &&
        candidate.baseUrl === current.baseUrl &&
        candidate.pageNumber > current.pageNumber &&
        !visited.has(candidate.url)
      )
      .sort((a, b) => a.pageNumber - b.pageNumber || a.order - b.order)
      .map(({ url, pageNumber, order }) => ({ url, pageNumber, order }))[0] || null;
  }

  function findCatalogCandidate({ pageUrl, links = [], hasChapterGroup = false }) {
    const page = resolveHttpUrl(pageUrl, pageUrl);
    if (!page) return null;
    if (hasChapterGroup) {
      return { url: page.href, reason: 'current-page' };
    }

    const normalized = links
      .map((link, index) => {
        const url = resolveHttpUrl(link.href, page.href);
        return url
          ? { url, text: cleanText(link.text), order: link.order ?? index }
          : null;
      })
      .filter(Boolean)
      .filter((item) => item.url.origin === page.origin)
      .sort((a, b) => a.order - b.order);

    const explicit = normalized.find((item) => CATALOG_TEXT_RE.test(item.text));
    if (explicit) return { url: explicit.url.href, reason: 'explicit-text' };

    const parent = parentPageUrl(page.href);
    if (!parent) return null;
    const exactParent = normalized.find((item) => {
      const candidate = new URL(item.url.href);
      candidate.hash = '';
      return candidate.href === parent;
    });
    return exactParent ? { url: exactParent.url.href, reason: 'parent-link' } : null;
  }

  function median(numbers) {
    const sorted = [...numbers].sort((a, b) => a - b);
    if (!sorted.length) return 0;
    const middle = Math.floor(sorted.length / 2);
    return sorted.length % 2
      ? sorted[middle]
      : (sorted[middle - 1] + sorted[middle]) / 2;
  }

  function titleLengthsAreConsistent(items) {
    const lengths = items.map((item) => [...item.text].length).filter(Boolean);
    const center = median(lengths);
    if (!center) return false;
    const consistent = lengths.filter(
      (length) => length >= center * 0.5 && length <= center * 2
    ).length;
    return consistent / lengths.length >= 0.7;
  }

  function identifyChapterList(links = [], catalogUrl) {
    const catalog = resolveHttpUrl(catalogUrl, catalogUrl);
    const empty = {
      chapters: [],
      skippedExternalCount: 0,
      skippedExternal: [],
      groupKey: null,
    };
    if (!catalog) return empty;

    const sameOrigin = [];
    const external = [];
    links.forEach((link, order) => {
      const url = resolveHttpUrl(link.href, catalog.href);
      const text = cleanText(link.text);
      if (!url || !text || url.href === catalog.href) return;
      const item = {
        url: url.href,
        text,
        title: text,
        order: link.order ?? order,
        containerKey: link.containerKey || 'document',
        prefix: normalizedPathPrefix(url),
      };
      if (url.origin !== catalog.origin) external.push(item);
      else sameOrigin.push(item);
    });

    const groups = new Map();
    for (const item of sameOrigin) {
      const key = `${item.containerKey}\n${item.prefix}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(item);
    }

    const candidates = [...groups.entries()]
      .map(([key, items]) => [
        key,
        items
          .sort((a, b) => a.order - b.order)
          .filter((item, index, array) => index === 0 || item.url !== array[index - 1].url),
      ])
      .filter(([, items]) =>
        items.length >= 10 &&
        items[0].prefix !== '/' &&
        titleLengthsAreConsistent(items)
      )
      .sort((a, b) => b[1].length - a[1].length || a[1][0].order - b[1][0].order);

    if (!candidates.length) {
      return {
        ...empty,
        skippedExternalCount: external.length,
        skippedExternal: external.slice(0, 50),
      };
    }

    const [groupKey, items] = candidates[0];
    return {
      chapters: items.map((item, index) => ({
        index,
        title: item.title,
        url: item.url,
      })),
      skippedExternalCount: external.length,
      skippedExternal: external.slice(0, 50),
      groupKey,
    };
  }

  function capChapterPlan(chapters = [], maxChapters = 500) {
    const detectedCount = chapters.length;
    const plannedCount = Math.min(detectedCount, maxChapters);
    return {
      chapters: chapters.slice(0, plannedCount).map((chapter, index) => ({
        ...chapter,
        index,
      })),
      detectedCount,
      plannedCount,
      truncated: detectedCount > plannedCount,
      estimatedDelayMinutes: {
        min: Number(((plannedCount * 300) / 60000).toFixed(1)),
        max: Number(((plannedCount * 800) / 60000).toFixed(1)),
      },
    };
  }

  function projectDocumentLinks(document, baseUrl) {
    if (!document?.querySelectorAll) return [];
    const containerIds = new WeakMap();
    let nextContainerId = 1;
    return Array.from(document.querySelectorAll('a[href]')).map((anchor, order) => {
      const container = anchor.closest?.('ol,ul,dl,table,main,article,section,div') || document.body;
      if (container && !containerIds.has(container)) containerIds.set(container, nextContainerId++);
      const url = resolveHttpUrl(anchor.getAttribute('href'), baseUrl);
      return {
        href: url?.href || anchor.getAttribute('href') || '',
        text: cleanText(anchor.textContent),
        order,
        containerKey: `container-${container ? containerIds.get(container) : 0}`,
      };
    });
  }

  global.WebGrabNovelHeuristics = Object.freeze({
    cleanText,
    resolveHttpUrl,
    findCatalogCandidate,
    identifyChapterList,
    capChapterPlan,
    projectDocumentLinks,
    describeChapterPage,
    findNextChapterPage,
  });
})(globalThis);
