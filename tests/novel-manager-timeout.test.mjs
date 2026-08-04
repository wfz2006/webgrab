import test from 'node:test';
import assert from 'node:assert/strict';

test('页面正文消息永久不响应时，小说检测会在 8 秒边界抛出明确超时错误', async (t) => {
  const realSetTimeout = globalThis.setTimeout;
  const realClearTimeout = globalThis.clearTimeout;
  let scheduledDelay = null;
  let clearedTimer = false;

  globalThis.chrome = {
    tabs: {
      sendMessage() { return new Promise(() => {}); },
    },
  };
  globalThis.setTimeout = (callback, delay) => {
    scheduledDelay = delay;
    queueMicrotask(callback);
    return 73;
  };
  globalThis.clearTimeout = (timer) => {
    if (timer === 73) clearedTimer = true;
  };
  t.after(() => {
    globalThis.setTimeout = realSetTimeout;
    globalThis.clearTimeout = realClearTimeout;
    delete globalThis.chrome;
  });

  const manager = await import(`../background/novel-manager.js?timeout-test=${Date.now()}`);
  const watchdog = new Promise((_, reject) => {
    realSetTimeout(() => reject(new Error('测试等待超时：detectNovelPage 仍未结束')), 100);
  });

  await assert.rejects(
    Promise.race([manager.detectNovelPage(42), watchdog]),
    /页面检测超时，可能是页面结构过于复杂/
  );
  assert.equal(scheduledDelay, 8000);
  assert.equal(clearedTimer, true);
});
