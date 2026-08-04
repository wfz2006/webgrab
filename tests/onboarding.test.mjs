import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [sw, html, js, zhMessages, enMessages, manifest] = await Promise.all([
  readFile(new URL('../background/sw.js', import.meta.url), 'utf8'),
  readFile(new URL('../ui/onboarding.html', import.meta.url), 'utf8'),
  readFile(new URL('../ui/onboarding.js', import.meta.url), 'utf8'),
  readFile(new URL('../_locales/zh_CN/messages.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../_locales/en/messages.json', import.meta.url), 'utf8').then(JSON.parse),
  readFile(new URL('../manifest.json', import.meta.url), 'utf8').then(JSON.parse),
]);

test('首次安装才打开引导页，更新安装不会反复打扰用户', () => {
  assert.match(sw, /details\.reason\s*===\s*['"]install['"][\s\S]{0,200}ui\/onboarding\.html/);
});

test('引导页是短短三步，不是长弹窗', () => {
  const stepMatches = html.match(/class="step"/g) || [];
  assert.equal(stepMatches.length, 3);
  assert.doesNotMatch(html, /<video|<iframe/);
});

test('引导页文案走 chrome.i18n，且中英文 messages.json 都覆盖了用到的 key', () => {
  const usedKeys = [...js.matchAll(/t\('([a-zA-Z0-9]+)'/g)].map((m) => m[1]);
  assert.ok(usedKeys.length >= 8);
  for (const key of usedKeys) {
    assert.ok(zhMessages[key], `zh_CN messages.json 缺少 key: ${key}`);
    assert.ok(enMessages[key], `en messages.json 缺少 key: ${key}`);
  }
});

test('manifest 声明 default_locale 且 name/description 走 __MSG__ 机制', () => {
  assert.equal(manifest.default_locale, 'zh_CN');
  assert.equal(manifest.name, '__MSG_appName__');
  assert.equal(manifest.description, '__MSG_appDescription__');
  assert.ok(zhMessages.appName && zhMessages.appDescription);
  assert.ok(enMessages.appName && enMessages.appDescription);
});
