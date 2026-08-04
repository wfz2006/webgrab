/** 真实站点分页章节烟测。默认只抓已知三页章节和一个无分页章节。 */
import { createRequire } from 'node:module';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const chromePath = process.env.WEBGRAB_CHROME_PATH;
if (!chromePath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pagedUrl = 'https://www.biqukong.com/119/119538/943662.html';
const ordinaryUrl = 'https://www.biqukong.com/119/119538/1035582.html';
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-novel-pages-'));
let context;

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const worker = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => context.serviceWorkers()[0]);
  if (!worker) throw new Error('扩展 Service Worker 未启动');
  const extensionId = new URL(worker.url()).host;
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/ui/popup.html`, { waitUntil: 'domcontentloaded' });

  const sourcePage = context.pages()[0] || await context.newPage();
  await sourcePage.goto(pagedUrl, { waitUntil: 'load', timeout: 30_000 });
  await sourcePage.waitForTimeout(1_000);
  const tabId = await worker.evaluate(async (url) => {
    const tabs = await chrome.tabs.query({ url });
    return tabs[0]?.id;
  }, pagedUrl);
  if (!Number.isInteger(tabId)) throw new Error('找不到真实章节标签页');
  const singleResponse = await extensionPage.evaluate(
    (input) => chrome.runtime.sendMessage({ type: 'NOVEL_EXTRACT_CHAPTER', ...input }),
    { tabId, pageUrl: pagedUrl }
  );
  if (!singleResponse?.ok) throw new Error(singleResponse?.error || '单章提取失败');

  const offscreenPage = await context.newPage();
  await offscreenPage.goto(`chrome-extension://${extensionId}/offscreen/downloader.html`);
  await offscreenPage.waitForFunction(() => Boolean(globalThis.WebGrabNovelExtractor && globalThis.WebGrabNovelHeuristics));

  const fullResults = await offscreenPage.evaluate(async ({ paged, ordinary }) => {
    const workerModule = await import('./novel-worker.js');
    async function runOne(url, id) {
      let stored = null;
      const requests = [];
      const delays = [];
      const book = {
        id,
        catalogUrl: 'https://www.biqukong.com/119/119538/',
        plannedCount: 1,
        plan: [{ index: 0, title: id, url }],
      };
      const store = {
        async getBook() { return book; },
        async markExtracting() {},
        async setCurrentChapter() {},
        async recordChapterSuccess(_bookId, chapter) { stored = chapter; },
        async recordChapterFailure(_bookId, _chapter, error) { throw error; },
        async markBookTerminal() {},
      };
      const task = { streamMeta: { kind: 'novel', bookId: id } };
      await workerModule.executeNovelTask(task, {
        store,
        delay: async (ms, signal) => {
          delays.push(ms);
          await workerModule.abortableDelay(ms, signal);
        },
        fetchDocument: async (pageUrl, signal) => {
          requests.push({ url: pageUrl, startedAt: Date.now() });
          return workerModule.fetchStaticDocument(pageUrl, signal);
        },
      });
      return {
        status: task.status,
        successCount: task.successCount,
        requests,
        delays,
        textLength: stored?.text?.length || 0,
        paragraphCount: (stored?.html?.match(/<p(?:\s|>)/gi) || []).length,
        physicalPageCount: requests.length,
        hasPageMarker: /第\s*[（(]\s*\d+\s*\/\s*\d+\s*[)）]\s*页/u.test(stored?.text || ''),
        tail: (stored?.text || '').slice(-160),
      };
    }
    return {
      paged: await runOne(paged, 'paged-real'),
      ordinary: await runOne(ordinary, 'ordinary-real'),
    };
  }, { paged: pagedUrl, ordinary: ordinaryUrl });

  const single = singleResponse.data;
  const paged = fullResults.paged;
  const ordinary = fullResults.ordinary;
  if (!single.hasMorePages || !/更多分页未提取/.test(single.warning || '')) {
    throw new Error(`单章预览没有分页提示: ${JSON.stringify(single)}`);
  }
  if (paged.status !== 'done' || paged.requests.length !== 3 || paged.textLength < single.wordCount * 2.2) {
    throw new Error(`三页拼接不完整: ${JSON.stringify({ single, paged })}`);
  }
  if (paged.hasPageMarker || !paged.delays.every((ms) => ms >= 300 && ms <= 800)) {
    throw new Error(`分页清理或礼貌延迟失败: ${JSON.stringify(paged)}`);
  }
  if (ordinary.status !== 'done' || ordinary.requests.length !== 1 || ordinary.delays.length !== 1) {
    throw new Error(`无分页章节发生额外请求: ${JSON.stringify(ordinary)}`);
  }
  console.log(JSON.stringify({ single, paged, ordinary }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
