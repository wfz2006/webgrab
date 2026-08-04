/**
 * 浏览器级烟测：真实加载 MV3 扩展，验证嵌套角色资源、options 切换、
 * 六状态联动和 reduced-motion。运行时需通过 NODE_PATH 提供 playwright。
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
const chromePath = process.env.WEBGRAB_CHROME_PATH;
if (!chromePath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const imageBody = readFileSync(join(extensionPath, 'assets', 'character', 'detective-girl', 'idle.webp'));
const server = createServer((request, response) => {
  if (request.url?.startsWith('/resource-')) {
    response.setHeader('content-type', 'image/webp');
    response.end(imageBody);
    return;
  }
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end('<!doctype html><html><body><h1>WebGrab companion smoke</h1><img src="/resource-1.webp" alt="test"></body></html>');
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const sourceUrl = `http://127.0.0.1:${server.address().port}/`;
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-character-e2e-'));
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

const companionSnapshot = (page) => page.evaluate(() => {
  const host = document.querySelector('#webgrab-floating-companion');
  const shell = host?.shadowRoot?.querySelector('.wg-shell');
  const sprite = host?.shadowRoot?.querySelector('.wg-sprite');
  const badge = host?.shadowRoot?.querySelector('.wg-badge');
  const progress = host?.shadowRoot?.querySelector('.wg-progress');
  return host && shell && sprite ? {
    hidden: host.hidden || getComputedStyle(host).display === 'none',
    phase: shell.dataset.phase,
    shellAnimation: getComputedStyle(shell).animationName,
    spriteAnimation: getComputedStyle(sprite).animationName,
    spriteImage: getComputedStyle(sprite).backgroundImage,
    badge: badge?.textContent || '',
    progressOpacity: progress ? getComputedStyle(progress).opacity : '',
    size: [shell.getBoundingClientRect().width, shell.getBoundingClientRect().height],
  } : null;
});

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: process.env.WEBGRAB_HEADED !== '1',
    args: [
      '--window-position=-32000,-32000',
      '--window-size=960,720',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const extensionsPage = await context.newPage();
  await extensionsPage.goto('chrome://extensions/', { waitUntil: 'domcontentloaded' });
  const installed = await waitFor(() => extensionsPage.evaluate(() => {
    const manager = document.querySelector('extensions-manager');
    const list = manager?.shadowRoot?.querySelector('extensions-item-list');
    const items = Array.from(list?.shadowRoot?.querySelectorAll('extensions-item') || []).map((item) => ({
      id: item.id,
      name: item.shadowRoot?.querySelector('#name')?.textContent?.trim() || '',
    }));
    return items.length ? items : null;
  }));
  const extension = installed.find((item) => item.name.includes('WebGrab'));
  if (!extension) throw new Error(`浏览器未加载 WebGrab: ${JSON.stringify(installed)}`);

  const optionsPage = await context.newPage();
  await optionsPage.goto(`chrome-extension://${extension.id}/ui/options.html`, { waitUntil: 'domcontentloaded' });
  await optionsPage.waitForFunction(() => document.querySelector('#companion-character')?.options.length === 2);
  const options = await optionsPage.locator('#companion-character option').allTextContents();
  if (options.join('|') !== '默认占位角色|蜜糖侦探') throw new Error(`角色下拉框错误: ${options.join('|')}`);
  if (await optionsPage.locator('#companion-character').inputValue() !== 'assets/character/detective-girl') {
    throw new Error('新角色没有成为 options 默认值');
  }

  const page = context.pages()[0];
  await page.goto(sourceUrl, { waitUntil: 'load' });
  const worker = await waitFor(() => context.serviceWorkers()[0]);
  const tabId = await worker.evaluate(async (url) => (await chrome.tabs.query({ url }))[0]?.id, sourceUrl);
  if (!Number.isInteger(tabId)) throw new Error('找不到测试页面标签');

  await waitFor(async () => {
    const value = await companionSnapshot(page);
    return value && !value.hidden ? value : null;
  });
  await page.waitForTimeout(1_050);
  let state = await companionSnapshot(page);
  if (!state.spriteImage.includes('/assets/character/detective-girl/idle.webp')) {
    throw new Error(`默认角色资源错误: ${state.spriteImage}`);
  }
  if (state.size[0] !== 120 || state.size[1] !== 160 || !state.shellAnimation.includes('webgrab-breathe')) {
    throw new Error(`默认尺寸或呼吸动画错误: ${JSON.stringify(state)}`);
  }
  const imageCheck = await page.evaluate(async () => {
    const sprite = document.querySelector('#webgrab-floating-companion')?.shadowRoot?.querySelector('.wg-sprite');
    const url = getComputedStyle(sprite).backgroundImage.match(/url\(["']?(.+?)["']?\)/)?.[1];
    const image = new Image();
    const loaded = new Promise((resolveLoad) => {
      image.onload = () => resolveLoad({ ok: true, width: image.naturalWidth, height: image.naturalHeight });
      image.onerror = () => resolveLoad({ ok: false, width: 0, height: 0 });
    });
    image.src = url;
    return loaded;
  });
  if (!imageCheck.ok || imageCheck.width !== 120 || imageCheck.height !== 160) {
    throw new Error(`嵌套 web_accessible_resources 加载失败: ${JSON.stringify(imageCheck)}`);
  }

  const sendTask = (status, extra = {}) => optionsPage.evaluate(({ tabId: targetTabId, status: nextStatus, extra: rest }) => (
    chrome.runtime.sendMessage({
      type: 'TASK_UPDATE',
      task: { id: 'character-e2e-task', tabId: targetTabId, status: nextStatus, total: 10, downloaded: 0, ...rest },
    })
  ), { tabId, status, extra });
  for (const [status, phase, extra] of [
    ['extracting', 'scanning', {}],
    ['downloading', 'downloading', { downloaded: 4 }],
    ['done', 'done', { downloaded: 10 }],
    ['failed', 'error', { error: 'E2E failure' }],
  ]) {
    await sendTask(status, extra);
    state = await waitFor(async () => {
      const value = await companionSnapshot(page);
      if (value?.phase !== phase) return null;
      if (phase === 'downloading' && value.progressOpacity !== '1') return null;
      return value;
    });
    if (!state.spriteImage.includes(`/assets/character/detective-girl/${phase === 'scanning' ? 'scanning' : phase}.webp`)) {
      throw new Error(`${phase} 状态素材错误: ${state.spriteImage}`);
    }
  }

  await page.evaluate(() => {
    const image = document.createElement('img');
    image.src = `/resource-${Date.now()}.webp`;
    document.body.append(image);
  });
  state = await waitFor(async () => {
    const value = await companionSnapshot(page);
    return value?.phase === 'found' ? value : null;
  });
  if (!state.spriteImage.includes('/assets/character/detective-girl/found.webp')) throw new Error('found 状态素材错误');
  const resourcesResponse = await optionsPage.evaluate((targetTabId) => chrome.runtime.sendMessage({ type: 'GET_RESOURCES', tabId: targetTabId }), tabId);
  if (state.badge !== String(resourcesResponse.data.resources.length)) {
    throw new Error(`角标与资源数不一致: ${state.badge}/${resourcesResponse.data.resources.length}`);
  }

  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForTimeout(50);
  state = await companionSnapshot(page);
  if (state.shellAnimation !== 'none' || state.spriteAnimation !== 'none') {
    throw new Error(`reduced-motion 未关闭动画: ${JSON.stringify(state)}`);
  }
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  await optionsPage.selectOption('#companion-character', 'assets/character');
  await optionsPage.locator('form').evaluate((form) => form.requestSubmit());
  await waitFor(async () => (await companionSnapshot(page))?.spriteImage.includes(`chrome-extension://${extension.id}/assets/character/error.webp`));
  await optionsPage.selectOption('#companion-character', 'assets/character/detective-girl');
  await optionsPage.locator('form').evaluate((form) => form.requestSubmit());
  await waitFor(async () => (await companionSnapshot(page))?.spriteImage.includes('/assets/character/detective-girl/error.webp'));

  console.log(JSON.stringify({
    extensionId: extension.id,
    options,
    nestedWar: imageCheck,
    badge: state.badge,
    phases: ['idle', 'scanning', 'found', 'downloading', 'done', 'error'],
    reducedMotion: true,
    characterSwitch: true,
  }, null, 2));
} finally {
  await context?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
  await rm(profileDir, { recursive: true, force: true });
}
