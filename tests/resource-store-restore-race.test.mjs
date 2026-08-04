import assert from 'node:assert/strict';
import test from 'node:test';

const realSetTimeout = globalThis.setTimeout;
let importSequence = 0;

/**
 * 复现 SW 冷启动的真实时序：sw.js 先同步注册 webRequest 监听（嗅探器立刻能
 * 干活），再异步调用 restoreFromStorage()，两者没有先后保证。storage 的读取
 * 请求在调用时刻发出取当时的值，结果晚一点才送达——恢复窗口里嗅探到的资源
 * 必须活下来。
 */
function createChromeMock(initialSession = {}) {
  const session = structuredClone(initialSession);

  const chromeMock = {
    storage: {
      session: {
        async get(keys) {
          const snapshot = keys == null
            ? structuredClone(session)
            : Object.fromEntries(
              (Array.isArray(keys) ? keys : [keys]).map((key) => [key, structuredClone(session[key])])
            );
          await new Promise((resolve) => realSetTimeout(resolve, 20));
          return snapshot;
        },
        async set(values) {
          Object.assign(session, structuredClone(values));
        },
        async remove(keys) {
          for (const key of Array.isArray(keys) ? keys : [keys]) delete session[key];
        },
      },
      local: {
        async get(key) { return { [key]: undefined }; },
        async set() {},
      },
      onChanged: { addListener() {}, removeListener() {} },
    },
    action: {
      async setBadgeText() {},
      async setBadgeBackgroundColor() {},
    },
  };

  return { chromeMock, session };
}

async function importFreshStore() {
  const url = new URL('../background/resource-store.js', import.meta.url);
  url.searchParams.set('restore-race-test', String(importSequence++));
  return import(url.href);
}

function installHarness(t, initialSession) {
  const mock = createChromeMock(initialSession);
  globalThis.chrome = mock.chromeMock;
  t.after(() => {
    delete globalThis.chrome;
  });
  return mock;
}

test('SW 恢复期间嗅探到的新资源不会被 restoreFromStorage 吞掉，已存资源也不会被覆盖丢失', async (t) => {
  const mock = installHarness(t, {
    webgrab_resources_7: [
      {
        id: '7_old',
        url: 'https://cdn.example.test/old.mp4',
        kind: 'video',
        ext: 'mp4',
        tabId: 7,
        size: 3_000_000,
        source: 'network',
        discoveredAt: 1,
      },
    ],
  });
  const store = await importFreshStore();

  // sw.js 就是这样调的：不 await，恢复在后台跑。
  const restoring = store.restoreFromStorage();
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  await store.addResource({
    url: 'https://cdn.example.test/fresh.mp4',
    kind: 'video',
    ext: 'mp4',
    tabId: 7,
    size: 5_000_000,
    source: 'network',
    discoveredAt: 2,
  });
  await restoring;

  const cachedUrls = (await store.getResourcesByTab(7)).map((resource) => resource.url).sort();
  assert.deepEqual(
    cachedUrls,
    ['https://cdn.example.test/fresh.mp4', 'https://cdn.example.test/old.mp4'],
    '恢复窗口内嗅探到的资源和已持久化的资源都必须出现在缓存里'
  );

  const storedUrls = (mock.session.webgrab_resources_7 || []).map((resource) => resource.url).sort();
  assert.deepEqual(
    storedUrls,
    ['https://cdn.example.test/fresh.mp4', 'https://cdn.example.test/old.mp4'],
    '恢复结束后存储必须和缓存一致，否则下次重启会真正丢数据'
  );
});

test('恢复不会用磁盘上的旧副本覆盖内存里更完整的同一条资源', async (t) => {
  const mock = installHarness(t, {
    webgrab_resources_9: [
      {
        id: '9_same',
        url: 'https://cdn.example.test/clip.mp4',
        kind: 'video',
        ext: 'mp4',
        tabId: 9,
        size: -1,
        mime: '',
        source: 'dom',
        discoveredAt: 1,
      },
    ],
  });
  const store = await importFreshStore();

  const restoring = store.restoreFromStorage();
  await new Promise((resolve) => realSetTimeout(resolve, 5));
  // 网络层刚补齐了 size/mime，比磁盘上那份 DOM 来源的记录更完整。
  await store.addResource({
    url: 'https://cdn.example.test/clip.mp4',
    kind: 'video',
    ext: 'mp4',
    tabId: 9,
    size: 8_000_000,
    mime: 'video/mp4',
    source: 'network',
    discoveredAt: 2,
  });
  await restoring;

  const resources = await store.getResourcesByTab(9);
  assert.equal(resources.length, 1, '同一 URL 不能因为恢复变成两条');
  assert.equal(resources[0].size, 8_000_000, '内存中更完整的元数据不能被磁盘旧副本覆盖');
  assert.equal(resources[0].mime, 'video/mp4');
  assert.equal(mock.session.webgrab_resources_9?.[0]?.size, 8_000_000);
});

test('没有并发写入时，恢复行为与原来一致：多标签页各自还原，无关键不受影响', async (t) => {
  const mock = installHarness(t, {
    webgrab_resources_11: [
      { id: '11_a', url: 'https://a.test/1.jpg', kind: 'image', ext: 'jpg', tabId: 11, discoveredAt: 1 },
    ],
    webgrab_resources_22: [
      { id: '22_a', url: 'https://b.test/1.jpg', kind: 'image', ext: 'jpg', tabId: 22, discoveredAt: 1 },
    ],
    webgrab_resources_notanumber: [{ url: 'https://c.test/1.jpg' }],
    unrelated_session_value: { keep: true },
  });
  const store = await importFreshStore();

  await store.restoreFromStorage();

  assert.equal((await store.getResourcesByTab(11)).length, 1);
  assert.equal((await store.getResourcesByTab(22)).length, 1);
  assert.deepEqual(mock.session.unrelated_session_value, { keep: true }, '不能动无关的 session 键');
});
