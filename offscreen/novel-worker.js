/**
 * P4-1 小说 offscreen worker。
 * 目录准备不抓正文；正式任务严格串行抓取静态 HTML，并逐章落入 IndexedDB。
 */

import {
  createPreparedBook,
  deleteBook,
  getBook,
  getNovel,
  markBookTerminal,
  markExtracting,
  recordChapterFailure,
  recordChapterSuccess,
  setCurrentChapter,
} from '../lib/novel-store.js';

function assertSameOriginHttp(urlValue, originUrl, label) {
  const url = new URL(urlValue, originUrl);
  const origin = new URL(originUrl);
  if (!['http:', 'https:'].includes(url.protocol) || url.origin !== origin.origin) {
    throw new Error(`${label}不是同源 HTTP(S) 地址`);
  }
  return url.href;
}

function parseHtml(html, url) {
  const document = new DOMParser().parseFromString(html, 'text/html');
  if (!document?.documentElement) throw new Error('HTML 解析失败');
  const base = document.createElement('base');
  base.href = url;
  document.head?.prepend(base);
  return document;
}

export async function fetchStaticDocument(url, signal, fetchImpl = fetch, timeoutMs = 20_000) {
  const requestController = new AbortController();
  let timedOut = false;
  const onParentAbort = () => requestController.abort(signal.reason);
  signal?.addEventListener('abort', onParentAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    requestController.abort();
  }, timeoutMs);
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      credentials: 'include',
      redirect: 'follow',
      cache: 'no-store',
      signal: requestController.signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const finalUrl = response.url || url;
    assertSameOriginHttp(finalUrl, url, '最终响应');
    return { document: parseHtml(await response.text(), finalUrl), finalUrl };
  } catch (error) {
    if (timedOut && !signal?.aborted) throw new Error(`请求超时（${timeoutMs / 1000} 秒）`);
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', onParentAbort);
  }
}

function textOf(element) {
  return String(element?.textContent || '').replace(/\s+/g, ' ').trim();
}

const MAX_CHAPTER_PHYSICAL_PAGES = 20;

function mergeChapterPages(pages, firstUrl) {
  if (!pages.length) throw new Error('章节没有可拼接的正文页');
  const html = pages.map((page) => page.html || '').filter(Boolean).join('\n');
  const text = pages.map((page) => page.text || '').filter(Boolean).join('\n\n');
  const paragraphCount = pages.reduce((sum, page) => {
    if (Number.isFinite(page.paragraphCount)) return sum + page.paragraphCount;
    return sum + ((page.html || '').match(/<p(?:\s|>)/gi) || []).length;
  }, 0);
  const normalizedText = String(text).replace(/\s+/g, ' ').trim();
  if (paragraphCount === 0) throw new Error('提取结果没有段落结构');
  if ([...normalizedText].length < 100) throw new Error('清理后的正文不足 100 字');
  return {
    ...pages[0],
    html,
    text,
    url: firstUrl,
    wordCount: [...normalizedText].length,
    paragraphCount,
    physicalPageCount: pages.length,
  };
}

export async function prepareNovelExtraction(input, dependencies = {}) {
  const fetchDocument = dependencies.fetchDocument || fetchStaticDocument;
  const store = dependencies.store || { createPreparedBook };
  const signal = input.signal;
  const catalogUrl = assertSameOriginHttp(input.catalogUrl, input.source, '目录页');
  const heuristics = globalThis.WebGrabNovelHeuristics;
  if (!heuristics) throw new Error('小说启发式模块未加载');

  let finalUrl;
  let identified;
  let title;
  let author = null;

  // 阅读页自带选章列表的站点（如纵横中文网）：content script 已经在真实渲染后的
  // DOM 上用同一套 identifyChapterList 规则识别成功过，这里不再对同一个 URL 重新
  // 发起静态 fetch——那份服务器原始响应可能根本看不到这份客户端 JS 渲染出来的列表
  // （真机验证过：curl 拿到的原始 HTML 里一条"第N章"都没有，只有 4 条导航链接）。
  const preSupplied = Array.isArray(input.catalogChapters) ? input.catalogChapters : null;
  if (preSupplied && preSupplied.length >= 10) {
    finalUrl = catalogUrl;
    identified = { chapters: preSupplied, skippedExternalCount: 0, skippedExternal: [] };
    title = input.pageTitle || '未命名小说';
  } else {
    const fetched = await fetchDocument(catalogUrl, signal, dependencies.fetchImpl);
    assertSameOriginHttp(fetched.finalUrl, catalogUrl, '目录页最终响应');
    finalUrl = fetched.finalUrl;

    const links = heuristics.projectDocumentLinks(fetched.document, finalUrl);
    identified = heuristics.identifyChapterList(links, finalUrl);

    title =
      textOf(fetched.document.querySelector('h1,[itemprop="name"]')) ||
      String(fetched.document.title || '').replace(/[-_|].*$/, '').trim() ||
      input.pageTitle ||
      '未命名小说';
    author =
      textOf(fetched.document.querySelector('[rel="author"],[itemprop="author"],.author,#author')) ||
      null;
  }

  if (identified.chapters.length < 10) throw new Error('未识别到至少 10 章的目录列表');
  const capped = heuristics.capChapterPlan(identified.chapters, 500);

  const book = await store.createPreparedBook({
    title,
    author,
    source: input.source,
    catalogUrl: finalUrl,
    plan: capped.chapters,
    detectedCount: capped.detectedCount,
    plannedCount: capped.plannedCount,
    truncated: capped.truncated,
    estimatedDelayMinutes: capped.estimatedDelayMinutes,
    skippedExternalCount: identified.skippedExternalCount,
    skippedExternal: identified.skippedExternal,
  });
  return summarizeBook(book);
}

export function abortableDelay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException('已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function executeNovelTask(task, dependencies = {}) {
  const store = dependencies.store || {
    getBook,
    markBookTerminal,
    markExtracting,
    recordChapterFailure,
    recordChapterSuccess,
    setCurrentChapter,
  };
  const bookId = task.streamMeta?.bookId;
  if (!bookId) throw new Error('小说任务缺少 bookId');
  const book = await store.getBook(bookId);
  if (!book) throw new Error('待提取的小说记录不存在');

  const controller = new AbortController();
  task._abortController = controller;
  const signal = controller.signal;
  const fetchDocument = dependencies.fetchDocument || fetchStaticDocument;
  const wait = dependencies.delay || abortableDelay;
  const random = dependencies.random || Math.random;
  const extract = dependencies.extractChapter || ((document, url) => {
    if (!globalThis.WebGrabNovelExtractor) throw new Error('正文提取器未加载');
    return globalThis.WebGrabNovelExtractor.extractChapter(document, url, { validate: false });
  });
  const projectLinks = dependencies.projectLinks || ((document, url) => {
    const heuristics = globalThis.WebGrabNovelHeuristics;
    if (!heuristics) throw new Error('小说启发式模块未加载');
    return heuristics.projectDocumentLinks(document, url);
  });
  const maxPhysicalPages = Math.max(
    1,
    Math.min(MAX_CHAPTER_PHYSICAL_PAGES, dependencies.maxPhysicalPages || MAX_CHAPTER_PHYSICAL_PAGES)
  );
  const report = dependencies.report || (() => {});

  task.status = 'extracting';
  task.total = book.plannedCount;
  task.downloaded = 0;
  task.successCount = 0;
  task.failureCount = 0;
  task.currentIndex = null;
  task.currentTitle = null;
  task.error = null;
  await store.markExtracting(bookId);
  report(task);

  try {
    for (const planned of book.plan.slice(0, 500)) {
      const delayMs = 300 + Math.floor(Math.max(0, Math.min(0.999999, random())) * 501);
      await wait(delayMs, signal);
      if (signal.aborted) throw new DOMException('已取消', 'AbortError');

      task.currentIndex = planned.index;
      task.currentTitle = planned.title;
      await store.setCurrentChapter(bookId, planned.index, planned.title);
      report(task);

      try {
        const chapterUrl = assertSameOriginHttp(planned.url, book.catalogUrl, '章节链接');
        const pageArticles = [];
        const visitedUrls = new Set();
        let pageUrl = chapterUrl;
        let firstFinalUrl = chapterUrl;
        let paginationTruncated = false;

        while (pageArticles.length < maxPhysicalPages) {
          if (pageArticles.length > 0) {
            const pageDelayMs = 300 + Math.floor(Math.max(0, Math.min(0.999999, random())) * 501);
            await wait(pageDelayMs, signal);
            if (signal.aborted) throw new DOMException('已取消', 'AbortError');
          }
          const { document, finalUrl } = await fetchDocument(pageUrl, signal, dependencies.fetchImpl);
          assertSameOriginHttp(finalUrl, book.catalogUrl, '章节最终响应');
          if (pageArticles.length === 0) firstFinalUrl = finalUrl;
          visitedUrls.add(finalUrl);
          pageArticles.push(extract(document, finalUrl));

          const heuristics = globalThis.WebGrabNovelHeuristics;
          if (!heuristics) throw new Error('小说启发式模块未加载');
          const nextPage = heuristics.findNextChapterPage({
            pageUrl: finalUrl,
            links: projectLinks(document, finalUrl),
            visitedUrls: [...visitedUrls],
          });
          if (!nextPage) break;
          if (pageArticles.length >= maxPhysicalPages) {
            paginationTruncated = true;
            break;
          }
          pageUrl = assertSameOriginHttp(nextPage.url, book.catalogUrl, '章节分页链接');
        }

        if (paginationTruncated) {
          console.warn(`[WebGrab/Novel] 章节物理分页达到 ${maxPhysicalPages} 页上限，保存已拼内容: ${firstFinalUrl}`);
        }
        const article = mergeChapterPages(pageArticles, firstFinalUrl);
        await store.recordChapterSuccess(bookId, {
          index: planned.index,
          // 目录标题决定书内顺序和章节名；页面 <title> 往往还拼接书名/站名。
          title: planned.title || article.title,
          html: article.html,
          text: article.text,
          url: article.url,
        });
        task.successCount += 1;
      } catch (error) {
        if (error?.name === 'AbortError') throw error;
        await store.recordChapterFailure(bookId, planned, error);
        task.failureCount += 1;
      }

      task.downloaded = task.successCount + task.failureCount;
      report(task);
    }

    task.status = task.successCount > 0 ? 'done' : 'failed';
    task.error = task.failureCount
      ? `成功 ${task.successCount} 章，失败 ${task.failureCount} 章`
      : null;
    task.completedAt = Date.now();
    await store.markBookTerminal(bookId, task.status, task.status === 'failed' ? task.error : null);
    report(task);
  } catch (error) {
    if (error?.name === 'AbortError' || task.status === 'canceled') {
      task.status = 'canceled';
      task.error = null;
      await store.markBookTerminal(bookId, 'canceled');
    } else {
      task.status = 'failed';
      task.error = error?.message || String(error);
      await store.markBookTerminal(bookId, 'failed', error);
    }
    task.completedAt = Date.now();
    report(task);
  } finally {
    task._abortController = null;
  }
}

export async function discardPreparedNovel(bookId) {
  const book = await getBook(bookId);
  if (book?.status === 'extracting') throw new Error('提取中的小说不能丢弃');
  if (book) await deleteBook(bookId);
  return { deleted: Boolean(book) };
}

export async function markNovelTaskCanceled(bookId) {
  const book = await getBook(bookId);
  if (book && !['done', 'failed', 'canceled'].includes(book.status)) {
    await markBookTerminal(bookId, 'canceled');
  }
}

export async function getNovelBook(bookId, includeChapters = false) {
  return includeChapters ? getNovel(bookId) : summarizeBook(await getBook(bookId));
}

export function summarizeBook(book) {
  if (!book) return null;
  const {
    plan,
    failures,
    skippedExternal,
    ...summary
  } = book;
  return {
    ...summary,
    failurePreview: (failures || []).slice(0, 20),
    skippedExternalPreview: (skippedExternal || []).slice(0, 20),
  };
}
