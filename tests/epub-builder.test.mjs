import test from 'node:test';
import assert from 'node:assert/strict';

import {
  EPUB_CSS,
  buildChapterXhtml,
  buildContainerXml,
  buildContentOpf,
  buildNavXhtml,
  buildTocNcx,
  createEpubMetadata,
} from '../lib/epub-builder.js';

const book = { title: '书 & 名', author: '作者 <甲>', source: 'https://example.test/book' };
const chapters = [
  { id: 'chapter-0001', path: 'text/chapter-0001.xhtml', title: '第一章 & 开始' },
  { id: 'chapter-0002', path: 'text/chapter-0002.xhtml', title: '第二章' },
];

test('EPUB container 指向 OEBPS/content.opf', () => {
  assert.match(buildContainerXml(), /full-path="OEBPS\/content\.opf"/);
});

test('OPF 包含 EPUB3 metadata、manifest、spine 与 NCX 兼容入口', () => {
  const metadata = createEpubMetadata(book, {
    identifier: 'urn:uuid:test-id',
    modified: '2026-07-31T00:00:00Z',
  });
  const xml = buildContentOpf(metadata, chapters);
  assert.match(xml, /version="3\.0"/);
  assert.match(xml, /<dc:title>书 &amp; 名<\/dc:title>/);
  assert.match(xml, /<dc:creator>作者 &lt;甲&gt;<\/dc:creator>/);
  assert.match(xml, /properties="nav"/);
  assert.match(xml, /id="ncx"/);
  assert.match(xml, /<spine toc="ncx">[\s\S]*chapter-0001[\s\S]*chapter-0002/);
});

test('EPUB3 nav 和 NCX 都按章节顺序生成可跳转目录', () => {
  const metadata = createEpubMetadata(book, { identifier: 'urn:uuid:test-id' });
  const nav = buildNavXhtml(metadata, chapters);
  const ncx = buildTocNcx(metadata, chapters);
  assert.ok(nav.indexOf('chapter-0001.xhtml') < nav.indexOf('chapter-0002.xhtml'));
  assert.match(nav, /第一章 &amp; 开始/);
  assert.ok(ncx.indexOf('playOrder="1"') < ncx.indexOf('playOrder="2"'));
});

test('章节包装为 XHTML 并引用统一 CSS', () => {
  const chapter = buildChapterXhtml('标题 & 甲', '<p xmlns="http://www.w3.org/1999/xhtml">正文<br /></p>');
  assert.match(chapter, /xmlns="http:\/\/www\.w3\.org\/1999\/xhtml"/);
  assert.match(chapter, /<title>标题 &amp; 甲<\/title>/);
  assert.match(chapter, /href="\.\.\/styles\/book\.css"/);
  assert.match(chapter, /<br \/>/);
  assert.match(EPUB_CSS, /line-height:\s*1\.8/);
  assert.match(EPUB_CSS, /text-indent:\s*2em/);
});
