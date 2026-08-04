import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { DEFAULT_COMPANION_SETTINGS } from '../lib/companion-settings.js';
import { REQUIRED_CHARACTER_STATES, validateCharacterManifest } from '../lib/character-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const characterRoot = path.join(root, 'assets', 'character');
const detectiveRoot = path.join(characterRoot, 'detective-girl');

test('注册表同时保留占位角色并注册蜜糖侦探为独立角色', () => {
  const registry = JSON.parse(fs.readFileSync(path.join(characterRoot, 'registry.json'), 'utf8'));
  assert.deepEqual(registry.characters.map(({ id, root: value }) => [id, value]), [
    ['default', 'assets/character'],
    ['detective-girl', 'assets/character/detective-girl'],
  ]);
  assert.equal(registry.characters[1].name, '蜜糖侦探');
  assert.equal(DEFAULT_COMPANION_SETTINGS.characterRoot, 'assets/character/detective-girl');
});

test('蜜糖侦探 manifest 使用六个统一 120×160 单帧状态', () => {
  const manifest = validateCharacterManifest(JSON.parse(fs.readFileSync(path.join(detectiveRoot, 'manifest.json'), 'utf8')));
  assert.equal(manifest.name, '蜜糖侦探');
  assert.equal(manifest.width, 120);
  assert.equal(manifest.height, 160);
  assert.deepEqual(Object.keys(manifest.states), [...REQUIRED_CHARACTER_STATES]);
  for (const stateName of REQUIRED_CHARACTER_STATES) {
    assert.equal(manifest.states[stateName].frames, 1, stateName);
    assert.match(manifest.states[stateName].sheet, /^[\w-]+\.webp$/);
  }
});

test('六张 WebP 实际尺寸与 manifest 精确一致且包含透明背景', () => {
  const script = String.raw`
import json, pathlib, sys
from PIL import Image
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
for name, state in manifest['states'].items():
    source = Image.open(root / state['sheet'])
    assert source.format == 'WEBP', (name, source.format)
    image = source.convert('RGBA')
    assert image.size == (manifest['width'] * state['frames'], manifest['height']), (name, image.size)
    alpha = image.getchannel('A')
    lo, hi = alpha.getextrema()
    assert lo == 0 and hi >= 240, (name, lo, hi)
    box = alpha.getbbox()
    assert box and (box[2] - box[0]) >= 55 and (box[3] - box[1]) >= 85, (name, box)
print('OK')
`;
  const result = spawnSync('python', ['-c', script, detectiveRoot], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'OK');
});

test('旧占位角色 manifest 和六张素材原样保留', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(characterRoot, 'manifest.json'), 'utf8'));
  for (const state of Object.values(manifest.states)) assert.ok(fs.existsSync(path.join(characterRoot, state.sheet)), state.sheet);
});
