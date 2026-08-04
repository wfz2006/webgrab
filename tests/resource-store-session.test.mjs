import test from 'node:test';
import assert from 'node:assert/strict';

const sessionStore = Object.create(null);
const sessionSetCalls = [];
const sessionRemoveCalls = [];

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

globalThis.chrome = {
  storage: {
    session: {
      async get(keys) {
        if (keys == null) return clone(sessionStore);
        const requested = Array.isArray(keys) ? keys : [keys];
        return Object.fromEntries(requested.map((key) => [key, clone(sessionStore[key])]));
      },
      async set(values) {
        const snapshot = clone(values);
        sessionSetCalls.push(snapshot);
        Object.assign(sessionStore, snapshot);
      },
      async remove(keys) {
        const requested = Array.isArray(keys) ? keys : [keys];
        sessionRemoveCalls.push([...requested]);
        for (const key of requested) delete sessionStore[key];
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

test('资源按标签页独立持久化、可跨 SW 实例恢复，并只清理目标标签页', async () => {
  const firstInstance = await import(`../background/resource-store.js?session-test=${Date.now()}`);
  await new Promise((resolve) => setTimeout(resolve, 0));

  await firstInstance.addResource({
    tabId: 11,
    url: 'https://a.test/page-1.jpg',
    kind: 'image',
    ext: 'jpg',
    source: 'dom',
  });
  assert.deepEqual(Object.keys(sessionSetCalls.at(-1)), ['webgrab_resources_11']);

  await firstInstance.addResource({
    tabId: 22,
    url: 'https://b.test/page-1.jpg',
    kind: 'image',
    ext: 'jpg',
    source: 'dom',
  });
  assert.deepEqual(Object.keys(sessionSetCalls.at(-1)), ['webgrab_resources_22']);
  assert.ok(sessionStore.webgrab_resources_11, '标签页 B 写入时不能覆盖标签页 A 的数据');

  // 已有资源补全元数据时也只能写自己的标签页键。
  await firstInstance.addResource({
    tabId: 11,
    url: 'https://a.test/page-1.jpg',
    kind: 'image',
    ext: 'jpg',
    mime: 'image/jpeg',
    source: 'network',
  });
  assert.deepEqual(Object.keys(sessionSetCalls.at(-1)), ['webgrab_resources_11']);
  assert.ok(sessionStore.webgrab_resources_22, '标签页 A 更新时不能触碰标签页 B 的数据');

  // 用全新的模块实例模拟 Service Worker 被销毁后重新启动。
  sessionStore.unrelated_session_value = { keep: true };
  const restartedInstance = await import(`../background/resource-store.js?session-restart=${Date.now()}`);
  await restartedInstance.restoreFromStorage();
  assert.equal((await restartedInstance.getResourcesByTab(11)).length, 1);
  assert.equal((await restartedInstance.getResourcesByTab(22)).length, 1);

  restartedInstance.clearTab(11);
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(sessionRemoveCalls.at(-1), ['webgrab_resources_11']);
  assert.equal(sessionStore.webgrab_resources_11, undefined);
  assert.equal(sessionStore.webgrab_resources_22.length, 1);
  assert.deepEqual(sessionStore.unrelated_session_value, { keep: true });
  assert.equal((await restartedInstance.getResourcesByTab(22)).length, 1);
});
