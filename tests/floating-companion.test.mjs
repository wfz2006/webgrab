import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = fs.readFileSync(path.join(root, 'content', 'floating-companion.js'), 'utf8');
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));

test('悬浮角色 content script 只注入顶层文档', () => {
  const entry = manifest.content_scripts.find((item) => item.js?.includes('content/floating-companion.js'));
  assert.ok(entry);
  assert.equal(entry.all_frames, false);
  assert.match(source, /window\.top\s*!==\s*window/);
});

test('宿主使用 open Shadow DOM 且页面上没有资源时不创建', () => {
  assert.match(source, /attachShadow\(\{\s*mode:\s*['"]open['"]\s*\}\)/);
  assert.match(source, /isCompanionVisible/);
  assert.match(source, /ensureMounted/);
  assert.match(source, /resourceCount/);
});

test('拖动使用 Pointer Events、pointer capture 和 transform', () => {
  assert.match(source, /pointerdown/);
  assert.match(source, /pointermove/);
  assert.match(source, /pointerup/);
  assert.match(source, /setPointerCapture/);
  assert.match(source, /translate3d/);
  assert.doesNotMatch(source, /\.style\.(left|top)\s*=/);
  assert.match(source, /snapCompanionPosition/);
  assert.match(source, /repairCompanionPosition/);
});

test('全屏自动隐藏并尊重 reduced-motion', () => {
  assert.match(source, /fullscreenchange/);
  assert.match(source, /document\.fullscreenElement/);
  assert.match(source, /prefers-reduced-motion/);
  assert.match(source, /animation:\s*none\s*!important/);
});

test('壳层呼吸动画独立于雪碧图，error 有红色调和轻微抖动', () => {
  assert.match(source, /@keyframes\s+webgrab-breathe/);
  assert.match(source, /\.wg-shell\s*\{[^}]*animation:\s*webgrab-breathe/s);
  assert.match(source, /\.wg-shell:hover[^}]*animation-play-state:\s*paused/s);
  assert.match(source, /@keyframes\s+webgrab-error-shake/);
  assert.match(source, /\.wg-shell\[data-phase="error"\]/);
  assert.match(source, /\.wg-shell\[data-phase="error"\][^{]*\{[^}]*animation:[^}]*webgrab-error-shake/s);
  assert.match(source, /prefers-reduced-motion:\s*reduce[^}]*\.wg-shell[^}]*animation:\s*none\s*!important/s);
});

test('角色状态完全来自 manifest，脚本没有硬编码素材文件名', () => {
  assert.match(source, /manifest\.json/);
  assert.match(source, /resolveCharacterState/);
  assert.match(source, /state\.frames\s*===\s*1/);
  for (const file of ['idle.webp', 'scan.webp', 'found.webp', 'down.webp', 'done.webp', 'error.webp']) {
    assert.ok(!source.includes(file));
  }
});
