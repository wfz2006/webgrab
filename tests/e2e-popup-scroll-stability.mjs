/**
 * 真实 Chromium MV3 回归：资源轮询不重置虚拟列表滚动位置，清空后新增资源可从空态恢复。
 * 运行时需通过 NODE_PATH 提供 playwright，并设置 WEBGRAB_CHROME_PATH。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const browserPath = process.env.WEBGRAB_CHROME_PATH;
if (!browserPath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const imageBody = readFileSync(join(extensionPath, 'assets', 'character', 'detective-girl', 'idle.webp'));
const initialImages = Array.from({ length: 80 }, (_, index) => (
  `<img src="/images/page-${String(index + 1).padStart(3, '0')}.webp" alt="page ${index + 1}">`
)).join('');
const server = createServer((request, response) => {
  if (request.url?.split('?')[0].endsWith('.webp')) {
    response.setHeader('content-type', 'image/webp');
    response.setHeader('cache-control', 'public, max-age=3600');
    response.end(imageBody);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><body><h1>Popup scroll fixture</h1>${initialImages}</body></html>`);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const sourceUrl = `http://127.0.0.1:${server.address().port}/`;
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-popup-scroll-e2e-'));
let context;

const waitFor = async (fn, timeoutMs = 20_000) => {
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
  const consoleMessages = [];
  hostPage.on('console', (message) => consoleMessages.push({ type: message.type(), text: message.text() }));
  await hostPage.goto(sourceUrl, { waitUntil: 'load' });
  await hostPage.bringToFront();

  const cdp = await context.browser().newBrowserCDPSession();
  const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (!extension?.id) throw new Error(`CDP 未返回扩展 ID: ${JSON.stringify(extension)}`);

  await waitFor(() => hostPage.evaluate(() => (
    document.getElementById('webgrab-floating-companion')?.shadowRoot?.querySelector('.wg-trigger') || null
  )));
  // 首次安装会打开引导页；真实用户点击桌宠前会先激活宿主页，确保 popup 查询到正确 tabId。
  await hostPage.bringToFront();
  await hostPage.evaluate(() => {
    document.getElementById('webgrab-floating-companion').shadowRoot.querySelector('.wg-trigger').click();
  });
  const popupFrame = await waitFor(() => hostPage.frames().find(
    (frame) => frame.url().includes('/ui/popup.html?embedded=1')
  ));
  await waitFor(async () => popupFrame.evaluate(() => {
    const count = Number(document.querySelector('[data-count="image"]')?.textContent || 0);
    return count >= 70;
  }));

  await popupFrame.locator('[data-kind="image"]').click();
  await popupFrame.locator('#list-container > .list-sizer').waitFor();
  const before = await popupFrame.evaluate(() => {
    const list = document.getElementById('list-container');
    list.scrollTop = 2048;
    list.dispatchEvent(new Event('scroll'));
    window.__webgrabScrollSizer = list.querySelector(':scope > .list-sizer');
    return { scrollTop: list.scrollTop, sizerHeight: window.__webgrabScrollSizer?.style.height || '' };
  });
  if (before.scrollTop <= 0) throw new Error(`测试准备失败，列表没有滚动: ${JSON.stringify(before)}`);

  // 超过 2 秒，确保至少经历一次 loadResources 定时轮询。
  await new Promise((resolveWait) => setTimeout(resolveWait, 2600));
  const afterPoll = await popupFrame.evaluate(() => {
    const list = document.getElementById('list-container');
    return {
      scrollTop: list.scrollTop,
      sameSizer: window.__webgrabScrollSizer === list.querySelector(':scope > .list-sizer'),
    };
  });
  if (Math.abs(afterPoll.scrollTop - before.scrollTop) > 1 || !afterPoll.sameSizer) {
    throw new Error(`资源轮询破坏了滚动位置或 sizer: ${JSON.stringify({ before, afterPoll })}`);
  }

  await popupFrame.locator('#btn-clear').click();
  await waitFor(() => popupFrame.evaluate(() => (
    document.querySelector('#list-container > #empty-state')?.style.display === 'flex'
  )));
  await hostPage.evaluate(() => {
    const image = document.createElement('img');
    image.src = `/images/new-after-clear.webp?${Date.now()}`;
    image.alt = 'resource after clear';
    document.body.append(image);
  });
  const recovered = await waitFor(() => popupFrame.evaluate(() => {
    const list = document.getElementById('list-container');
    const rows = list.querySelectorAll('.resource-item').length;
    return rows > 0 ? {
      rows,
      sizers: list.querySelectorAll(':scope > .list-sizer').length,
      emptyAttached: Boolean(list.querySelector(':scope > #empty-state')),
      imageCount: Number(document.querySelector('[data-count="image"]')?.textContent || 0),
    } : null;
  }), 15_000);
  if (recovered.sizers !== 1 || recovered.emptyAttached || recovered.imageCount < 1) {
    throw new Error(`空态恢复结构异常: ${JSON.stringify(recovered)}`);
  }

  const webgrabErrors = consoleMessages.filter(({ type, text }) => (
    type === 'error' && text.includes('WebGrab')
  ));
  if (webgrabErrors.length) throw new Error(`WebGrab 控制台错误: ${JSON.stringify(webgrabErrors)}`);

  console.log(JSON.stringify({
    extensionId: extension.id,
    initialImageCountAtLeast: 70,
    beforeScrollTop: before.scrollTop,
    afterPollScrollTop: afterPoll.scrollTop,
    sameSizerAfterPoll: afterPoll.sameSizer,
    emptyStateRecovered: true,
    recoveredRows: recovered.rows,
    recoveredImageCount: recovered.imageCount,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profileDir, { recursive: true, force: true });
}
