import test from 'node:test';
import assert from 'node:assert/strict';

import {
  COMPANION_SETTINGS_KEY,
  DEFAULT_COMPANION_SETTINGS,
  getCompanionOrigin,
  isCompanionVisible,
  mergeCompanionSettings,
  setOriginDisabled,
  withStoredPosition,
} from '../lib/companion-settings.js';

test('设置默认启用并使用本地默认角色目录', () => {
  const settings = mergeCompanionSettings();
  assert.equal(COMPANION_SETTINGS_KEY, 'webgrab_companion_settings');
  assert.deepEqual(settings, DEFAULT_COMPANION_SETTINGS);
  assert.equal(settings.characterRoot, 'assets/character/detective-girl');
});

test('只有资源数大于零且全局/本站允许时才显示', () => {
  const url = 'https://example.com/chapter/1';
  assert.equal(isCompanionVisible({}, url, 0), false);
  assert.equal(isCompanionVisible({}, url, 1), true);
  assert.equal(isCompanionVisible({ enabled: false }, url, 3), false);
  assert.equal(isCompanionVisible({ disabledOrigins: ['https://example.com'] }, url, 3), false);
});

test('站点开关按 HTTP(S) origin 存储且可恢复', () => {
  assert.equal(getCompanionOrigin('https://example.com/a'), 'https://example.com');
  assert.equal(getCompanionOrigin('chrome://extensions'), '');
  const hidden = setOriginDisabled({}, 'https://example.com/a', true);
  assert.deepEqual(hidden.disabledOrigins, ['https://example.com']);
  assert.deepEqual(setOriginDisabled(hidden, 'https://example.com/b', false).disabledOrigins, []);
});

test('位置按 origin 持久化并过滤非有限值', () => {
  const settings = withStoredPosition({}, 'https://example.com/a', { x: 88.4, y: 120.8 });
  assert.deepEqual(settings.positions['https://example.com'], { x: 88, y: 121 });
  const merged = mergeCompanionSettings({ positions: { 'https://bad.test': { x: Infinity, y: 3 } } });
  assert.equal(merged.positions['https://bad.test'], undefined);
});
