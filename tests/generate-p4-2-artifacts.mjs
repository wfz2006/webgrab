import { mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.fflate = require('../lib/fflate.min.js');
const { packageComic } = await import('../offscreen/comic-packager.js');
const { packageEpub } = await import('../offscreen/epub-packager.js');

class NodeFileHandle {
  constructor(filePath) { this.filePath = filePath; }
  async createWritable() {
    await mkdir(path.dirname(this.filePath), { recursive: true });
    const handle = await open(this.filePath, 'w');
    let position = 0;
    return {
      write: async (chunk) => {
        const bytes = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
        await handle.write(bytes, 0, bytes.length, position);
        position += bytes.length;
      },
      close: async () => handle.close(),
      abort: async () => handle.close(),
    };
  }
}

class NodeDirectoryHandle {
  constructor(directoryPath) { this.directoryPath = directoryPath; }
  async getFileHandle(name) { return new NodeFileHandle(path.join(this.directoryPath, name)); }
  async getDirectoryHandle(name) {
    const directory = path.join(this.directoryPath, name);
    await mkdir(directory, { recursive: true });
    return new NodeDirectoryHandle(directory);
  }
}

const outputRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.test-output/p4-2');
await mkdir(outputRoot, { recursive: true });
const directory = new NodeDirectoryHandle(outputRoot);

// 有效 1x1 PNG；每次只让一个图片 Uint8Array 驻留内存。
const png = Uint8Array.from(Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64'
));
await packageComic({
  resources: [
    { url: 'https://fixture.test/10.png', title: '10.png' },
    { url: 'https://fixture.test/2.png', title: '2.png', domIndex: 2 },
    { url: 'https://fixture.test/1.png', title: '1.png', domIndex: 1 },
  ],
  mode: 'both',
  directoryHandle: directory,
  title: 'fixture-comic',
  source: 'https://fixture.test/chapter',
  fetchImpl: async () => new Response(png, { headers: { 'content-type': 'image/png' } }),
});

const chapters = Array.from({ length: 20 }, (_, index) => ({
  index,
  title: `第 ${index + 1} 章`,
  html: `<p xmlns="http://www.w3.org/1999/xhtml">这是第 ${index + 1} 章第一段。</p><p xmlns="http://www.w3.org/1999/xhtml">这是第二段。</p>`,
  text: `这是第 ${index + 1} 章第一段。这是第二段。`,
  url: `https://fixture.test/novel/${index + 1}`,
}));
await packageEpub({
  bookId: 'fixture-book',
  fileHandle: new NodeFileHandle(path.join(outputRoot, 'fixture-novel.epub')),
  getNovelImpl: async () => ({
    kind: 'novel', title: 'fixture-novel', author: 'WebGrab', source: 'https://fixture.test/novel', chapters,
  }),
  normalizeBodyImpl: (html) => html,
});

console.log(outputRoot);
