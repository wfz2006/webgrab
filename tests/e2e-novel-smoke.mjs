/**
 * 本地浏览器级烟测：加载真实 MV3 扩展，使用 20 章同源静态站点验证
 * Readability、消息路由、offscreen 严格任务、IndexedDB 和取消保留。
 *
 * 运行前给 NODE_PATH 指向包含 playwright 的依赖目录。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chromePath = process.env.WEBGRAB_CHROME_PATH;
if (!chromePath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const paragraph = '这是一段用于验证正文提取完整性的中文测试内容，包含足够多的文字来通过质量闸门，并确保段落结构不会被压缩或误删。'.repeat(3);
const renderChapter = (index) => `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>第${index}章 测试正文 - 测试小说</title></head><body>
  <header><a href="/">首页</a></header><main><article><h1>第${index}章 测试正文</h1>
  ${Array.from({ length: 5 }, (_, p) => `<p>${paragraph}（段落 ${p + 1}）</p>`).join('')}
  <div class="recommend">推荐阅读：广告内容</div>
  <nav><a href="/book/${Math.max(1, index - 1)}.html">上一章</a><a href="/book/">返回目录</a><a href="/book/${Math.min(20, index + 1)}.html">下一章</a></nav>
  </article></main></body></html>`;

const server = createServer((request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  if (request.url === '/book/' || request.url === '/book') {
    response.end(`<!doctype html><html><head><meta charset="utf-8"><title>测试小说 - 章节目录</title></head><body><h1>测试小说</h1><p class="author">测试作者</p><dl>${Array.from({ length: 20 }, (_, i) => `<dd><a href="/book/${i + 1}.html">第${i + 1}章 测试正文</a></dd>`).join('')}</dl><a href="https://ads.example/landing">第999章 外域广告</a></body></html>`);
    return;
  }
  const match = request.url?.match(/^\/book\/(\d+)\.html$/);
  if (match) {
    response.end(renderChapter(Number(match[1])));
    return;
  }
  response.statusCode = 404;
  response.end('<h1>404</h1>');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const { port } = server.address();
const localSourceUrl = `http://127.0.0.1:${port}/book/1.html`;
const sourceUrl = process.env.WEBGRAB_TARGET_URL || localSourceUrl;
const isRealSite = sourceUrl !== localSourceUrl;
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-novel-e2e-'));
let context;

const send = async (worker, message) => worker.evaluate(
  (payload) => chrome.runtime.sendMessage(payload),
  message
);

const waitFor = async (fn, timeoutMs = 30_000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`等待超时: ${timeoutMs}ms`);
};

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: process.env.WEBGRAB_HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--window-position=-32000,-32000',
      '--window-size=420,640',
      '--enable-unsafe-extension-debugging',
    ],
  });
  const page = context.pages()[0] || await context.newPage();
  const cdp = await context.browser().newBrowserCDPSession();
  const loadedExtension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (!loadedExtension?.id) throw new Error(`CDP 未返回扩展 ID: ${JSON.stringify(loadedExtension)}`);
  // 打开一次扩展页以显式唤醒 MV3 Service Worker，再回到章节标签页。
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${loadedExtension.id}/ui/popup.html`, {
    waitUntil: 'domcontentloaded',
  });
  await page.goto(sourceUrl, { waitUntil: 'load', timeout: 30_000 });
  await page.waitForTimeout(1_000);
  await page.bringToFront();
  const worker = await waitFor(() => context.serviceWorkers()[0], 10_000);
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  }, sourceUrl);
  if (!Number.isInteger(tabId)) throw new Error('找不到章节标签页');

  const detection = await send(extensionPage, { type: 'NOVEL_DETECT', tabId });
  if (!detection?.ok || !detection.data?.detected) throw new Error(`检测失败: ${JSON.stringify(detection)}`);
  if (!detection.data.catalogUrl || (!isRealSite && detection.data.catalogUrl !== `http://127.0.0.1:${port}/book/`)) {
    throw new Error(`目录候选错误: ${detection.data.catalogUrl}`);
  }

  const single = await send(extensionPage, {
    type: 'NOVEL_EXTRACT_CHAPTER',
    tabId,
    pageUrl: sourceUrl,
  });
  if (!single?.ok || single.data.wordCount < 100 || single.data.paragraphCount < 2) {
    throw new Error(`单章提取失败: ${JSON.stringify(single)}`);
  }
  const singleStored = await worker.evaluate(async (bookId) => {
    const db = await new Promise((resolveDb, rejectDb) => {
      const request = indexedDB.open('webgrab_novels', 1);
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => rejectDb(request.error);
    });
    const transaction = db.transaction('chapters', 'readonly');
    const request = transaction.objectStore('chapters').index('bookId').getAll(bookId);
    const chapters = await new Promise((resolveRequest, rejectRequest) => {
      request.onsuccess = () => resolveRequest(request.result);
      request.onerror = () => rejectRequest(request.error);
    });
    db.close();
    const chapter = chapters[0];
    return {
      cleanNavigation: !/(上一章|下一章|返回目录|章节目录)/u.test(chapter.html),
      safeHtml: !/(<script|<iframe|\son\w+=|javascript:)/i.test(chapter.html),
    };
  }, single.data.bookId);
  if (!singleStored.cleanNavigation || !singleStored.safeHtml) {
    throw new Error(`单章清理不完整: ${JSON.stringify(singleStored)}`);
  }

  const prepared = await send(extensionPage, {
    type: 'NOVEL_PREPARE_FULL',
    tabId,
    pageUrl: sourceUrl,
    pageTitle: detection.data.title,
    catalogUrl: detection.data.catalogUrl,
  });
  if (!prepared?.ok || prepared.data.detectedCount < 10) {
    throw new Error(`目录准备失败: ${JSON.stringify(prepared)}`);
  }
  // 真实站点验收严格限制为前 20 章；只修改这次临时浏览器配置中的 prepared
  // 计划，不改变产品 500 章硬上限和 UI。
  if (isRealSite && prepared.data.plannedCount > 20) {
    await worker.evaluate(async (bookId) => {
      const db = await new Promise((resolveDb, rejectDb) => {
        const request = indexedDB.open('webgrab_novels', 1);
        request.onsuccess = () => resolveDb(request.result);
        request.onerror = () => rejectDb(request.error);
      });
      await new Promise((resolveTransaction, rejectTransaction) => {
        const transaction = db.transaction('books', 'readwrite');
        const store = transaction.objectStore('books');
        const request = store.get(bookId);
        request.onsuccess = () => {
          const book = request.result;
          book.plan = book.plan.slice(0, 20).map((chapter, index) => ({ ...chapter, index }));
          book.plannedCount = book.plan.length;
          book.updatedAt = Date.now();
          store.put(book);
        };
        transaction.oncomplete = resolveTransaction;
        transaction.onerror = () => rejectTransaction(transaction.error);
      });
      db.close();
    }, prepared.data.id);
    prepared.data.plannedCount = 20;
  }
  const started = await send(extensionPage, { type: 'NOVEL_START_FULL', bookId: prepared.data.id });
  if (!started?.ok) throw new Error(`任务启动失败: ${JSON.stringify(started)}`);

  const completedTask = await waitFor(async () => {
    const response = await send(extensionPage, { type: 'GET_TASKS' });
    const task = response?.data?.tasks?.find((item) => item.id === started.data.taskId);
    return task && ['done', 'failed', 'canceled'].includes(task.status) ? task : null;
  }, isRealSite ? 90_000 : 45_000);
  if (completedTask.status !== 'done' || completedTask.successCount !== 20 || completedTask.failureCount !== 0) {
    throw new Error(`20 章任务未完整成功: ${JSON.stringify(completedTask)}`);
  }

  const stored = await worker.evaluate(async (bookId) => {
    const db = await new Promise((resolveDb, rejectDb) => {
      const request = indexedDB.open('webgrab_novels', 1);
      request.onsuccess = () => resolveDb(request.result);
      request.onerror = () => rejectDb(request.error);
    });
    const transaction = db.transaction(['books', 'chapters'], 'readonly');
    const bookRequest = transaction.objectStore('books').get(bookId);
    const chaptersRequest = transaction.objectStore('chapters').index('bookId').getAll(bookId);
    const result = await new Promise((resolveResult, rejectResult) => {
      transaction.oncomplete = () => resolveResult({
        book: bookRequest.result,
        chapters: chaptersRequest.result,
      });
      transaction.onerror = () => rejectResult(transaction.error);
    });
    db.close();
    return {
      status: result.book.status,
      successCount: result.book.successCount,
      chapterCount: result.chapters.length,
      indexes: result.chapters.map((chapter) => chapter.index),
      validBodies: result.chapters.every((chapter) => chapter.html.includes('<p>') && chapter.text.length >= 100),
      cleanNavigation: result.chapters.every((chapter) => !/(上一章|下一章|返回目录|章节目录)/u.test(chapter.html)),
      titlesMatch: result.chapters.every((chapter, index) => chapter.title === result.book.plan[index]?.title),
    };
  }, prepared.data.id);
  if (stored.chapterCount !== 20 || !stored.validBodies || !stored.cleanNavigation || !stored.titlesMatch || stored.indexes.some((value, index) => value !== index)) {
    throw new Error(`IndexedDB 章节不完整: ${JSON.stringify(stored)}`);
  }

  let canceledBook = null;
  if (!isRealSite) {
    const preparedCancel = await send(extensionPage, {
    type: 'NOVEL_PREPARE_FULL',
    tabId,
    pageUrl: sourceUrl,
    pageTitle: detection.data.title,
    catalogUrl: detection.data.catalogUrl,
  });
    const startedCancel = await send(extensionPage, {
    type: 'NOVEL_START_FULL',
    bookId: preparedCancel.data.id,
  });
    await waitFor(async () => {
      const response = await send(extensionPage, { type: 'GET_TASKS' });
      return response?.data?.tasks?.find((item) => item.id === startedCancel.data.taskId && item.downloaded >= 1);
    }, 10_000);
    await send(extensionPage, { type: 'CANCEL_TASK', taskId: startedCancel.data.taskId });
    canceledBook = await waitFor(async () => {
      const response = await send(extensionPage, {
        type: 'NOVEL_GET_BOOK_STATUS',
        bookId: preparedCancel.data.id,
      });
      return response?.data?.status === 'canceled' ? response.data : null;
    }, 10_000);
    if (canceledBook.successCount < 1) throw new Error('取消后已提取章节未保留');
  }

  console.log(JSON.stringify({
    extensionLoaded: true,
    detection: {
      title: detection.data.title,
      catalogUrl: detection.data.catalogUrl,
    },
    single: {
      title: single.data.title,
      wordCount: single.data.wordCount,
      paragraphCount: single.data.paragraphCount,
      cleanNavigation: singleStored.cleanNavigation,
      safeHtml: singleStored.safeHtml,
    },
    full: stored,
    canceled: canceledBook ? {
      status: canceledBook.status,
      successCount: canceledBook.successCount,
      completedCount: canceledBook.completedCount,
    } : null,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profileDir, { recursive: true, force: true });
}
