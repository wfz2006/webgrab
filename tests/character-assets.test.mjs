import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { REQUIRED_CHARACTER_STATES, validateCharacterManifest } from '../lib/character-manifest.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assetRoot = path.join(root, 'assets', 'character');

test('默认角色 manifest 使用完整的本地 WebP 状态表', () => {
  const manifest = validateCharacterManifest(JSON.parse(fs.readFileSync(path.join(assetRoot, 'manifest.json'), 'utf8')));
  assert.equal(manifest.name, '默认占位角色');
  assert.equal(manifest.width, 120);
  assert.equal(manifest.height, 160);
  for (const name of REQUIRED_CHARACTER_STATES) assert.match(manifest.states[name].sheet, /^[\w-]+\.webp$/);
});

test('每张占位雪碧图宽度等于单帧宽度乘帧数', () => {
  const script = String.raw`
import json, pathlib, sys
from PIL import Image
root = pathlib.Path(sys.argv[1])
manifest = json.loads((root / 'manifest.json').read_text(encoding='utf-8'))
for name, state in manifest['states'].items():
    image = Image.open(root / state['sheet'])
    assert image.format == 'WEBP', (name, image.format)
    assert image.size == (manifest['width'] * state['frames'], manifest['height']), (name, image.size)
print('OK')
`;
  const result = spawnSync('python', ['-c', script, assetRoot], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.equal(result.stdout.trim(), 'OK');
});

test('manifest 只暴露本地角色资源、面板页和依赖模块', () => {
  const extensionManifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  const exposed = extensionManifest.web_accessible_resources.flatMap((entry) => entry.resources);
  assert.ok(exposed.includes('assets/character/*'));
  assert.ok(exposed.includes('ui/panel.html'));
  assert.ok(exposed.includes('lib/character-manifest.js'));
  assert.ok(!exposed.some((resource) => /^https?:\/\//i.test(resource)));
});
