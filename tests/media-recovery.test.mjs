import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import vm from 'node:vm';

const scannerPath = resolve('content/scanner.js');

function createScannerContext(entries) {
  const messages = [];
  const context = {
    URL,
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://example.test/article/1' },
    performance: {
      getEntriesByType(type) {
        return type === 'resource' ? entries : [];
      },
    },
    chrome: {
      runtime: {
        sendMessage(message) {
          messages.push(structuredClone(message));
          return Promise.resolve({ ok: true });
        },
      },
    },
    document: {
      readyState: 'complete',
      body: {},
      querySelectorAll() { return []; },
      addEventListener() {},
    },
    Node: { ELEMENT_NODE: 1 },
    MutationObserver: class {
      observe() {}
      disconnect() {}
    },
    getComputedStyle() { return { backgroundImage: 'none' }; },
    addEventListener() {},
    setTimeout() { return 1; },
    clearTimeout() {},
  };
  context.window = context;
  context.globalThis = context;
  return { context, messages };
}

test('scanner 补注入时从 PerformanceResourceTiming 恢复历史 m3u8 和原始图片 URL', async () => {
  const source = await readFile(scannerPath, 'utf8');
  const entries = [
    { name: 'https://cdn.example.test/book/page-01.jpg?token=old', initiatorType: 'fetch', decodedBodySize: 345678 },
    { name: 'https://hls.example.test/vod/movie.m3u8?auth_key=old', initiatorType: 'xmlhttprequest', decodedBodySize: 2048 },
    { name: 'https://hls.example.test/vod/segment-001.ts?auth_key=old', initiatorType: 'xmlhttprequest', decodedBodySize: 1200000 },
    { name: 'https://cdn.example.test/app.js', initiatorType: 'script', decodedBodySize: 5000 },
  ];
  const { context, messages } = createScannerContext(entries);

  vm.runInNewContext(source, context, { filename: scannerPath });

  const resources = messages.flatMap((message) => message.type === 'DOM_RESOURCES' ? message.resources : []);
  assert.deepEqual(
    resources.map((resource) => resource.url),
    entries.slice(0, 3).map((entry) => entry.name)
  );
  assert.deepEqual(resources.map((resource) => resource.kind), ['image', 'stream', 'video']);
  assert.equal(resources[0].size, 345678);
});

test('adaptive stream resources can be partitioned before batch dispatch', async () => {
  const { partitionAdaptiveStreamResources } = await import('../lib/media-output.js');
  const manifest = { kind: 'stream', ext: 'm3u8', url: 'https://cdn.example.test/movie.m3u8' };
  const image = { kind: 'image', ext: 'jpg', url: 'https://cdn.example.test/cover.jpg' };
  const mp4 = { kind: 'video', ext: 'mp4', url: 'https://cdn.example.test/movie.mp4' };

  assert.deepEqual(partitionAdaptiveStreamResources([manifest, image, mp4]), {
    adaptive: [manifest],
    ordinary: [image, mp4],
  });
});

test('batch download dispatches HLS and DASH through START_DOWNLOAD instead of generic fetch', async () => {
  const popup = await readFile(resolve('ui/popup.js'), 'utf8');
  const batchStart = popup.indexOf('async function batchDownload()');
  const batchEnd = popup.indexOf('async function packageSelectedComic()', batchStart);
  const body = popup.slice(batchStart, batchEnd);

  assert.match(body, /partitionAdaptiveStreamResources/);
  assert.match(body, /type:\s*'START_DOWNLOAD'/);
  assert.match(body, /type:\s*'START_BATCH_DOWNLOAD'/);
  assert.match(body, /resolveFilePath/);
});

test('generic offscreen batch refuses to write an adaptive manifest as a media file', async () => {
  const queue = await readFile(resolve('offscreen/queue.js'), 'utf8');
  const batchStart = queue.indexOf('async function executeBatchTask(task)');
  const batchEnd = queue.indexOf('async function executeStreamTask', batchStart);
  const body = queue.slice(batchStart, batchEnd);

  assert.match(body, /isAdaptiveStreamResource\(res\)/);
  assert.match(body, /must be dispatched through the stream merger/);
});

test('有播放列表时列表隐藏 TS/m4s 分片，但没有播放列表时保留诊断入口', async () => {
  const { suppressRedundantStreamSegments } = await import('../lib/media-resource-view.js');
  const manifest = { url: 'https://cdn.example.test/movie.m3u8', kind: 'stream', ext: 'm3u8' };
  const mpd = { url: 'https://cdn.example.test/movie.mpd', kind: 'stream', ext: 'mpd' };
  const ts = { url: 'https://cdn.example.test/001.ts', kind: 'video', ext: 'ts' };
  const m4s = { url: 'https://cdn.example.test/001.m4s', kind: 'video', ext: 'm4s' };
  const mp4 = { url: 'https://cdn.example.test/movie.mp4', kind: 'video', ext: 'mp4' };

  assert.deepEqual(suppressRedundantStreamSegments([manifest, ts, mp4]), [manifest, mp4]);
  assert.deepEqual(suppressRedundantStreamSegments([mpd, m4s, mp4]), [mpd, mp4]);
  assert.deepEqual(suppressRedundantStreamSegments([ts, m4s, mp4]), [ts, m4s, mp4]);
});

test('有权威主视频时隐藏 blob、Range 小片段和页面辅助视频，只保留可播放成品', async () => {
  const { suppressRedundantStreamSegments } = await import('../lib/media-resource-view.js');
  const primary = {
    url: 'https://v3-dy.douyinvod.com/full.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 39_501_347,
    isPrimaryMedia: true,
  };
  const blob = {
    url: 'blob:https://www.douyin.com/temporary',
    kind: 'stream',
    ext: '',
    size: -1,
  };
  const rangeChunk = {
    url: 'https://v3-dy.douyinvod.com/chunk',
    kind: 'video',
    ext: '',
    size: 1_048_576,
  };
  const uiAnimation = {
    url: 'https://lf-douyin-pc-web.douyinstatic.com/obj/douyin-pc-web/uuu_265.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 199_164,
  };
  const cover = { url: 'https://p3.douyinpic.com/cover.jpeg', kind: 'image', ext: 'jpeg' };

  assert.deepEqual(
    suppressRedundantStreamSegments([rangeChunk, cover, blob, uiAnimation, primary]),
    [cover, primary]
  );
  assert.deepEqual(
    suppressRedundantStreamSegments([blob, rangeChunk]),
    [rangeChunk],
    'MediaSource blob 不是可跨上下文下载的 HLS 清单'
  );
});

test('没有权威主视频时默认只突出一个推荐候选，同时保留展开全部候选的入口', async () => {
  const { buildMediaCandidateView } = await import('../lib/media-resource-view.js');
  const cover = { url: 'https://cdn.example.test/cover.jpg', kind: 'image', ext: 'jpg' };
  const largest = {
    url: 'https://v1.example.test/video.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 90_400_000,
    source: 'network',
    discoveredAt: 20,
  };
  const duplicateCdn = {
    url: 'https://v2.example.test/video.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 90_400_000,
    source: 'network',
    discoveredAt: 10,
  };
  const alternate = {
    url: 'https://v3.example.test/video.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 59_200_000,
    source: 'network',
  };
  const pageAnimation = {
    url: 'https://static.example.test/uuu_265.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 194_500,
    source: 'network',
  };

  const compact = buildMediaCandidateView([cover, duplicateCdn, pageAnimation, alternate, largest]);
  assert.equal(compact.mode, 'recommended');
  assert.equal(compact.hiddenCount, 3);
  assert.deepEqual(compact.resources.map((resource) => resource.url), [cover.url, largest.url]);
  assert.equal(compact.resources[1].mediaCandidateRole, 'recommended');

  const expanded = buildMediaCandidateView(
    [cover, duplicateCdn, pageAnimation, alternate, largest],
    { showSecondary: true }
  );
  assert.equal(expanded.hiddenCount, 3);
  assert.equal(expanded.resources.filter((resource) => resource.kind === 'video').length, 4);
  assert.equal(
    expanded.resources.filter((resource) => resource.mediaCandidateRole === 'recommended').length,
    1,
    '展开后仍必须明确标出唯一的推荐候选'
  );
});

test('权威主视频优先级高于大小启发式，并明确标记为主视频', async () => {
  const { buildMediaCandidateView } = await import('../lib/media-resource-view.js');
  const oversizedNoise = {
    url: 'https://static.example.test/background.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 200_000_000,
  };
  const primary = {
    url: 'https://v3-dy.example.test/full.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 26_414_791,
    isPrimaryMedia: true,
  };

  const view = buildMediaCandidateView([oversizedNoise, primary], { showSecondary: true });
  assert.equal(view.mode, 'primary');
  assert.equal(view.hiddenCount, 0);
  assert.deepEqual(view.resources.map((resource) => resource.url), [primary.url]);
  assert.equal(view.resources[0].mediaCandidateRole, 'primary');
});

test('有效 HLS/DASH 清单优先于页面小型 MP4 动画成为推荐候选', async () => {
  const { buildMediaCandidateView } = await import('../lib/media-resource-view.js');
  const manifest = {
    url: 'https://video.example.test/main.m3u8',
    kind: 'stream',
    ext: 'm3u8',
    size: 2_048,
    source: 'network',
  };
  const pageAnimation = {
    url: 'https://static.example.test/loading.mp4',
    kind: 'video',
    ext: 'mp4',
    size: 220_000,
    source: 'network',
  };

  const view = buildMediaCandidateView([pageAnimation, manifest]);
  assert.equal(view.mode, 'recommended');
  assert.deepEqual(view.resources.map((resource) => resource.url), [manifest.url]);
});

test('结构化媒体的备用地址从 popup 一直透传到 offscreen HttpFetcher', async () => {
  const popup = await readFile(resolve('ui/popup.js'), 'utf8');
  const manager = await readFile(resolve('background/download-manager.js'), 'utf8');
  const start = popup.indexOf('async function startDownload(resource, btn)');
  const end = popup.indexOf('// ─── 批量下载', start);
  const popupBody = popup.slice(start, end > start ? end : undefined);
  const executeStart = manager.indexOf('export async function executeWithHandle');
  const executeEnd = manager.indexOf('/**\n * 取消任务', executeStart);
  const managerBody = manager.slice(executeStart, executeEnd);

  assert.match(popupBody, /backupUrls:\s*Array\.isArray\(outputResource\.backupUrls\)/);
  assert.match(managerBody, /backupUrls:\s*Array\.isArray\(resource\.backupUrls\)/);
});

test('HLS/DASH 清单统一规划为 MP4 输出路径，不沿用清单扩展名', async () => {
  const {
    adaptiveStreamType,
    isAdaptiveStreamResource,
    normalizeAdaptiveStreamOutput,
  } = await import('../lib/media-output.js');

  assert.equal(isAdaptiveStreamResource({ kind: 'stream', ext: 'm3u8' }), true);
  assert.equal(isAdaptiveStreamResource({ kind: 'video', ext: 'mpd' }), true);
  assert.equal(isAdaptiveStreamResource({ kind: 'video', ext: 'mp4' }), false);
  assert.equal(adaptiveStreamType({ kind: 'stream', ext: 'm3u8' }), 'hls');
  assert.equal(adaptiveStreamType({ kind: 'stream', ext: 'mpd' }), 'dash');

  assert.deepEqual(
    normalizeAdaptiveStreamOutput({
      kind: 'stream',
      ext: 'm3u8',
      title: 'movie.m3u8',
      organizedPath: 'WebGrab/视频/example/movie.m3u8',
    }),
    {
      kind: 'stream',
      ext: 'mp4',
      title: 'movie.mp4',
      organizedPath: 'WebGrab/视频/example/movie.mp4',
    }
  );
});
