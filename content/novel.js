/**
 * 小说 content script：只响应用户触发的消息，不被动提取或保存正文。
 */
(function initNovelContent() {
  'use strict';

  if (window.__webgrabNovelInstalled) return;
  window.__webgrabNovelInstalled = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (!['NOVEL_DETECT_PAGE', 'NOVEL_EXTRACT_CURRENT'].includes(message.type)) return;
    try {
      if (message.type === 'NOVEL_DETECT_PAGE') {
        sendResponse({
          ok: true,
          data: globalThis.WebGrabNovelExtractor.detectDocument(document, location.href),
        });
      } else {
        const chapter = globalThis.WebGrabNovelExtractor.extractChapter(document, location.href);
        const links = globalThis.WebGrabNovelHeuristics?.projectDocumentLinks(document, location.href) || [];
        const nextPage = globalThis.WebGrabNovelHeuristics?.findNextChapterPage({
          pageUrl: location.href,
          links,
          visitedUrls: [location.href],
        });
        sendResponse({
          ok: true,
          data: {
            ...chapter,
            hasMorePages: Boolean(nextPage),
            nextPageUrl: nextPage?.url || null,
            warning: nextPage ? '检测到本章还有更多分页未提取，仅显示当前页内容' : null,
          },
        });
      }
    } catch (error) {
      sendResponse({ ok: false, error: error.message || String(error) });
    }
  });
})();
