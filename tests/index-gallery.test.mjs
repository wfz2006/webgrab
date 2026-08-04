import test from 'node:test';
import assert from 'node:assert/strict';

import { buildGalleryIndex } from '../lib/gallery-index.js';

test('本地画廊只用相对路径，支持响应式纵向阅读和键盘翻页', () => {
  const html = buildGalleryIndex({
    title: '测试漫画',
    source: 'https://example.test/chapter',
    pages: ['001.jpg', '002.jpg'],
    missingCount: 1,
  });
  assert.match(html, /src="001\.jpg"/);
  assert.match(html, /src="002\.jpg"/);
  assert.doesNotMatch(html, /src="https?:/);
  assert.match(html, /max-width:\s*100%/);
  assert.match(html, /keydown/);
  assert.match(html, /ArrowRight/);
  assert.match(html, /缺失 1 页/);
});
