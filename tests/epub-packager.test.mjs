import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.fflate = require('../lib/fflate.min.js');
const { packageEpub } = await import('../offscreen/epub-packager.js');

class MemoryFileHandle {
  constructor() { this.chunks = []; }
  async createWritable() {
    return {
      write: async (chunk) => this.chunks.push(new Uint8Array(chunk)),
      close: async () => {},
      abort: async () => { this.chunks = []; },
    };
  }
  bytes() {
    const size = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const result = new Uint8Array(size); let offset = 0;
    for (const chunk of this.chunks) { result.set(chunk, offset); offset += chunk.length; }
    return result;
  }
}

test('EPUB 逐章写入，坏章跳过后 manifest/spine 只引用成功章节', async () => {
  const handle = new MemoryFileHandle();
  const book = {
    kind: 'novel', title: '测试小说', author: '测试作者', source: 'https://book.test/',
    chapters: [
      { index: 0, title: '第一章', html: '<p>正文一</p>', text: '正文一', url: 'https://book.test/1' },
      { index: 1, title: '坏章', html: '<p>BAD</p>', text: 'BAD', url: 'https://book.test/2' },
      { index: 2, title: '第三章', html: '<p>正文三</p>', text: '正文三', url: 'https://book.test/3' },
    ],
  };
  const result = await packageEpub({
    bookId: 'book-1', fileHandle: handle,
    getNovelImpl: async () => book,
    normalizeBodyImpl: (html) => {
      if (html.includes('BAD')) throw new Error('非法正文');
      return html;
    },
  });

  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  const bytes = handle.bytes();
  const method = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint16(8, true);
  assert.equal(method, 0);
  const files = globalThis.fflate.unzipSync(bytes);
  assert.equal(globalThis.fflate.strFromU8(files.mimetype), 'application/epub+zip');
  assert.ok(files['OEBPS/text/chapter-0001.xhtml']);
  assert.ok(files['OEBPS/text/chapter-0002.xhtml']);
  assert.equal(files['OEBPS/text/chapter-0003.xhtml'], undefined);
  const opf = globalThis.fflate.strFromU8(files['OEBPS/content.opf']);
  assert.match(opf, /chapter-0001/);
  assert.match(opf, /chapter-0002/);
  assert.doesNotMatch(opf, /chapter-0003/);
});
