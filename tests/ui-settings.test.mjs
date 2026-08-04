import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
  DEFAULT_UI_SETTINGS,
  UI_SETTINGS_KEY,
  applyTheme,
  loadUiSettings,
  normalizeUiSettings,
  saveUiSettings,
} from '../lib/ui-settings.js';

test('界面主题默认跟随系统且非法值安全回退', () => {
  assert.equal(UI_SETTINGS_KEY, 'webgrab_ui_settings');
  assert.deepEqual(DEFAULT_UI_SETTINGS, { theme: 'system' });
  assert.deepEqual(normalizeUiSettings(), DEFAULT_UI_SETTINGS);
  assert.deepEqual(normalizeUiSettings({ theme: 'dark' }), { theme: 'dark' });
  assert.deepEqual(normalizeUiSettings({ theme: 'light' }), { theme: 'light' });
  assert.deepEqual(normalizeUiSettings({ theme: 'sepia' }), DEFAULT_UI_SETTINGS);
});

test('强制主题写入 data-theme，跟随系统时删除属性', () => {
  const attributes = new Map();
  const root = {
    dataset: {},
    setAttribute(name, value) { attributes.set(name, value); this.dataset.theme = value; },
    removeAttribute(name) { attributes.delete(name); delete this.dataset.theme; },
  };
  assert.equal(applyTheme(root, { theme: 'dark' }), 'dark');
  assert.equal(root.dataset.theme, 'dark');
  assert.equal(applyTheme(root, { theme: 'light' }), 'light');
  assert.equal(root.dataset.theme, 'light');
  assert.equal(applyTheme(root, { theme: 'system' }), 'system');
  assert.equal(root.dataset.theme, undefined);
});

test('主题设置通过 chrome.storage.local 读写', async () => {
  const values = {};
  const storage = {
    async get(key) { return { [key]: values[key] }; },
    async set(next) { Object.assign(values, next); },
  };
  assert.deepEqual(await loadUiSettings(storage), DEFAULT_UI_SETTINGS);
  assert.deepEqual(await saveUiSettings({ theme: 'dark' }, storage), { theme: 'dark' });
  assert.deepEqual(await loadUiSettings(storage), { theme: 'dark' });
});

test('设置页提供 system/dark/light 三态主题选择器', async () => {
  const html = await readFile(new URL('../ui/options.html', import.meta.url), 'utf8');
  assert.match(html, /id="ui-theme"/);
  for (const value of ['system', 'dark', 'light']) assert.match(html, new RegExp(`value="${value}"`));
});
