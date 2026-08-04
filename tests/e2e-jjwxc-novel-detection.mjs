/**
 * 真实晋江章节页诊断/回归：分别测量 detectDocument 同步执行与完整扩展消息往返。
 * 运行时需通过 NODE_PATH 提供 playwright，并设置 WEBGRAB_CHROME_PATH。
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const chromePath = process.env.WEBGRAB_CHROME_PATH;
if (!chromePath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const targetUrl = process.env.WEBGRAB_TARGET_URL
  || 'https://www.jjwxc.net/onebook.php?novelid=4727&chapterid=1';
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-jjwxc-detection-'));
const heuristicsSource = readFileSync(join(extensionPath, 'lib', 'novel-heuristics.js'), 'utf8');
const extractorSource = readFileSync(join(extensionPath, 'lib', 'novel-extractor.js'), 'utf8');
let context;

const waitFor = async (fn, timeoutMs = 15_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
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
    bypassCSP: true,
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--window-position=-32000,-32000',
      '--window-size=1000,760',
      '--enable-unsafe-extension-debugging',
    ],
  });
  const browserCdp = await context.browser().newBrowserCDPSession();
  const extension = await browserCdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (!extension?.id) throw new Error(`CDP 未返回扩展 ID: ${JSON.stringify(extension)}`);
  const extensionId = extension.id;
  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extensionId}/ui/popup.html`, { waitUntil: 'domcontentloaded' });

  // 在独立页面直接运行相同同步函数，确认耗时是否来自 detectDocument 本身。
  const diagnosticPage = context.pages()[0];
  await diagnosticPage.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  await diagnosticPage.waitForTimeout(1500);
  const domShape = await diagnosticPage.evaluate(() => ({
    candidates: document.querySelectorAll('article,main,[role="main"],[id*="content" i],[class*="content" i]').length,
    anchors: document.querySelectorAll('a[href]').length,
    elements: document.querySelectorAll('*').length,
    bodyTextLength: (document.body?.innerText || '').length,
  }));
  await diagnosticPage.addScriptTag({ content: heuristicsSource });
  await diagnosticPage.addScriptTag({ content: extractorSource });
  const cdp = await context.newCDPSession(diagnosticPage);
  let directDetection;
  try {
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: `(() => { const started = performance.now(); const data = WebGrabNovelExtractor.detectDocument(document, location.href); return { durationMs: performance.now() - started, data }; })()`,
      returnByValue: true,
      timeout: 8000,
    });
    if (evaluated.exceptionDetails) throw new Error(evaluated.exceptionDetails.text || '直接检测异常');
    directDetection = evaluated.result.value;
  } catch (error) {
    directDetection = { timedOut: true, error: error.message || String(error) };
  }
  await diagnosticPage.close();

  const targetPage = await context.newPage();
  await targetPage.goto(targetUrl, { waitUntil: 'load', timeout: 30_000 });
  await targetPage.waitForTimeout(1500);
  await targetPage.bringToFront();
  const tabId = await extensionPage.evaluate(async (needle) => {
    const tabs = await chrome.tabs.query({});
    return tabs.find((tab) => tab.url?.includes(needle))?.id;
  }, 'www.jjwxc.net/onebook.php');
  if (!Number.isInteger(tabId)) throw new Error('找不到晋江章节标签页');

  const roundTrip = await extensionPage.evaluate(async ({ targetTabId, timeoutMs }) => {
    const started = performance.now();
    return Promise.race([
      chrome.runtime.sendMessage({ type: 'NOVEL_DETECT', tabId: targetTabId })
        .then((response) => ({ timedOut: false, durationMs: performance.now() - started, response }))
        .catch((error) => ({ timedOut: false, durationMs: performance.now() - started, error: error.message || String(error) })),
      new Promise((resolveTimeout) => setTimeout(() => resolveTimeout({
        timedOut: true,
        durationMs: performance.now() - started,
      }), timeoutMs)),
    ]);
  }, { targetTabId: tabId, timeoutMs: 10_000 });

  console.log(JSON.stringify({ targetUrl, domShape, directDetection, roundTrip }, null, 2));
  if (roundTrip.timedOut) throw new Error('晋江 NOVEL_DETECT 消息往返超过 10 秒');
} finally {
  await context?.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
