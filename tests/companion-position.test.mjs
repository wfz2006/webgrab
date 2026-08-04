import test from 'node:test';
import assert from 'node:assert/strict';

import { clampCompanionPosition, repairCompanionPosition, snapCompanionPosition } from '../lib/companion-position.js';

const viewport = { width: 1000, height: 700 };
const size = { width: 120, height: 160 };

test('越界位置会被拉回带安全边距的视口', () => {
  assert.deepEqual(clampCompanionPosition({ x: -50, y: 900 }, viewport, size, 8), { x: 8, y: 532 });
  assert.deepEqual(clampCompanionPosition({ x: 9999, y: -2 }, viewport, size, 8), { x: 872, y: 8 });
});

test('拖动结束在阈值内吸附最近的水平和垂直边缘', () => {
  assert.deepEqual(snapCompanionPosition({ x: 18, y: 20 }, viewport, size, { margin: 8, threshold: 28 }), { x: 8, y: 8 });
  assert.deepEqual(snapCompanionPosition({ x: 860, y: 400 }, viewport, size, { margin: 8, threshold: 28 }), { x: 872, y: 400 });
  assert.deepEqual(snapCompanionPosition({ x: 300, y: 300 }, viewport, size, { margin: 8, threshold: 28 }), { x: 300, y: 300 });
});

test('resize 修正保留原先依附的右/下边缘', () => {
  const repaired = repairCompanionPosition(
    { x: 872, y: 532 },
    viewport,
    { width: 720, height: 520 },
    size,
    8
  );
  assert.deepEqual(repaired, { x: 592, y: 352 });
});

test('视口比角色更小时仍返回有限且可用的位置', () => {
  assert.deepEqual(clampCompanionPosition({ x: 50, y: 50 }, { width: 80, height: 80 }, size, 8), { x: 0, y: 0 });
});
