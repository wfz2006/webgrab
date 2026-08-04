import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PATH_SETTINGS,
  PATH_SETTINGS_KEY,
  loadPathSettings,
  mergePathSettings,
  savePathSettings,
} from '../lib/path-settings.js';

function fakeStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    async get(key) { return { [key]: data[key] }; },
    async set(value) { Object.assign(data, value); },
  };
}

test('settings default to automatic rename and merge partial stored templates', async () => {
  const storage = fakeStorage({ [PATH_SETTINGS_KEY]: { templates: { image: 'Custom/{标题}.{ext}' } } });
  const settings = await loadPathSettings(storage);
  assert.equal(settings.conflictStrategy, 'uniquify');
  assert.equal(settings.templates.image, 'Custom/{标题}.{ext}');
  assert.equal(settings.templates.novel, DEFAULT_PATH_SETTINGS.templates.novel);
});

test('invalid conflict strategies are rejected during merge', () => {
  assert.equal(mergePathSettings({ conflictStrategy: 'delete-everything' }).conflictStrategy, 'uniquify');
});

test('save persists only normalized settings', async () => {
  const storage = fakeStorage();
  const saved = await savePathSettings({ conflictStrategy: 'skip', templates: { video: '{标题}.{ext}' } }, storage);
  assert.equal(saved.conflictStrategy, 'skip');
  assert.deepEqual(storage.data[PATH_SETTINGS_KEY], saved);
});
