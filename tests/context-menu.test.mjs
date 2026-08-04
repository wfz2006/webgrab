import test from 'node:test';
import assert from 'node:assert/strict';

const sessionStore = {};
const localStore = {};
const badgeTexts = new Map();
const createdMenus = [];
const downloadCalls = [];

globalThis.chrome = {
  contextMenus: {
    removeAll(cb) { cb?.(); },
    create(options) { createdMenus.push(options); },
    onClicked: { addListener() {} },
  },
  storage: {
    session: {
      async get(key) { return { [key]: sessionStore[key] }; },
      async set(obj) { Object.assign(sessionStore, obj); },
    },
    local: {
      async get(key) {
        if (Array.isArray(key)) return Object.fromEntries(key.map((k) => [k, localStore[k]]));
        return { [key]: localStore[key] };
      },
      async set(obj) { Object.assign(localStore, obj); },
    },
    onChanged: { addListener() {}, removeListener() {} },
  },
  action: {
    async setBadgeText({ text, tabId }) { badgeTexts.set(tabId, text); },
    async setBadgeBackgroundColor() {},
  },
  downloads: {
    download(options, cb) { downloadCalls.push(options); cb?.(downloadCalls.length); },
    // startDownloadAndWait 在拿到 downloadId 后会主动 search 一次兜底终态，
    // 模拟下载已经瞬间完成，避免测试真的等 onChanged 事件或 5 分钟超时。
    search: async ({ id }) => [{ id, state: 'complete' }],
    onChanged: { addListener() {}, removeListener() {} },
  },
  declarativeNetRequest: {
    updateSessionRules: async () => {},
    getSessionRules: async () => [],
  },
  runtime: {
    lastError: null,
    getURL(path) { return `chrome-extension://test/${path}`; },
    id: 'test-extension-id',
  },
  i18n: { getMessage: () => '用 WebGrab 下载' },
};

const { registerContextMenu, handleContextMenuClick } = await import('../background/context-menu.js');

test('注册右键菜单：唯一入口，覆盖图片/视频/音频三种上下文', () => {
  registerContextMenu();
  assert.equal(createdMenus.length, 1);
  assert.equal(createdMenus[0].id, 'webgrab-context-download');
  assert.deepEqual(createdMenus[0].contexts, ['image', 'video', 'audio']);
});

test('点击其他菜单项时不触发下载', async () => {
  downloadCalls.length = 0;
  await handleContextMenuClick({ menuItemId: 'not-ours', srcUrl: 'https://a.test/x.png' }, { id: 1, url: 'https://a.test/' });
  assert.equal(downloadCalls.length, 0);
});

test('右键图片触发下载，且落地文件名走命名模板（不是裸 URL）', async () => {
  downloadCalls.length = 0;
  await handleContextMenuClick(
    { menuItemId: 'webgrab-context-download', srcUrl: 'https://cdn.test/photo.png', mediaType: 'image', pageUrl: 'https://a.test/gallery' },
    { id: 42, url: 'https://a.test/gallery' }
  );
  assert.equal(downloadCalls.length, 1);
  assert.equal(downloadCalls[0].url, 'https://cdn.test/photo.png');
  assert.match(downloadCalls[0].filename, /photo\.png$/);
  assert.match(downloadCalls[0].filename, /^WebGrab\/图片\//);
  assert.equal(badgeTexts.get(42), '1');
});
