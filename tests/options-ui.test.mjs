import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('manifest and popup expose the organized-path settings page', async () => {
  const manifest = JSON.parse(await read('manifest.json'));
  const popup = await read('ui/popup.html');
  assert.equal(manifest.options_ui.page, 'ui/options.html');
  assert.equal(manifest.options_ui.open_in_tab, true);
  assert.match(popup, /id="btn-settings"/);
});

test('options UI exposes all tokens, templates, conflict strategies, and live preview', async () => {
  const [html, script] = await Promise.all([read('ui/options.html'), read('ui/options.js')]);
  for (const token of ['{root}', '{类型}', '{站点}', '{作品}', '{章节}', '{序号}', '{标题}', '{日期}', '{ext}']) {
    assert.match(html, new RegExp(token.replace(/[{}]/g, '\\$&')));
  }
  for (const type of ['comic', 'novel', 'video', 'audio', 'image', 'other']) {
    assert.match(html, new RegExp(`data-template-type="${type}"`));
  }
  for (const strategy of ['uniquify', 'skip', 'overwrite']) {
    assert.match(html, new RegExp(`value="${strategy}"`));
  }
  assert.match(html, /id="path-preview"/);
  assert.match(script, /renderPathTemplate/);
  assert.match(script, /input.*renderPreview|renderPreview.*input/s);
});

test('options UI exposes the companion global switch and hidden-site recovery', async () => {
  const [html, script] = await Promise.all([read('ui/options.html'), read('ui/options.js')]);
  assert.match(html, /id="companion-enabled"/);
  assert.match(html, /id="companion-hidden-sites"/);
  assert.match(html, /id="companion-restore-sites"/);
  assert.match(script, /loadCompanionSettings/);
  assert.match(script, /saveCompanionSettings/);
  assert.match(script, /disabledOrigins/);
});
