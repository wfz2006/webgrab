import test from 'node:test';
import assert from 'node:assert/strict';

import {
  fixedPageName,
  naturalCompare,
  sanitizePackageName,
  sortComicResources,
} from '../lib/package-utils.js';

test('漫画资源优先按 DOM index 排序，缺少 index 的资源随后自然排序', () => {
  const resources = [
    { url: 'https://cdn.test/10.jpg', title: '10.jpg' },
    { url: 'https://cdn.test/3.jpg', title: '3.jpg', domIndex: 8 },
    { url: 'https://cdn.test/1.jpg', title: '1.jpg', domIndex: 2 },
    { url: 'https://cdn.test/2.jpg', title: '2.jpg' },
  ];

  assert.deepEqual(
    sortComicResources(resources).map((item) => item.title),
    ['1.jpg', '3.jpg', '2.jpg', '10.jpg']
  );
});

test('naturalCompare 不产生 1,10,2 的字典序错误', () => {
  assert.deepEqual(['10.jpg', '2.jpg', '1.jpg'].sort(naturalCompare), [
    '1.jpg',
    '2.jpg',
    '10.jpg',
  ]);
});

test('页名至少三位，并随总页数扩展位数', () => {
  assert.equal(fixedPageName(1, 20, 'jpeg'), '001.jpg');
  assert.equal(fixedPageName(12, 1200, '.png'), '0012.png');
});

test('包名清理 Windows 非法字符且不返回空名', () => {
  assert.equal(sanitizePackageName('  书:名?/  '), '书_名_');
  assert.equal(sanitizePackageName('...'), 'WebGrab');
});

test('sanitizePackageName avoids every Windows reserved device name', () => {
  for (const name of ['CON', 'prn', 'AUX', 'nul', 'COM1', 'com9', 'LPT1', 'lpt9']) {
    const safe = sanitizePackageName(name);
    assert.notEqual(safe.toUpperCase(), name.toUpperCase());
    assert.match(safe, /_$/);
  }
  assert.equal(sanitizePackageName('COM10'), 'COM10');
});

test('sanitizePackageName protects reserved basenames while preserving extensions', () => {
  assert.equal(sanitizePackageName('CON.txt'), 'CON_.txt');
  assert.equal(sanitizePackageName('lpt3.epub'), 'lpt3_.epub');
  assert.equal(sanitizePackageName('COM1.backup.zip'), 'COM1_.backup.zip');
});

test('sanitizePackageName removes Windows punctuation and trailing spaces or dots', () => {
  assert.equal(sanitizePackageName('a\\b/c:d*e?f"g<h>i|j...  '), 'a_b_c_d_e_f_g_h_i_j');
});

test('sanitizePackageName limits one segment to 255 UTF-8 bytes without breaking Unicode', () => {
  const safe = sanitizePackageName(`${'书'.repeat(100)}.epub`);
  assert.ok(new TextEncoder().encode(safe).byteLength <= 255);
  assert.ok(safe.endsWith('.epub'));
  assert.doesNotMatch(safe, /\uFFFD/);
});
