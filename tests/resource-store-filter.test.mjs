import test from 'node:test';
import assert from 'node:assert/strict';

const sessionStore = {};
const localStore = {};
const badgeTexts = new Map();
let changedListener = null;

globalThis.chrome = {
  storage: {
    session: {
      async get(key) {
        if (key == null) return structuredClone(sessionStore);
        return { [key]: sessionStore[key] };
      },
      async set(obj) { Object.assign(sessionStore, obj); },
      async remove(key) { delete sessionStore[key]; },
    },
    local: {
      async get(key) { return { [key]: localStore[key] }; },
      async set(obj) { Object.assign(localStore, obj); },
    },
    onChanged: {
      addListener(listener) { changedListener = listener; },
      removeListener() { changedListener = null; },
    },
  },
  action: {
    async setBadgeText({ text, tabId }) { badgeTexts.set(tabId, text); },
    async setBadgeBackgroundColor() {},
  },
};

const store = await import('../background/resource-store.js');
// 模块顶层的 loadResourceFilters().then(...) 是异步的，等一轮微任务确保默认过滤规则已生效。
await new Promise((resolve) => setTimeout(resolve, 0));

test('入库前按过滤规则拦截，badge 计数与列表天然一致', async () => {
  const tabId = 900;
  await store.addResource({ tabId, url: 'https://a.test/keep.png', ext: 'png', mime: 'image/png', size: 1000, kind: 'image', source: 'network' });
  await store.addResource({ tabId, url: 'https://a.test/blocked.gif', ext: 'gif', mime: 'image/gif', size: 1000, kind: 'image', source: 'network' });

  const beforeFilter = await store.getResourcesByTab(tabId);
  assert.equal(beforeFilter.length, 2);
  assert.equal(badgeTexts.get(tabId), '2');

  // 通过 storage.onChanged 广播新的过滤规则（模拟 options 页保存后的效果）
  changedListener({ webgrab_resource_filters: { newValue: { extBlacklist: ['gif'] } } }, 'local');

  store.clearTab(tabId);
  await store.addResource({ tabId, url: 'https://a.test/keep.png', ext: 'png', mime: 'image/png', size: 1000, kind: 'image', source: 'network' });
  await store.addResource({ tabId, url: 'https://a.test/blocked.gif', ext: 'gif', mime: 'image/gif', size: 1000, kind: 'image', source: 'network' });

  const afterFilter = await store.getResourcesByTab(tabId);
  assert.equal(afterFilter.length, 1);
  assert.equal(afterFilter[0].ext, 'png');
  // badge 和列表读的是同一份缓存，数字必须一致
  assert.equal(badgeTexts.get(tabId), String(afterFilter.length));
});

test('后到的结构化主视频升级同 URL 的 Range 条目，后续网络上报不能降级', async () => {
  const tabId = 901;
  const url = 'https://v3-dy.douyinvod.com/video';
  await store.addResource({
    tabId,
    url,
    kind: 'video',
    ext: 'mp4',
    mime: 'video/mp4',
    size: 1_048_576,
    title: '',
    source: 'network',
  });
  await store.addResource({
    tabId,
    url,
    kind: 'video',
    ext: 'mp4',
    mime: 'video/mp4',
    size: 39_501_347,
    title: '真实作品.mp4',
    backupUrls: ['https://backup.douyinvod.com/video'],
    width: 1920,
    height: 1080,
    duration: 428714,
    mediaId: '7650385070179519750',
    isPrimaryMedia: true,
    source: 'hook',
  });
  await store.addResource({
    tabId,
    url,
    kind: 'video',
    ext: '',
    mime: 'video/mp4',
    size: 512_000,
    source: 'network',
  });

  const [resource] = await store.getResourcesByTab(tabId);
  assert.equal(resource.title, '真实作品.mp4');
  assert.equal(resource.size, 39_501_347);
  assert.equal(resource.isPrimaryMedia, true);
  assert.deepEqual(resource.backupUrls, ['https://backup.douyinvod.com/video']);
  assert.equal(resource.width, 1920);
  assert.equal(resource.height, 1080);
  assert.equal(resource.duration, 428714);
});
