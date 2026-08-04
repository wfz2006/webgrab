/**
 * WebGrab 小说正文提取器。
 * 依赖同一执行上下文中的 Mozilla Readability 全局构造器。
 */
(function initNovelExtractor(global) {
  'use strict';

  const NOISE_ATTR_RE = /(?:^|[-_\s])(ad|ads|advert|banner|recommend|related|promo|sponsor|breadcrumb|pagination|pager|nav|menu|footer|sidebar)(?:$|[-_\s])/i;
  const NAV_TEXT_RE = /^(?:上一章|下一章|上[一1]页|下[一1]页|章节目录|返回目录|返回书页|书页|目录)(?:\s*[|·›»→-]\s*(?:上一章|下一章|上[一1]页|下[一1]页|章节目录|返回目录|返回书页|书页|目录))*$/u;
  const PAGE_MARKER_RE = /^第\s*[（(]\s*\d+\s*\/\s*\d+\s*[)）]\s*页$/u;
  const PAGE_MARKER_INLINE_RE = /第\s*[（(]\s*\d+\s*\/\s*\d+\s*[)）]\s*页/gu;
  const ACTIVE_TAGS = 'script,style,noscript,template,iframe,frame,object,embed,form,button,input,select,textarea';

  function normalizeText(value) {
    return String(value || '').replace(/\s+/g, ' ').trim();
  }

  function stripPaginationMarkerText(value) {
    return String(value || '').replace(PAGE_MARKER_INLINE_RE, '');
  }

  function stripPaginationMarkersFromNodes(root) {
    for (const node of Array.from(root?.childNodes || [])) {
      if (node.nodeType === 3) node.nodeValue = stripPaginationMarkerText(node.nodeValue);
      else stripPaginationMarkersFromNodes(node);
    }
  }

  function removeGenericNoise(root) {
    root.querySelectorAll?.(`${ACTIVE_TAGS},nav,aside,footer,[role="navigation"],[role="complementary"],[aria-label]`).forEach((element) => {
      const aria = normalizeText(element.getAttribute?.('aria-label'));
      if (
        element.matches?.(ACTIVE_TAGS + ',nav,aside,footer,[role="navigation"],[role="complementary"]') ||
        NOISE_ATTR_RE.test(aria)
      ) {
        element.remove();
      }
    });

    root.querySelectorAll?.('[class],[id]').forEach((element) => {
      const signature = `${element.id || ''} ${element.className || ''}`;
      if (NOISE_ATTR_RE.test(signature)) element.remove();
    });
  }

  function sanitizeArticleHtml(document, html) {
    const template = document.createElement('template');
    template.innerHTML = html || '';
    const fragment = template.content;
    fragment.querySelectorAll(ACTIVE_TAGS).forEach((element) => element.remove());
    stripPaginationMarkersFromNodes(fragment);

    fragment.querySelectorAll('*').forEach((element) => {
      for (const attr of Array.from(element.attributes || [])) {
        const name = attr.name.toLowerCase();
        const value = attr.value.trim();
        if (name.startsWith('on') || name === 'srcdoc' || name === 'style') {
          element.removeAttribute(attr.name);
        } else if ((name === 'href' || name === 'src' || name === 'xlink:href') && /^javascript:/i.test(value)) {
          element.removeAttribute(attr.name);
        }
      }
    });

    fragment.querySelectorAll('nav,[role="navigation"],a').forEach((element) => {
      const text = normalizeText(element.textContent);
      if (!NAV_TEXT_RE.test(text)) return;
      const parent = element.parentElement;
      if (parent && normalizeText(parent.textContent).length <= 160) parent.remove();
      else element.remove();
    });

    fragment.querySelectorAll('*').forEach((element) => {
      if (PAGE_MARKER_RE.test(normalizeText(element.textContent))) element.remove();
    });

    fragment.querySelectorAll('[class],[id],[aria-label]').forEach((element) => {
      const signature = `${element.id || ''} ${element.className || ''} ${element.getAttribute('aria-label') || ''}`;
      if (NOISE_ATTR_RE.test(signature)) element.remove();
    });
    return template.innerHTML.trim();
  }

  function extractChapter(document, pageUrl, options = {}) {
    if (!document?.cloneNode) throw new Error('当前页面 DOM 不可用');
    const ReadabilityCtor = options.Readability || global.Readability;
    if (typeof ReadabilityCtor !== 'function') throw new Error('Readability 尚未加载');

    const clone = document.cloneNode(true);
    removeGenericNoise(clone);
    const article = new ReadabilityCtor(clone, {
      charThreshold: 100,
      keepClasses: false,
    }).parse();
    if (!article) throw new Error('Readability 未识别到正文');

    const html = sanitizeArticleHtml(document, article.content);
    const probe = document.createElement('template');
    probe.innerHTML = html;
    const paragraphCount = probe.content.querySelectorAll('p').length;
    const text = normalizeText(probe.content.textContent || article.textContent);
    if (options.validate !== false) {
      if (paragraphCount === 0) throw new Error('提取结果没有段落结构');
      if ([...text].length < 100) throw new Error('清理后的正文不足 100 字');
    }

    return {
      title: normalizeText(article.title) || normalizeText(document.title) || '未命名章节',
      byline: normalizeText(article.byline) || null,
      html,
      text,
      url: pageUrl || document.location?.href || '',
      wordCount: [...text].length,
      paragraphCount,
    };
  }

  function detectDocument(document, pageUrl) {
    if (!document?.querySelectorAll) return { detected: false, reason: 'DOM 不可用' };
    const candidates = Array.from(document.querySelectorAll(
      'article,main,[role="main"],[id*="content" i],[class*="content" i]'
    ));
    if (document.body) candidates.push(document.body);
    const mainCandidate = candidates
      .map((element) => ({
        element,
        text: normalizeText(element.innerText || element.textContent),
      }))
      .sort((a, b) => b.text.length - a.text.length)[0];
    const paragraphs = Array.from(mainCandidate?.element?.querySelectorAll?.('p') || []);
    const lineCount = String(mainCandidate?.element?.innerText || '')
      .split(/\n+/)
      .map(normalizeText)
      .filter((line) => line.length >= 20).length;
    const textLength = mainCandidate?.text.length || 0;
    const paragraphCount = Math.max(paragraphs.length, lineCount);
    const detected = textLength >= 140 && paragraphCount >= 2;
    const links = global.WebGrabNovelHeuristics?.projectDocumentLinks(document, pageUrl) || [];
    const currentList = global.WebGrabNovelHeuristics?.identifyChapterList(links, pageUrl);
    // 不能要求"本页没检测到正文"才认当前页是目录候选：不少站点的阅读页会把完整的
    // 选章列表直接嵌在正文页面里（而不是单独一个目录页），比如纵横中文网的阅读页
    // 正文和 461 章的选章列表同时存在于同一个 DOM。identifyChapterList 本身已经有
    // 足够严格的过滤条件（同源、同容器、≥10 条、标题长度分布一致、非根路径前缀），
    // 只要它找到了有效分组就该信；额外要求"本页不像正文"只会让这类站点永远走不到
    // "提取全本"，误伤那些正文页+选章列表共存的常见布局。
    const catalog = global.WebGrabNovelHeuristics?.findCatalogCandidate({
      pageUrl,
      links,
      hasChapterGroup: Boolean(currentList?.chapters.length),
    });
    return {
      detected,
      title: normalizeText(document.querySelector('h1')?.textContent) || normalizeText(document.title),
      textLength,
      paragraphCount,
      catalogUrl: catalog?.url || null,
      catalogReason: catalog?.reason || null,
      currentPageChapterCount: currentList?.chapters.length || 0,
      // 只有目录候选就是当前页自身时才带上已识别出的章节列表：这种情况下"提取全本"
      // 准备阶段不该再对同一个 URL 重新发起一次静态 fetch——那份服务器原始响应可能
      // 看不到这份客户端 JS 渲染出来的列表（真实撞过纵横中文网），而这里已经是在
      // 真实渲染后的 DOM 上识别成功的结果，直接透传即可。目录是另一个页面时（explicit-text /
      // parent-link）不带，因为 currentList 描述的是当前页而不是那个目录页。
      catalogChapters: catalog?.reason === 'current-page' ? (currentList?.chapters || null) : null,
    };
  }

  global.WebGrabNovelExtractor = Object.freeze({
    detectDocument,
    extractChapter,
    sanitizeArticleHtml,
    removeGenericNoise,
    stripPaginationMarkerText,
  });
})(globalThis);
