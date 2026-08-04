import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.fflate = require('../lib/fflate.min.js');

const { StreamingZipWriter } = await import('../offscreen/archive-writer.js');

class MemoryFileHandle {
  constructor() {
    this.chunks = [];
    this.closed = false;
  }

  async createWritable() {
    return {
      write: async (chunk) => this.chunks.push(new Uint8Array(chunk)),
      close: async () => { this.closed = true; },
      abort: async () => { this.chunks.length = 0; },
    };
  }

  bytes() {
    const size = this.chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Uint8Array(size);
    let offset = 0;
    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }
}

function firstLocalHeader(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const method = view.getUint16(8, true);
  const nameLength = view.getUint16(26, true);
  const name = new TextDecoder().decode(bytes.slice(30, 30 + nameLength));
  return { method, name };
}

test('流式 ZIP 可保证 EPUB mimetype 是首个 stored 条目', async () => {
  const handle = new MemoryFileHandle();
  const archive = new StreamingZipWriter(handle);
  await archive.open();
  await archive.addStored('mimetype', new TextEncoder().encode('application/epub+zip'));
  await archive.addDeflated('OEBPS/chapter.xhtml', new TextEncoder().encode('<p>正文</p>'));
  await archive.close();

  const bytes = handle.bytes();
  assert.deepEqual(firstLocalHeader(bytes), { method: 0, name: 'mimetype' });
  const files = globalThis.fflate.unzipSync(bytes);
  assert.equal(globalThis.fflate.strFromU8(files.mimetype), 'application/epub+zip');
  assert.equal(globalThis.fflate.strFromU8(files['OEBPS/chapter.xhtml']), '<p>正文</p>');
  assert.equal(handle.closed, true);
});

test('abort 会中止目标文件流', async () => {
  const handle = new MemoryFileHandle();
  const archive = new StreamingZipWriter(handle);
  await archive.open();
  await archive.addStored('one.txt', new Uint8Array([1]));
  await archive.abort(new Error('cancel'));
  assert.equal(handle.chunks.length, 0);
});
