import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = async (path) => readFile(new URL(path, root), 'utf8');

test('fflate 仅从扩展本地加载，且先于 offscreen 模块队列', async () => {
  const html = await read('offscreen/downloader.html');
  assert.match(html, /\.\.\/lib\/fflate\.min\.js/);
  assert.ok(html.indexOf('fflate.min.js') < html.indexOf('queue.js'));
  assert.doesNotMatch(html, /https?:\/\//);
  await read('lib/fflate.LICENSE.txt');
});

test('SW、下载管理器和 offscreen 队列完整接通两种打包任务', async () => {
  const sw = await read('background/sw.js');
  const manager = await read('background/download-manager.js');
  const queue = await read('offscreen/queue.js');
  assert.match(sw, /START_COMIC_PACKAGE/);
  assert.match(sw, /START_EPUB_PACKAGE/);
  assert.match(manager, /acquireResourceHeaderRules\(taskId, resources\)/);
  assert.match(manager, /kind: 'comic-package'/);
  assert.match(manager, /kind: 'epub-package'/);
  assert.match(queue, /packageComic/);
  assert.match(queue, /packageEpub/);
  assert.match(queue, /status = TaskStatus\.PACKING/);
});

test('popup 提供 CBZ、文件夹、两者都要和 EPUB 导出入口', async () => {
  const html = await read('ui/popup.html');
  const popup = await read('ui/popup.js');
  assert.match(html, /<option value="cbz">CBZ<\/option>/);
  assert.match(html, /<option value="folder">文件夹 \+ index<\/option>/);
  assert.match(html, /<option value="both">两者都要<\/option>/);
  assert.match(html, /id="novel-export-epub"[^>]*>导出 EPUB/);
  assert.match(popup, /START_COMIC_PACKAGE/);
  assert.match(popup, /START_EPUB_PACKAGE/);
  assert.match(popup, /domIndex/);
});
