/**
 * 真实站点烟测（不属于默认 node --test）：加载未打包扩展并验证抖音详情页是否
 * 产出结构化主视频候选。运行时需提供 WEBGRAB_CHROME_PATH 和 playwright。
 */
import { createRequire } from 'node:module';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const browserPath = process.env.WEBGRAB_CHROME_PATH;
if (!browserPath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const targetUrl = process.env.WEBGRAB_DOUYIN_URL
  || 'https://www.douyin.com/video/7650385070179519750';
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-douyin-e2e-'));
let context;

const waitFor = async (fn, timeoutMs = 30_000) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = await fn();
    if (value) return value;
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  return null;
};

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: browserPath,
    headless: process.env.WEBGRAB_HEADED !== '1',
    downloadsPath: join(profileDir, 'downloads'),
    ignoreDefaultArgs: ['--disable-extensions'],
    args: [
      '--window-position=-32000,-32000',
      '--window-size=1100,760',
      '--enable-unsafe-extension-debugging',
    ],
  });

  const cdp = await context.browser().newBrowserCDPSession();
  const extension = await cdp.send('Extensions.loadUnpacked', { path: extensionPath });
  if (!extension?.id) throw new Error('加载未打包扩展失败');

  const page = context.pages()[0];
  await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45_000 });

  const extensionPage = await context.newPage();
  await extensionPage.goto(`chrome-extension://${extension.id}/ui/options.html`, {
    waitUntil: 'domcontentloaded',
  });
  const tab = await waitFor(async () => {
    const tabs = await extensionPage.evaluate(() => chrome.tabs.query({ url: '*://*.douyin.com/*' }));
    return tabs.find((candidate) => candidate.url?.includes('/video/')) || null;
  });
  if (!tab?.id) throw new Error('未找到抖音视频标签页');

  const resources = await waitFor(async () => {
    const response = await extensionPage.evaluate(
      (tabId) => chrome.runtime.sendMessage({ type: 'GET_RESOURCES', tabId }),
      tab.id
    );
    const list = response?.data?.resources || [];
    return list.some((resource) => resource.isPrimaryMedia === true) ? list : null;
  });

  const summary = {
    targetUrl,
    pageTitle: await page.title(),
    primary: resources?.filter((resource) => resource.isPrimaryMedia === true).map((resource) => ({
      title: resource.title,
      urlHost: new URL(resource.url).hostname,
      size: resource.size,
      ext: resource.ext,
      width: resource.width,
      height: resource.height,
      backupCount: resource.backupUrls?.length || 0,
    })) || [],
    capturedCount: resources?.length || 0,
  };
  if (!resources) throw new Error('页面在 30 秒内未产出结构化主视频，可能触发登录/验证或站点接口已变化');

  if (process.env.WEBGRAB_VERIFY_DOWNLOAD === '1') {
    const primary = resources.find((resource) => resource.isPrimaryMedia === true);
    const start = await extensionPage.evaluate(
      ({ resource, tabId, pageUrl }) => chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        tabId,
        resource: { ...resource, pageUrl, organizedPath: `WebGrab_E2E/${resource.title}` },
        fileHandleKey: null,
      }),
      { resource: primary, tabId: tab.id, pageUrl: targetUrl }
    );
    if (!start?.ok) throw new Error(`启动真实下载失败: ${start?.error || 'unknown'}`);

    const task = await waitFor(async () => {
      const response = await extensionPage.evaluate(() => chrome.runtime.sendMessage({ type: 'GET_TASKS' }));
      const current = response?.data?.tasks?.find((candidate) => candidate.id === start.data.taskId);
      return current && ['done', 'failed', 'canceled'].includes(current.status) ? current : null;
    }, 90_000);
    if (!task || task.status !== 'done') {
      throw new Error(`真实下载未成功: ${task?.error || task?.status || 'timeout'}`);
    }

    const downloadItem = await waitFor(async () => {
      const items = await extensionPage.evaluate(() => chrome.downloads.search({ state: 'complete' }));
      return items.find((item) => item.url === primary.url || item.finalUrl === primary.url) || null;
    }, 15_000);
    if (!downloadItem?.filename) throw new Error('任务完成但 chrome.downloads 中找不到成品');

    const fileInfo = await stat(downloadItem.filename);
    const bytes = await readFile(downloadItem.filename);
    const hasFtyp = bytes.subarray(0, 64).includes(Buffer.from('ftyp'));
    const hasMdat = bytes.includes(Buffer.from('mdat'));
    const hasMoov = bytes.includes(Buffer.from('moov'));
    if (!hasFtyp || !hasMdat || !hasMoov || fileInfo.size <= 0) {
      throw new Error(`下载文件不是完整 MP4: size=${fileInfo.size} ftyp=${hasFtyp} mdat=${hasMdat} moov=${hasMoov}`);
    }
    summary.download = {
      method: start.data.method,
      taskStatus: task.status,
      bytes: fileInfo.size,
      expectedBytes: primary.size,
      hasFtyp,
      hasMdat,
      hasMoov,
    };
  }

  console.log(JSON.stringify(summary, null, 2));
} finally {
  await context?.close().catch(() => {});
  await rm(profileDir, { recursive: true, force: true });
}
