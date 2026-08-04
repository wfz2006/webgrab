/**
 * 浏览器级烟测：扩展重新加载后，不刷新已经打开的页面，验证悬浮面板与 scanner
 * 都由新实例接管。运行时需通过 NODE_PATH 提供 playwright。
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
const server = createServer((request, response) => {
  if (request.url?.split('?')[0].endsWith('.webp')) {
    response.setHeader('content-type', 'image/webp');
    response.end(imageBody);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><body><h1>Recovery fixture</h1><img src="/existing.webp" alt="existing resource"></body></html>');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const sourceUrl = `http://127.0.0.1:${server.address().port}/`;
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-recovery-e2e-'));
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
  hostPage.on('console', (message) => {
    consoleMessages.push({ type: message.type(), text: message.text() });
  });
  await hostPage.goto(sourceUrl, { waitUntil: 'load' });
  await hostPage.bringToFront();
  const marker = `marker-${Date.now()}`;
  const before = await hostPage.evaluate((value) => {
    window.__webgrabRecoveryE2EMarker = value;
    return { marker: window.__webgrabRecoveryE2EMarker, timeOrigin: performance.timeOrigin, href: location.href };
  }, marker);

  // 页面已经打开后才安装扩展，精确复现“旧标签页没有 manifest content script”的场景。
  const cdp = await context.browser().newBrowserCDPSession();
  const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (!extension?.id) throw new Error(`CDP 未返回扩展 ID: ${JSON.stringify(extension)}`);

  const openExtensionPage = async () => {
    const page = await context.newPage();
    let lastError = '';
    await waitFor(async () => {
      try {
        await page.goto(`chrome-extension://${extension.id}/ui/popup.html`, { waitUntil: 'domcontentloaded' });
        return true;
      } catch (error) {
        lastError = error.message || String(error);
        return false;
      }
    }).catch((error) => {
      throw new Error(`扩展页不可访问: ${lastError}`, { cause: error });
    });
    return page;
  };

  const extensionPage = await openExtensionPage();
  const worker = await waitFor(() => context.serviceWorkers()[0]);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, sourceUrl);
  if (!Number.isInteger(tabId)) throw new Error('找不到旧标签页');

  const getResources = (page) => page.evaluate(
    async (targetTabId) => (await chrome.runtime.sendMessage({ type: 'GET_RESOURCES', tabId: targetTabId })).data.resources,
    tabId
  );
  const installRecovered = await waitFor(async () => {
    const resources = await getResources(extensionPage);
    return resources.some((resource) => resource.url.endsWith('/existing.webp')) ? resources : null;
  });

  const openPanelAndRefreshTasks = async () => {
    await hostPage.evaluate(() => {
      const companion = document.getElementById('webgrab-floating-companion');
      const trigger = companion?.shadowRoot?.querySelector('.wg-trigger');
      if (!trigger) throw new Error('找不到悬浮窗触发按钮');
      trigger.click();
    });
    await waitFor(() => hostPage.evaluate(() => {
      const panel = document.getElementById('webgrab-floating-companion')?.shadowRoot?.querySelector('.wg-panel');
      return panel && !panel.hidden;
    }));
    const popupFrame = await waitFor(() => hostPage.frames().find(
      (frame) => frame.url().includes('/ui/popup.html?embedded=1')
    ));
    await waitFor(async () => popupFrame.evaluate(() => typeof window.webgrabTasks?.refresh === 'function'));
    await popupFrame.evaluate(() => window.webgrabTasks.refresh());
  };

  // 先证明重载前这套内容脚本和悬浮面板确实是正常工作的旧实例。
  await openPanelAndRefreshTasks();
  await extensionPage.evaluate(
    (targetTabId) => chrome.runtime.sendMessage({ type: 'CLEAR_TAB', tabId: targetTabId }),
    tabId
  );
  if ((await getResources(extensionPage)).length !== 0) throw new Error('测试准备失败：资源表未清空');

  // 对同一路径再次 loadUnpacked 是该 Chromium 自动化环境支持的重载入口。
  const reloadedExtension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (reloadedExtension.id !== extension.id) {
    throw new Error(`重载后扩展 ID 变化: ${extension.id} -> ${reloadedExtension.id}`);
  }
  await new Promise((resolveWait) => setTimeout(resolveWait, 500));
  const reloadedExtensionPage = await openExtensionPage();
  const updateRecovered = await waitFor(async () => {
    try {
      const resources = await getResources(reloadedExtensionPage);
      return resources.some((resource) => resource.url.endsWith('/existing.webp')) ? resources : null;
    } catch {
      return null;
    }
  });
  await waitFor(() => hostPage.locator('#webgrab-floating-companion').count().then((count) => count === 1));

  // 只观察新实例接管后的交互，旧 iframe 在恢复流程中应已随陈旧宿主一起移除。
  consoleMessages.length = 0;
  await openPanelAndRefreshTasks();
  await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  const invalidatedErrors = consoleMessages.filter(({ text }) => (
    text.includes('Extension context invalidated')
    || text.includes('[WebGrab/TaskPanel] 拉取任务失败')
  ));
  if (invalidatedErrors.length > 0) {
    throw new Error(`重载后悬浮面板仍使用失效上下文: ${JSON.stringify(invalidatedErrors)}`);
  }

  await hostPage.evaluate(() => {
    const image = document.createElement('img');
    image.src = `/after-update.webp?${Date.now()}`;
    image.alt = 'resource added after extension update';
    document.body.append(image);
  });
  const dynamicallyRecovered = await waitFor(async () => {
    const resources = await getResources(reloadedExtensionPage);
    const resource = resources.find((candidate) => candidate.url.includes('/after-update.webp'));
    return resource && Number.isFinite(resource.domIndex) ? resource : null;
  });
  const after = await hostPage.evaluate(() => ({
    marker: window.__webgrabRecoveryE2EMarker,
    timeOrigin: performance.timeOrigin,
    href: location.href,
  }));

  if (after.marker !== before.marker || after.timeOrigin !== before.timeOrigin || after.href !== before.href) {
    throw new Error(`旧标签页发生了导航或刷新: ${JSON.stringify({ before, after })}`);
  }
  const companionHosts = await hostPage.locator('#webgrab-floating-companion').count();
  if (companionHosts !== 1) throw new Error(`悬浮窗重复注入: ${companionHosts}`);
  const installedExisting = installRecovered.filter((resource) => resource.url.endsWith('/existing.webp'));
  const updatedExisting = updateRecovered.filter((resource) => resource.url.endsWith('/existing.webp'));
  if (installedExisting.length !== 1 || installedExisting[0].source !== 'dom'
      || updatedExisting.length !== 1 || updatedExisting[0].source !== 'dom') {
    throw new Error(`DOM 自愈扫描结果异常: ${JSON.stringify({ installedExisting, updatedExisting })}`);
  }
  if (!Number.isFinite(dynamicallyRecovered.domIndex)) {
    throw new Error(`重载后的 scanner 未捕获新资源: ${JSON.stringify(dynamicallyRecovered)}`);
  }

  console.log(JSON.stringify({
    extensionId: extension.id,
    pageReloaded: false,
    installRecoveredDomResources: installedExisting.length,
    updateRecoveredDomResources: updatedExisting.length,
    recoveredSource: updatedExisting[0].source,
    panelRefreshAfterReload: 'ok',
    invalidatedErrors: invalidatedErrors.length,
    dynamicResourceRecovered: true,
    markerPreserved: true,
    companionHosts,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profileDir, { recursive: true, force: true });
}
