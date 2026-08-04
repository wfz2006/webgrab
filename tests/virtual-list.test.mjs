import test from 'node:test';
import assert from 'node:assert/strict';

import { computeVisibleRange } from '../lib/virtual-list.js';

test('顶部滚动时只渲染视口附近的前几行加缓冲', () => {
  const range = computeVisibleRange({ scrollTop: 0, viewportHeight: 600, rowHeight: 64, itemCount: 5000, overscan: 6 });
  assert.equal(range.startIndex, 0);
  // visibleCount = ceil(600/64)+1 = 11，加 overscan=6 => endIndex ~17
  assert.equal(range.endIndex, 17);
  assert.equal(range.offsetY, 0);
  assert.equal(range.totalHeight, 5000 * 64);
});

test('滚动到中间时窗口跟随 scrollTop 移动且保留上下缓冲', () => {
  const range = computeVisibleRange({ scrollTop: 6400, viewportHeight: 600, rowHeight: 64, itemCount: 5000, overscan: 6 });
  // firstVisible = 6400/64 = 100，startIndex = 100-6 = 94
  assert.equal(range.startIndex, 94);
  assert.equal(range.offsetY, 94 * 64);
  assert.ok(range.endIndex > range.startIndex);
});

test('滚动到底部时窗口不越过 itemCount 上界', () => {
  const range = computeVisibleRange({ scrollTop: 999999, viewportHeight: 600, rowHeight: 64, itemCount: 200, overscan: 6 });
  assert.equal(range.endIndex, 200);
  assert.ok(range.startIndex < 200);
});

test('空列表返回零区间，不产生负数或 NaN', () => {
  const range = computeVisibleRange({ scrollTop: 0, viewportHeight: 600, rowHeight: 64, itemCount: 0 });
  assert.deepEqual(range, { startIndex: 0, endIndex: 0, offsetY: 0, totalHeight: 0 });
});

test('items 数量少于一屏时窗口覆盖全部条目', () => {
  const range = computeVisibleRange({ scrollTop: 0, viewportHeight: 600, rowHeight: 64, itemCount: 5, overscan: 6 });
  assert.equal(range.startIndex, 0);
  assert.equal(range.endIndex, 5);
});
