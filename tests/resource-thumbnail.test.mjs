import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('../ui/popup.js', import.meta.url), 'utf8');

test('图片缩略图由唯一 IntersectionObserver 在视口附近启动', () => {
  assert.match(source, /new IntersectionObserver\s*\(/);
  assert.match(source, /root:\s*listContainer/);
  assert.match(source, /rootMargin:\s*['"](?:80|96|120)px/);
  assert.match(source, /thumbnailObserver\.disconnect\s*\(\)/);
  assert.match(source, /thumbnailObserver\.observe\s*\(thumb\)/);
});

test('资源 URL 先放 data-src，观察到后才赋给 src', () => {
  assert.match(source, /thumb\.dataset\.src\s*=\s*res\.url/);
  assert.match(source, /thumb\.src\s*=\s*thumb\.dataset\.src/);
  assert.doesNotMatch(source, /thumb\.src\s*=\s*res\.url/);
  assert.match(source, /thumb\.decoding\s*=\s*['"]async['"]/);
});

test('缩略图成功淡入，失败状态缓存并移除破图', () => {
  assert.match(source, /thumbnailStates\s*=\s*new Map/);
  assert.match(source, /thumbnailStates\.set\([^,]+,\s*['"]loaded['"]\)/);
  assert.match(source, /thumbnailStates\.set\([^,]+,\s*['"]error['"]\)/);
  assert.match(source, /classList\.add\(['"]is-loaded['"]\)/);
  assert.match(source, /thumb\.remove\s*\(\)/);
});
