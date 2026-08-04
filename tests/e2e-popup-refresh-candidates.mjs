/**
 * 真实 Chromium MV3 回归：媒体候选默认折叠、同 URL 升级为主视频会重渲染，
 * 点击刷新会清空旧资源并实际重载宿主页。
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
const browserPath = process.env.WEBGRAB_CHROME_PATH;
if (!browserPath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

let pageRequestCount = 0;
const server = createServer((_request, response) => {
  pageRequestCount += 1;
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><body><h1>WebGrab refresh fixture</h1></body></html>');
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));

const sourceUrl = `http://127.0.0.1:${server.address().port}/`;
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-popup-candidates-e2e-'));
let context;

const waitFor = async (fn, timeoutMs = 20_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {}
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`等待超时: ${timeoutMs}ms`);
};

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath,
    headless: process.env.WEBGRAB_HEADED !== '1',
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--window-position=-32000,-32000',
      '--window-size=960,720',
      '--enable-unsafe-extension-debugging',
    ],
  });

  const hostPage = context.pages()[0];
  await hostPage.goto(sourceUrl, { waitUntil: 'load' });
  const cdp = await context.browser().newBrowserCDPSession();
  const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (!extension?.id) throw new Error('加载未打包扩展失败');

  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extension.id}/ui/options.html`, {
    waitUntil: 'domcontentloaded',
  });
  const tab = await waitFor(async () => {
    const tabs = await extensionPage.evaluate((url) => chrome.tabs.query({ url }), sourceUrl);
    return tabs[0] || null;
  });

  const candidates = [
    { url: 'https://v1.example.test/video', kind: 'video', ext: 'mp4', size: 90_400_000, source: 'network' },
    { url: 'https://v2.example.test/video', kind: 'video', ext: 'mp4', size: 59_200_000, source: 'network' },
    { url: 'https://static.example.test/loading.mp4', kind: 'video', ext: 'mp4', size: 220_000, source: 'network' },
  ];

  await hostPage.bringToFront();
  await waitFor(() => hostPage.evaluate(() => (
    document.getElementById('webgrab-floating-companion')?.shadowRoot?.querySelector('.wg-trigger') || null
  )));
  for (const resource of candidates) {
    const [injection] = await extensionPage.evaluate(
      ({ tabId, item }) => chrome.scripting.executeScript({
        target: { tabId, frameIds: [0] },
        world: 'ISOLATED',
        func: (resource) => chrome.runtime.sendMessage({ type: 'HOOK_RESOURCE', resource }),
        args: [item],
      }),
      { tabId: tab.id, item: resource }
    );
    const response = injection?.result;
    if (!response?.ok) throw new Error(`候选资源入库失败: ${response?.error || 'unknown'}`);
  }
  await waitFor(async () => {
    const response = await extensionPage.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: 'GET_RESOURCES', tabId }),
      tab.id
    );
    const urls = new Set((response?.data?.resources || []).map((resource) => resource.url));
    return candidates.every((candidate) => urls.has(candidate.url));
  });
  // 首次安装引导页可能在等待期间抢到前台；点击桌宠前必须再次激活宿主页，
  // 否则 popup 的 chrome.tabs.query 会读到引导页 tabId。
  await hostPage.bringToFront();
  await hostPage.evaluate(() => {
    document.getElementById('webgrab-floating-companion').shadowRoot.querySelector('.wg-trigger').click();
  });
  const popupFrame = await waitFor(() => hostPage.frames().find(
    (frame) => frame.url().includes('/ui/popup.html?embedded=1')
  ));

  const compact = await waitFor(() => popupFrame.evaluate(() => {
    const badge = document.querySelector('.media-role-recommended');
    const toggle = document.getElementById('media-candidate-toggle');
    const rows = document.querySelectorAll('.resource-item');
    return badge && !toggle.hidden ? {
      badge: badge.textContent,
      toggle: toggle.textContent,
      visibleRows: rows.length,
    } : null;
  }));
  await popupFrame.locator('#media-candidate-toggle').click();
  const expandedRows = await waitFor(() => popupFrame.evaluate(() => {
    const count = document.querySelectorAll('.resource-item').length;
    return count >= 3 ? count : 0;
  }));

  await extensionPage.evaluate(
    ({ tabId, item }) => chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'ISOLATED',
      func: (resource) => chrome.runtime.sendMessage({ type: 'HOOK_RESOURCE', resource }),
      args: [{ ...item, isPrimaryMedia: true }],
    }),
    { tabId: tab.id, item: candidates[0] }
  );
  const primary = await waitFor(() => popupFrame.evaluate(() => {
    const badge = document.querySelector('.media-role-primary');
    return badge ? {
      badge: badge.textContent,
      visibleRows: document.querySelectorAll('.resource-item').length,
    } : null;
  }));

  const beforeTimeOrigin = await hostPage.evaluate(() => performance.timeOrigin);
  const beforePageRequests = pageRequestCount;
  await Promise.all([
    hostPage.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30_000 }),
    popupFrame.locator('#btn-refresh').click(),
  ]);
  const afterTimeOrigin = await hostPage.evaluate(() => performance.timeOrigin);
  if (!(afterTimeOrigin > beforeTimeOrigin) || pageRequestCount <= beforePageRequests) {
    throw new Error('刷新按钮没有实际重载宿主页');
  }

  const cleared = await waitFor(async () => {
    const response = await extensionPage.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: 'GET_RESOURCES', tabId }),
      tab.id
    );
    return response?.data?.resources?.length === 0;
  });

  console.log(JSON.stringify({
    extensionId: extension.id,
    compact,
    expandedRows,
    primary,
    pageReloaded: true,
    resourcesCleared: cleared,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profileDir, { recursive: true, force: true });
}
