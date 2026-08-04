import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
globalThis.fflate = require('../lib/fflate.min.js');
const { packageComic } = await import('../offscreen/comic-packager.js');

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
    const total = this.chunks.reduce((sum, item) => sum + item.length, 0);
    const out = new Uint8Array(total); let offset = 0;
    for (const item of this.chunks) { out.set(item, offset); offset += item.length; }
    return out;
  }
}

class MemoryDirectoryHandle {
  constructor() { this.files = new Map(); this.directories = new Map(); }
  async getFileHandle(name, options = {}) {
    if (!this.files.has(name) && !options.create) throw new DOMException('missing', 'NotFoundError');
    if (!this.files.has(name)) this.files.set(name, new MemoryFileHandle());
    return this.files.get(name);
  }
  async getDirectoryHandle(name, options = {}) {
    if (!this.directories.has(name) && !options.create) throw new DOMException('missing', 'NotFoundError');
    if (!this.directories.has(name)) this.directories.set(name, new MemoryDirectoryHandle());
    return this.directories.get(name);
  }
}

const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xdb, 1, 2, 0xff, 0xd9]);

function jpegWithMarker(marker) {
  return new Uint8Array([0xff, 0xd8, marker, 0xff, 0xd9]);
}

test('CBZ 按 DOM 顺序使用定长页名，单页失败后包仍可解压', async () => {
  const dir = new MemoryDirectoryHandle();
  const resources = [
    { url: 'https://cdn.test/10.jpg', title: '10.jpg' },
    { url: 'https://cdn.test/fail.jpg', title: '2.jpg', domIndex: 3 },
    { url: 'https://cdn.test/one.jpg', title: '1.jpg', domIndex: 1 },
  ];
  const fetchImpl = async (url) => {
    if (url.includes('fail')) return new Response('forbidden', { status: 403 });
    return new Response(JPEG, { status: 200, headers: { 'content-type': 'image/jpeg' } });
  };
  const progress = [];
  const result = await packageComic({
    resources, mode: 'cbz', directoryHandle: dir, title: '章节', source: 'https://site.test/chapter',
    fetchImpl, onProgress: (value) => progress.push(value),
  });

  assert.equal(result.successCount, 2);
  assert.equal(result.failureCount, 1);
  const files = globalThis.fflate.unzipSync(dir.files.get('章节.cbz').bytes());
  assert.deepEqual(Object.keys(files), ['001.jpg', '003.jpg', 'ComicInfo.xml']);
  assert.ok(files['001.jpg'].length > 0);
  assert.match(globalThis.fflate.strFromU8(files['ComicInfo.xml']), /PageCount>2</);
  assert.equal(progress.at(-1).completed, 3);
});

test('folder 模式写出图片和可双击的 index.html', async () => {
  const dir = new MemoryDirectoryHandle();
  const result = await packageComic({
    resources: [{ url: 'https://cdn.test/1.jpg', title: '1.jpg' }],
    mode: 'folder', directoryHandle: dir, title: '本地漫画', source: '',
    fetchImpl: async () => new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } }),
  });
  const folder = dir.directories.get('本地漫画');
  assert.equal(result.successCount, 1);
  assert.ok(folder.files.get('001.jpg').bytes().length > 0);
  const html = new TextDecoder().decode(folder.files.get('index.html').bytes());
  assert.match(html, /src="001\.jpg"/);
});

test('漫画图片有界并发完成且 CBZ 与本地索引仍按原始页序命名', async () => {
  const dir = new MemoryDirectoryHandle();
  let active = 0;
  let maxActive = 0;
  const delays = new Map([
    ['https://cdn.test/1.jpg', 30],
    ['https://cdn.test/2.jpg', 5],
    ['https://cdn.test/3.jpg', 15],
  ]);
  const resources = [1, 2, 3].map((index) => ({
    url: `https://cdn.test/${index}.jpg`,
    title: `${index}.jpg`,
    domIndex: index,
  }));

  const result = await packageComic({
    resources,
    mode: 'both',
    directoryHandle: dir,
    title: '并发漫画',
    source: '',
    concurrency: 3,
    fetchImpl: async (url) => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, delays.get(url)));
      active--;
      const marker = Number(new URL(url).pathname.match(/\d+/)[0]);
      return new Response(jpegWithMarker(marker), { headers: { 'content-type': 'image/jpeg' } });
    },
  });

  assert.equal(maxActive, 3);
  assert.equal(result.successCount, 3);
  const archiveFiles = globalThis.fflate.unzipSync(dir.files.get('并发漫画.cbz').bytes());
  for (let index = 1; index <= 3; index++) {
    const name = `00${index}.jpg`;
    assert.equal(archiveFiles[name][2], index);
  }
  const folder = dir.directories.get('并发漫画');
  const html = new TextDecoder().decode(folder.files.get('index.html').bytes());
  assert.ok(html.indexOf('001.jpg') < html.indexOf('002.jpg'));
  assert.ok(html.indexOf('002.jpg') < html.indexOf('003.jpg'));
});

test('漫画并发取消后不再领取新页面，但允许已发出的请求收尾', async () => {
  const dir = new MemoryDirectoryHandle();
  const controller = new AbortController();
  let started = 0;
  let releaseRequests;
  const requestGate = new Promise((resolve) => { releaseRequests = resolve; });
  const resources = Array.from({ length: 8 }, (_, index) => ({
    url: `https://cdn.test/cancel-${index + 1}.jpg`,
    title: `${index + 1}.jpg`,
    domIndex: index,
  }));

  const packaging = packageComic({
    resources,
    mode: 'folder',
    directoryHandle: dir,
    title: '取消漫画',
    signal: controller.signal,
    concurrency: 3,
    fetchImpl: async () => {
      started++;
      await requestGate;
      return new Response(JPEG, { headers: { 'content-type': 'image/jpeg' } });
    },
  });

  const deadline = Date.now() + 50;
  while (started < 3 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 1));
  controller.abort();
  releaseRequests();
  const result = await packaging;
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(started, 3);
  assert.equal(result.canceled, true);
  assert.equal(result.successCount, 3);
});
