import test from 'node:test';
import assert from 'node:assert/strict';

import { shouldKeepResource } from '../lib/resource-filter.js';
import { DEFAULT_RESOURCE_FILTERS, normalizeResourceFilters } from '../lib/resource-filter-settings.js';

test('默认规则不过滤任何资源', () => {
  assert.equal(shouldKeepResource({ ext: 'gif', mime: 'image/gif', size: 1, kind: 'image', url: 'https://a.test/x.gif', source: 'network' }, DEFAULT_RESOURCE_FILTERS), true);
});

test('扩展名黑名单大小写和前导点都归一化匹配', () => {
  const filters = normalizeResourceFilters({ extBlacklist: ['.GIF', 'Ico'] });
  assert.equal(shouldKeepResource({ ext: 'gif', url: 'https://a.test/x.gif' }, filters), false);
  assert.equal(shouldKeepResource({ ext: 'ICO', url: 'https://a.test/x.ico' }, filters), false);
  assert.equal(shouldKeepResource({ ext: 'png', url: 'https://a.test/x.png' }, filters), true);
});

test('mime 黑名单支持前缀匹配', () => {
  const filters = normalizeResourceFilters({ mimeBlacklist: ['image/svg'] });
  assert.equal(shouldKeepResource({ mime: 'image/svg+xml', url: 'https://a.test/x.svg' }, filters), false);
  assert.equal(shouldKeepResource({ mime: 'image/png', url: 'https://a.test/x.png' }, filters), true);
});

test('大小阈值只对已知大小生效，未知大小（-1）永远放行', () => {
  const filters = normalizeResourceFilters({ minSizeBytes: { image: 10240 } });
  assert.equal(shouldKeepResource({ kind: 'image', size: 100, url: 'https://a.test/x.png' }, filters), false);
  assert.equal(shouldKeepResource({ kind: 'image', size: 20480, url: 'https://a.test/x.png' }, filters), true);
  assert.equal(shouldKeepResource({ kind: 'image', size: -1, url: 'https://a.test/x.png' }, filters), true);
});

test('URL 正则黑名单命中即丢弃，无效正则不影响其他规则', () => {
  const filters = normalizeResourceFilters({ urlBlacklistPatterns: ['/ads/', '(unclosed'] });
  assert.equal(shouldKeepResource({ url: 'https://cdn.test/ads/banner.png' }, filters), false);
  assert.equal(shouldKeepResource({ url: 'https://cdn.test/real/photo.png' }, filters), true);
});

test('关闭 showHookResources 后丢弃 hook 来源，其他来源不受影响', () => {
  const filters = normalizeResourceFilters({ showHookResources: false });
  assert.equal(shouldKeepResource({ source: 'hook', url: 'https://a.test/x.mp4' }, filters), false);
  assert.equal(shouldKeepResource({ source: 'network', url: 'https://a.test/x.mp4' }, filters), true);
  assert.equal(shouldKeepResource({ source: 'dom', url: 'https://a.test/x.mp4' }, filters), true);
});
