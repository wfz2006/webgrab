/**
 * 浏览器级流式内存烟测：真实加载 MV3 扩展，在扩展页面使用 OPFS 提供的
 * FileSystemWritableFileStream 打包约 40 MiB 图片响应，检查堆峰值不随总输入线性增长。
 */
import { createRequire } from 'node:module';
import { createServer } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const chromePath = process.env.WEBGRAB_CHROME_PATH;
if (!chromePath) throw new Error('缺少 WEBGRAB_CHROME_PATH');

const pageBytes = Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="600" height="800"><rect width="600" height="800" fill="#456"/>${' '.repeat(512 * 1024)}</svg>`
);
const server = createServer((_request, response) => {
  response.setHeader('content-type', 'image/svg+xml');
  response.setHeader('content-length', String(pageBytes.length));
  response.end(pageBytes);
});
await new Promise((resolveListen) => server.listen(0, '127.0.0.1', resolveListen));
const port = server.address().port;
const profileDir = await mkdtemp(join(tmpdir(), 'webgrab-package-memory-'));
const extensionPath = resolve(fileURLToPath(new URL('..', import.meta.url)));
let context;

try {
  context = await chromium.launchPersistentContext(profileDir, {
    executablePath: chromePath,
    headless: true,
    args: [
      '--js-flags=--expose-gc',
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
    ],
  });
  const worker = await context.waitForEvent('serviceworker', { timeout: 10_000 }).catch(() => context.serviceWorkers()[0]);
  if (!worker) throw new Error('扩展 Service Worker 未启动');
  const extensionId = new URL(worker.url()).host;
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extensionId}/offscreen/downloader.html`);
  const result = await page.evaluate(async ({ port: serverPort }) => {
    const { packageComic } = await import('./comic-packager.js');
    const root = await navigator.storage.getDirectory();
    await root.removeEntry('p4-2-memory', { recursive: true }).catch(() => {});
    const output = await root.getDirectoryHandle('p4-2-memory', { create: true });
    const resources = Array.from({ length: 80 }, (_, index) => ({
      url: `http://127.0.0.1:${serverPort}/page-${index + 1}.svg`,
      title: `${index + 1}.svg`,
      ext: 'svg',
      domIndex: index,
    }));
    globalThis.gc?.();
    const baseline = performance.memory?.usedJSHeapSize || 0;
    let peak = baseline;
    const packageResult = await packageComic({
      resources,
      mode: 'cbz',
      directoryHandle: output,
      title: 'memory-smoke',
      source: '',
      onProgress: () => {
        globalThis.gc?.();
        peak = Math.max(peak, performance.memory?.usedJSHeapSize || baseline);
      },
    });
    globalThis.gc?.();
    const end = performance.memory?.usedJSHeapSize || 0;
    const archive = await (await output.getFileHandle('memory-smoke.cbz')).getFile();
    await root.removeEntry('p4-2-memory', { recursive: true });
    return { ...packageResult, baseline, peak, end, archiveSize: archive.size };
  }, { port });

  const inputBytes = 80 * pageBytes.length;
  const peakGrowth = result.peak - result.baseline;
  if (result.successCount !== 80 || result.archiveSize < inputBytes * 0.95) {
    throw new Error(`流式产物不完整: ${JSON.stringify(result)}`);
  }
  if (peakGrowth >= inputBytes * 0.5) {
    throw new Error(`堆增长接近总输入，疑似全量缓存: ${JSON.stringify({ inputBytes, peakGrowth, result })}`);
  }
  console.log(JSON.stringify({ inputBytes, peakGrowth, ...result }, null, 2));
} finally {
  await context?.close().catch(() => {});
  server.close();
  await rm(profileDir, { recursive: true, force: true });
}
