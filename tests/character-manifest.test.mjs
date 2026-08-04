import test from 'node:test';
import assert from 'node:assert/strict';

import {
  REQUIRED_CHARACTER_STATES,
  buildSpriteAnimation,
  resolveCharacterState,
  validateCharacterManifest,
} from '../lib/character-manifest.js';

function validManifest() {
  return {
    name: '占位角色',
    width: 120,
    height: 160,
    states: Object.fromEntries(REQUIRED_CHARACTER_STATES.map((state) => [state, {
      sheet: `${state}.webp`, frames: state === 'idle' ? 12 : 6, fps: 12, loop: state === 'idle',
    }])),
  };
}

test('角色 manifest 要求六种状态和有效画布尺寸', () => {
  const manifest = validateCharacterManifest(validManifest());
  assert.equal(manifest.width, 120);
  assert.deepEqual(Object.keys(manifest.states), [...REQUIRED_CHARACTER_STATES]);
  assert.throws(() => validateCharacterManifest({ ...validManifest(), states: {} }), /idle/);
  assert.throws(() => validateCharacterManifest({ ...validManifest(), width: 0 }), /width/);
});

test('角色素材路径必须留在角色目录内且不得远程加载', () => {
  for (const sheet of ['https://cdn.example/a.webp', '//cdn.example/a.webp', '../a.webp', '/a.webp', 'data:image/webp;base64,AA']) {
    const manifest = validManifest();
    manifest.states.idle.sheet = sheet;
    assert.throws(() => validateCharacterManifest(manifest), /sheet/);
  }
});

test('雪碧图动画参数使用横向 steps 且时长由 frames/fps 决定', () => {
  const manifest = validateCharacterManifest(validManifest());
  const state = resolveCharacterState(manifest, 'idle', 'chrome-extension://id/assets/character/');
  assert.equal(state.sheetUrl, 'chrome-extension://id/assets/character/idle.webp');
  assert.equal(state.backgroundWidth, 1440);
  assert.equal(state.animation.steps, 12);
  assert.equal(state.animation.durationMs, 1000);
  assert.equal(state.animation.iterationCount, 'infinite');
  assert.deepEqual(buildSpriteAnimation({ frames: 6, fps: 12, loop: false }), {
    steps: 6,
    durationMs: 500,
    iterationCount: 1,
  });
});

test('未知状态安全回退 idle，且返回结果不修改源 manifest', () => {
  const source = validManifest();
  const before = structuredClone(source);
  const state = resolveCharacterState(validateCharacterManifest(source), 'missing', 'chrome-extension://id/assets/character/');
  assert.equal(state.name, 'idle');
  assert.deepEqual(source, before);
});
