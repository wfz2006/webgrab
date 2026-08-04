import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const probePath = path.join(root, 'content', 'douyin-probe.js');

function detailFixture() {
  return {
    status_code: 0,
    aweme_detail: {
      aweme_id: '7650385070179519750',
      desc: '兼容下载测试：作品',
      video: {
        width: 1280,
        height: 720,
        duration: 215186,
        play_addr: {
          url_list: ['https://v9-dy.douyinvod.com/hevc-play.mp4'],
          data_size: 41_000_000,
        },
        play_addr_h264: {
          url_list: [
            'https://v3-dy.douyinvod.com/h264-play.mp4',
            'https://backup.douyinvod.com/h264-play.mp4',
          ],
          data_size: 39_501_347,
        },
        download_addr: {
          url_list: ['https://v3-dy.douyinvod.com/watermarked.mp4'],
          data_size: 40_000_000,
        },
        bit_rate: [{
          gear_name: 'normal_1080_0',
          bit_rate: 2_000_000,
          is_h265: 1,
          play_addr: {
            url_list: ['https://v9-dy.douyinvod.com/hevc-1080.mp4'],
            data_size: 42_000_000,
          },
        }],
      },
    },
  };
}

function feedFixture(items) {
  return {
    status_code: 0,
    aweme_list: items.map(({ id, desc = '信息流测试作品' }) => ({
      aweme_id: id,
      desc,
      video: {
        width: 1080,
        height: 1920,
        duration: 15000,
        play_addr_h264: {
          url_list: [`https://v3-dy.douyinvod.com/h264-${id}.mp4`],
          data_size: 5_000_000,
        },
      },
    })),
  };
}

function createProbeContext() {
  const messages = [];
  let detailResponse = detailFixture();
  const originalFetch = async (input) => ({
    clone() {
      return { json: async () => structuredClone(detailResponse) };
    },
    url: String(input),
  });
  const listeners = new Map();
  const context = {
    URL,
    Promise,
    console: { log() {}, warn() {}, error() {} },
    location: { href: 'https://www.douyin.com/video/7650385070179519750' },
    fetch: originalFetch,
    postMessage(message) { messages.push(structuredClone(message)); },
    setTimeout,
    clearTimeout,
    addEventListener(type, handler) {
      if (!listeners.has(type)) listeners.set(type, []);
      listeners.get(type).push(handler);
    },
    // 抖音是用 history.replaceState 把 modal_id 补进 URL 的（真机实测）
    history: { pushState() {}, replaceState() {} },
  };
  context.window = context;
  context.globalThis = context;
  return {
    context,
    messages,
    setDetailResponse(value) { detailResponse = value; },
    /** 模拟用户点开某条视频：页面改 URL 并 replaceState */
    openModal(awemeId) {
      const base = context.location.href.split('?')[0];
      context.location.href = awemeId ? `${base}?modal_id=${awemeId}` : base;
      context.history.replaceState(null, '', context.location.href);
    },
  };
}

test('抖音详情响应产出一个可直接下载的 H.264 主视频，而不是 blob 或页面动画', async () => {
  assert.equal(fs.existsSync(probePath), true, '缺少抖音 MAIN-world 探针');
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  await context.fetch('https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7650385070179519750');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const mediaMessages = messages.filter((message) => message.type === 'resource');
  assert.equal(mediaMessages.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(mediaMessages[0].data)), {
    url: 'https://v3-dy.douyinvod.com/h264-play.mp4',
    backupUrls: ['https://backup.douyinvod.com/h264-play.mp4'],
    kind: 'video',
    ext: 'mp4',
    mime: 'video/mp4',
    size: 39_501_347,
    title: '兼容下载测试：作品.mp4',
    width: 1280,
    height: 720,
    duration: 215186,
    isPrimaryMedia: true,
    mediaId: '7650385070179519750',
  });
});

test('抖音探针只解析作品详情接口，普通 JSON 请求不会制造视频资源', async () => {
  assert.equal(fs.existsSync(probePath), true, '缺少抖音 MAIN-world 探针');
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  await context.fetch('https://www.douyin.com/aweme/v1/web/comment/list/?aweme_id=7650385070179519750');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.filter((message) => message.type === 'resource').length, 0);
});

test('同一作品的详情响应重复到达时只发布一个主视频', async () => {
  assert.equal(fs.existsSync(probePath), true, '缺少抖音 MAIN-world 探针');
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });
  const detailUrl = 'https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=7650385070179519750';

  await context.fetch(detailUrl);
  await context.fetch(detailUrl);
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.filter((message) => message.type === 'resource').length, 1);
});

test('真机实测：点开视频弹层走的是 module/feed 批量接口，返回 aweme_list 时按 URL 上的 modal_id 精确挑出正在看的那一条', async () => {
  assert.equal(fs.existsSync(probePath), true, '缺少抖音 MAIN-world 探针');
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  // module/feed 一次会带回当前视频 + 若干条预加载的相关推荐，正在看的那条
  // 由 URL 上的 modal_id 决定，不一定是数组第一项。
  setDetailResponse(feedFixture([
    { id: '7000000000000000001', desc: '预加载的相关推荐A' },
    { id: '7663071793392913704', desc: '用户正在看的这条' },
    { id: '7000000000000000002', desc: '预加载的相关推荐B' },
  ]));
  context.location.href = 'https://www.douyin.com/jingxuan?modal_id=7663071793392913704';

  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const mediaMessages = messages.filter((message) => message.type === 'resource');
  assert.equal(mediaMessages.length, 1);
  assert.equal(mediaMessages[0].data.mediaId, '7663071793392913704');
  assert.equal(mediaMessages[0].data.title, '用户正在看的这条.mp4');
  assert.equal(mediaMessages[0].data.url, 'https://v3-dy.douyinvod.com/h264-7663071793392913704.mp4');
});

test('module/feed 响应到达但 URL 上没有 modal_id（普通滚动加载信息流）时不产出任何资源', async () => {
  assert.equal(fs.existsSync(probePath), true, '缺少抖音 MAIN-world 探针');
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  setDetailResponse(feedFixture([
    { id: '7000000000000000001' },
    { id: '7000000000000000002' },
  ]));
  context.location.href = 'https://www.douyin.com/jingxuan';

  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.filter((message) => message.type === 'resource').length, 0);
});

test('module/feed 响应里找不到 modal_id 对应的条目时（例如弹层已经切走）不产出任何资源', async () => {
  assert.equal(fs.existsSync(probePath), true, '缺少抖音 MAIN-world 探针');
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  setDetailResponse(feedFixture([{ id: '7000000000000000001' }]));
  context.location.href = 'https://www.douyin.com/jingxuan?modal_id=9999999999999999999';

  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.filter((message) => message.type === 'resource').length, 0);
});

test('manifest 与恢复注入表声明抖音探针，且 bridge 接受通用结构化资源事件', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const entry = manifest.content_scripts.find((item) => item.js?.includes('content/douyin-probe.js'));
  assert.deepEqual(entry, {
    matches: ['*://*.douyin.com/*'],
    js: ['content/douyin-probe.js'],
    run_at: 'document_start',
    world: 'MAIN',
    all_frames: false,
  });

  const { CONTENT_SCRIPT_RECOVERY_RULES } = await import('../background/content-script-recovery.js');
  assert.ok(CONTENT_SCRIPT_RECOVERY_RULES.some((rule) => (
    rule.files.includes('content/douyin-probe.js')
    && rule.world === 'MAIN'
    && rule.allFrames === false
    && rule.installFlag === '__webgrabDouyinProbeInstalled'
  )));

  const bridge = fs.readFileSync(path.join(root, 'content', 'bridge.js'), 'utf8');
  assert.match(bridge, /case\s+['"]resource['"]/);
  assert.match(bridge, /isPrimaryMedia:\s*data\.isPrimaryMedia\s*===\s*true/);
});

test('真机实测时序：首屏 module/feed 到达时 URL 上还没有 modal_id，用户之后点开某条时才把缓存里对应的那条发布出去', async () => {
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse, openModal } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  // 页面初始加载：一次性取回整屏信息流，此时用户还没点任何东西。
  setDetailResponse(feedFixture([
    { id: '7000000000000000001', desc: '首屏第一条' },
    { id: '7664340755343007650', desc: '用户稍后点开的这条' },
    { id: '7000000000000000002', desc: '首屏第三条' },
  ]));
  context.location.href = 'https://www.douyin.com/jingxuan';

  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(
    messages.filter((m) => m.type === 'resource').length,
    0,
    '还不知道用户要看哪条，此时不能报任何资源'
  );

  // 几十秒后用户点开其中一条：抖音不再发请求，只用 replaceState 补上 modal_id。
  openModal('7664340755343007650');
  await new Promise((resolve) => setTimeout(resolve, 0));

  const media = messages.filter((m) => m.type === 'resource');
  assert.equal(media.length, 1, '点开后必须把缓存里对应的那条发布出去');
  assert.equal(media[0].data.mediaId, '7664340755343007650');
  assert.equal(media[0].data.title, '用户稍后点开的这条.mp4');
  assert.equal(media[0].data.url, 'https://v3-dy.douyinvod.com/h264-7664340755343007650.mp4');
  assert.equal(media[0].data.isPrimaryMedia, true);
});

test('用户点开的作品不在缓存里时不产出资源，也不影响之后点开缓存中的作品', async () => {
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse, openModal } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  setDetailResponse(feedFixture([{ id: '7000000000000000001', desc: '缓存里的唯一一条' }]));
  context.location.href = 'https://www.douyin.com/jingxuan';
  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  openModal('9999999999999999999'); // 缓存里没有
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(messages.filter((m) => m.type === 'resource').length, 0);

  openModal('7000000000000000001'); // 缓存里有
  await new Promise((resolve) => setTimeout(resolve, 0));
  const media = messages.filter((m) => m.type === 'resource');
  assert.equal(media.length, 1);
  assert.equal(media[0].data.mediaId, '7000000000000000001');
});

test('在同一条作品上反复触发 URL 变化只发布一次', async () => {
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse, openModal } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });

  setDetailResponse(feedFixture([{ id: '7000000000000000001' }]));
  context.location.href = 'https://www.douyin.com/jingxuan';
  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  openModal('7000000000000000001');
  openModal('7000000000000000001');
  openModal('7000000000000000001');
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(messages.filter((m) => m.type === 'resource').length, 1);
});

test('缓存有上限，无限滚动持续追加时不会无界增长（最早的条目被丢弃）', async () => {
  const source = fs.readFileSync(probePath, 'utf8');
  const { context, messages, setDetailResponse, openModal } = createProbeContext();
  vm.runInNewContext(source, context, { filename: probePath });
  context.location.href = 'https://www.douyin.com/jingxuan';

  // 探针上限是 200 条；分批灌入 210 条，最早的 10 条应当已被丢弃。
  const firstId = '7100000000000000000';
  setDetailResponse(feedFixture([{ id: firstId, desc: '最早的一条' }]));
  await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
  await new Promise((resolve) => setTimeout(resolve, 0));

  for (let batch = 0; batch < 21; batch++) {
    setDetailResponse(feedFixture(
      Array.from({ length: 10 }, (_, i) => ({ id: `72${String(batch * 10 + i).padStart(16, '0')}` }))
    ));
    await context.fetch('https://www.douyin.com/aweme/v2/web/module/feed/?module_id=3003101');
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  openModal(firstId);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.equal(
    messages.filter((m) => m.type === 'resource').length,
    0,
    '超出上限被淘汰的旧条目不该再发布，这正是内存有界的证明'
  );
});
