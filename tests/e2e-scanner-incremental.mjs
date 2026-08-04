/**
 * 真实 Chromium DOM 回归：MutationObserver 只扫描新增节点/属性目标，
 * 不因页面已有媒体数量增长而再次 querySelectorAll 整个 document。
 * 运行时需通过 NODE_PATH 提供 playwright，并设置 WEBGRAB_CHROME_PATH。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
const scannerPath = resolve(extensionPath, 'content', 'scanner.js');
const browserPath = process.env.WEBGRAB_CHROME_PATH;
if (!browserPath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const initialImages = Array.from({ length: 160 }, (_, index) => (
  `<img src="/initial-${String(index + 1).padStart(3, '0')}.jpg" alt="initial ${index + 1}">`
)).join('');
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'text/html; charset=utf-8');
  response.end(`<!doctype html><html><body>${initialImages}</body></html>`);
});

await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const pageUrl = `http://127.0.0.1:${server.address().port}/`;
let browser;

try {
  browser = await chromium.launch({ executablePath: browserPath, headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.goto(pageUrl, { waitUntil: 'load' });
  await page.evaluate(() => {
    window.__webgrabDomMessages = [];
    window.__webgrabDocumentQueries = [];
    const originalQuerySelectorAll = Document.prototype.querySelectorAll;
    Document.prototype.querySelectorAll = function trackedQuerySelectorAll(selector) {
      if (this === document) window.__webgrabDocumentQueries.push(String(selector));
      return originalQuerySelectorAll.call(this, selector);
    };
    const chromeApi = window.chrome || {};
    Object.defineProperty(chromeApi, 'runtime', {
      configurable: true,
      value: {
        sendMessage(message) {
          window.__webgrabDomMessages.push(structuredClone(message));
          return Promise.resolve({ ok: true });
        },
      },
    });
    if (!window.chrome) window.chrome = chromeApi;
  });
  await page.addScriptTag({ path: scannerPath });
  await page.waitForFunction(() => (
    window.__webgrabDomMessages.some((message) => (
      message.type === 'DOM_RESOURCES'
      && message.resources.some((resource) => resource.url.endsWith('/initial-160.jpg'))
    ))
  ));

  const before = await page.evaluate(() => ({
    documentQueries: window.__webgrabDocumentQueries.length,
    reported: window.__webgrabDomMessages.flatMap((message) => message.resources || []).map((item) => item.url),
  }));

  await page.evaluate(() => {
    const wrapper = document.createElement('section');
    wrapper.innerHTML = [
      '<img src="/dynamic-child-1.jpg">',
      '<div><img src="/dynamic-child-2.jpg"></div>',
      '<img id="attribute-target" src="data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==">',
    ].join('');
    document.body.append(wrapper);
    document.getElementById('attribute-target').setAttribute('data-src', '/dynamic-attribute.jpg');
  });

  await page.waitForFunction(() => {
    const urls = window.__webgrabDomMessages.flatMap((message) => message.resources || []).map((item) => item.url);
    return ['/dynamic-child-1.jpg', '/dynamic-child-2.jpg', '/dynamic-attribute.jpg']
      .every((suffix) => urls.some((url) => url.endsWith(suffix)));
  });

  const after = await page.evaluate(() => ({
    documentQueries: window.__webgrabDocumentQueries.length,
    reported: window.__webgrabDomMessages.flatMap((message) => message.resources || []).map((item) => item.url),
  }));
  if (after.documentQueries !== before.documentQueries) {
    throw new Error(`增量 DOM 变化触发了全文档查询: ${JSON.stringify({ before: before.documentQueries, after: after.documentQueries })}`);
  }
  for (const suffix of ['/initial-001.jpg', '/dynamic-child-1.jpg', '/dynamic-child-2.jpg', '/dynamic-attribute.jpg']) {
    const count = after.reported.filter((url) => url.endsWith(suffix)).length;
    if (count !== 1) throw new Error(`资源上报次数异常 ${suffix}: ${count}`);
  }

  console.log(JSON.stringify({
    initialResources: before.reported.length,
    documentQueriesBeforeMutation: before.documentQueries,
    documentQueriesAfterMutation: after.documentQueries,
    dynamicResourcesFound: 3,
    duplicateReports: 0,
  }, null, 2));
} finally {
  await browser?.close().catch(() => {});
  await new Promise((resolveClose) => server.close(resolveClose));
}
