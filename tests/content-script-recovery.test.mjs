import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let recoveryModule = {};
try {
  recoveryModule = await import('../background/content-script-recovery.js');
} catch {
  // RED 阶段允许模块尚不存在；下面的契约断言会给出明确失败原因。
}
const { CONTENT_SCRIPT_RECOVERY_RULES, recoverOpenTabs } = recoveryModule;

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

function normalizedManifestRules() {
  return manifest.content_scripts.map((entry) => ({
    matches: entry.matches,
    files: entry.js,
    world: entry.world,
    allFrames: entry.all_frames === true,
  }));
}

test('自愈注入表与 manifest 的 content_scripts 声明逐项一致', () => {
  assert.equal(typeof recoverOpenTabs, 'function', '缺少 recoverOpenTabs 实现');
  assert.ok(Array.isArray(CONTENT_SCRIPT_RECOVERY_RULES), '缺少自愈注入规则表');
  assert.deepEqual(CONTENT_SCRIPT_RECOVERY_RULES.map(({ matches, files, world, allFrames }) => ({
    matches,
    files,
    world,
    allFrames,
  })), normalizedManifestRules());
  assert.deepEqual(CONTENT_SCRIPT_RECOVERY_RULES.map(({ installFlag, removeStaleCompanion = false }) => ({
    installFlag,
    removeStaleCompanion,
  })), [
    { installFlag: '__webgrabHookInstalled', removeStaleCompanion: false },
    { installFlag: '__webgrabBiliProbeInstalled', removeStaleCompanion: false },
    { installFlag: '__webgrabDouyinProbeInstalled', removeStaleCompanion: false },
    { installFlag: '__webgrabBridgeInstalled', removeStaleCompanion: false },
    { installFlag: '__webgrabScannerInstalled', removeStaleCompanion: false },
    { installFlag: '__webgrabNovelInstalled', removeStaleCompanion: false },
    { installFlag: '__webgrabFloatingCompanionInstalled', removeStaleCompanion: true },
  ]);
});

test('普通页注入通用脚本，B站/抖音只追加各自探针，特殊协议页不扩大匹配范围', async () => {
  const tabs = [
    { id: 11, url: 'https://example.test/gallery' },
    { id: 12, url: 'https://www.bilibili.com/video/BV1test' },
    { id: 15, url: 'https://www.douyin.com/video/7650385070179519750' },
    { id: 13, url: 'chrome://extensions/' },
    { id: 14, url: 'chrome-extension://abc/ui/options.html' },
  ];
  const calls = [];
  const chromeApi = {
    tabs: { query: async () => tabs },
    scripting: { executeScript: async (options) => { calls.push(options); } },
  };

  const result = await recoverOpenTabs(chromeApi, { warn() {} });
  const forTab = (tabId) => calls.filter((call) => call.target.tabId === tabId);

  assert.equal(forTab(11).length, 11);
  assert.equal(forTab(12).length, 13);
  assert.equal(forTab(15).length, 13);
  assert.equal(forTab(13).length, 0);
  assert.equal(forTab(14).length, 0);
  assert.deepEqual(forTab(12).filter(({ files }) => files).map(({ files, world, target }) => ({ files, world, allFrames: target.allFrames })), [
    { files: ['injected/hook.js'], world: 'MAIN', allFrames: true },
    { files: ['content/bilibili-probe.js'], world: 'MAIN', allFrames: false },
    { files: ['content/bridge.js'], world: 'ISOLATED', allFrames: true },
    { files: ['content/scanner.js'], world: 'ISOLATED', allFrames: true },
    { files: ['lib/novel-heuristics.js', 'lib/novel-extractor.js', 'content/novel.js'], world: 'ISOLATED', allFrames: false },
    { files: ['content/floating-companion.js'], world: 'ISOLATED', allFrames: false },
  ]);
  assert.deepEqual(forTab(15).filter(({ files }) => files).map(({ files, world, target }) => ({ files, world, allFrames: target.allFrames })), [
    { files: ['injected/hook.js'], world: 'MAIN', allFrames: true },
    { files: ['content/douyin-probe.js'], world: 'MAIN', allFrames: false },
    { files: ['content/bridge.js'], world: 'ISOLATED', allFrames: true },
    { files: ['content/scanner.js'], world: 'ISOLATED', allFrames: true },
    { files: ['lib/novel-heuristics.js', 'lib/novel-extractor.js', 'content/novel.js'], world: 'ISOLATED', allFrames: false },
    { files: ['content/floating-companion.js'], world: 'ISOLATED', allFrames: false },
  ]);
  assert.deepEqual(result, { tabs: 5, attempted: 17, succeeded: 17, failed: 0 });
});

test('每组 files 注入前先在相同 target/world 清旧守卫，悬浮窗还要额外清旧宿主', async () => {
  const calls = [];
  const chromeApi = {
    tabs: { query: async () => [
      { id: 19, url: 'https://www.bilibili.com/video/BV1recovery' },
      { id: 20, url: 'https://www.douyin.com/video/7650385070179519750' },
    ] },
    scripting: { executeScript: async (options) => { calls.push(options); } },
  };

  await recoverOpenTabs(chromeApi, { warn() {} });

  function assertRuleSequence(tabId, rules) {
    const tabCalls = calls.filter((call) => call.target.tabId === tabId);
    let cursor = 0;
    for (const rule of rules) {
      const markerCleanup = tabCalls[cursor++];
    assert.equal(typeof markerCleanup.func, 'function');
    assert.deepEqual(markerCleanup.args, [rule.installFlag]);

      let hostCleanup = null;
      if (rule.removeStaleCompanion) {
        hostCleanup = tabCalls[cursor++];
      assert.equal(typeof hostCleanup.func, 'function');
      assert.equal(hostCleanup.args, undefined);
      assert.match(hostCleanup.func.toString(), /webgrab-floating-companion/);
      assert.match(hostCleanup.func.toString(), /\.remove\(\)/);
      }

      const fileInjection = tabCalls[cursor++];
    assert.deepEqual(fileInjection.files, [...rule.files]);
    assert.deepEqual(markerCleanup.target, fileInjection.target);
    assert.equal(markerCleanup.world, fileInjection.world);
      if (hostCleanup) {
      assert.deepEqual(hostCleanup.target, fileInjection.target);
      assert.equal(hostCleanup.world, fileInjection.world);
      }
    }
    assert.equal(cursor, tabCalls.length);
  }

  assertRuleSequence(19, CONTENT_SCRIPT_RECOVERY_RULES.filter((rule) => !rule.files.includes('content/douyin-probe.js')));
  assertRuleSequence(20, CONTENT_SCRIPT_RECOVERY_RULES.filter((rule) => !rule.files.includes('content/bilibili-probe.js')));
});

test('单个标签页的一组 executeScript 失败不会中断其余规则和后续标签页', async () => {
  const tabs = [
    { id: 21, url: 'https://broken.example.test/' },
    { id: 22, url: 'https://healthy.example.test/' },
    { id: 23, url: 'chrome://settings/' },
  ];
  const calls = [];
  const warnings = [];
  const chromeApi = {
    tabs: { query: async () => tabs },
    scripting: {
      executeScript: async (options) => {
        calls.push(options);
        if (options.target.tabId === 21 && options.files?.includes('content/scanner.js')) {
          throw new Error('Cannot access contents of the page');
        }
      },
    },
  };

  const result = await recoverOpenTabs(chromeApi, { warn: (...args) => warnings.push(args) });

  assert.equal(calls.filter((call) => call.target.tabId === 21).length, 11);
  assert.equal(calls.filter((call) => call.target.tabId === 22).length, 11);
  assert.equal(calls.filter((call) => call.target.tabId === 23).length, 0);
  assert.equal(warnings.length, 1);
  assert.deepEqual(result, { tabs: 3, attempted: 10, succeeded: 9, failed: 1 });
});

test('novel 与 floating companion 在注册监听器或加载模块前先做重复注入守卫', () => {
  const novel = fs.readFileSync(path.join(root, 'content', 'novel.js'), 'utf8');
  const companion = fs.readFileSync(path.join(root, 'content', 'floating-companion.js'), 'utf8');

  assert.match(novel, /if\s*\(window\.__webgrabNovelInstalled\)\s*return;\s*window\.__webgrabNovelInstalled\s*=\s*true;/s);
  assert.ok(novel.indexOf('__webgrabNovelInstalled') < novel.indexOf('chrome.runtime.onMessage.addListener'));
  assert.match(companion, /if\s*\(window\.__webgrabFloatingCompanionInstalled\)\s*return;\s*window\.__webgrabFloatingCompanionInstalled\s*=\s*true;/s);
  assert.ok(companion.indexOf('__webgrabFloatingCompanionInstalled') < companion.indexOf('Promise.all'));
});

test('onInstalled 在 install 和 update 的共同路径触发自愈，而不是藏在 install 分支里', () => {
  const source = fs.readFileSync(path.join(root, 'background', 'sw.js'), 'utf8');
  const listenerStart = source.indexOf('chrome.runtime.onInstalled.addListener');
  const listenerEnd = source.indexOf('// ─── B 站分 P 切换', listenerStart);
  const listener = source.slice(listenerStart, listenerEnd);
  assert.match(source, /import\s*\{\s*recoverOpenTabs\s*\}\s*from\s*['"]\.\/content-script-recovery\.js['"]/);
  assert.match(listener, /recoverOpenTabs\(\)/);
  assert.ok(listener.indexOf('recoverOpenTabs()') < listener.indexOf("details.reason === 'install'"));
});
