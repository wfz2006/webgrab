import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);
const read = (path) => readFile(new URL(path, root), 'utf8');

test('popup plans paths before all single, batch, comic, EPUB, and Bilibili tasks', async () => {
  const popup = await read('ui/popup.js');
  assert.match(popup, /async function planResourcePath/);
  assert.match(popup, /type: 'START_DOWNLOAD',[\s\S]*organizedPath: pathPlan\.organizedPath/);
  assert.match(popup, /type: 'START_BATCH_DOWNLOAD'/);
  assert.match(popup, /organizedPath: packagePlan\.organizedPath/);
  assert.match(popup, /type: 'START_EPUB_PACKAGE'[\s\S]*organizedPath: resolved\.relativePath/);
  assert.match(popup, /type: 'START_BILIBILI_DOWNLOAD'[\s\S]*organizedPath: pathPlan\?\.organizedPath/);
});

test('Chrome and File System Access backends consume the shared planned path', async () => {
  const [manager, serviceWorker, queue, comic] = await Promise.all([
    read('background/download-manager.js'),
    read('background/sw.js'),
    read('offscreen/queue.js'),
    read('offscreen/comic-packager.js'),
  ]);
  assert.match(manager, /resource\.organizedPath \|\| buildFileName/);
  assert.match(manager, /prepareChromeDownload/);
  assert.match(serviceWorker, /message\.organizedPath \|\| `WebGrab_Batch/);
  assert.match(queue, /resolveFilePath\(dirHandle, fileName, conflictStrategy\)/);
  assert.match(comic, /resolveFilePath\(directoryHandle, cbzPath, conflictStrategy\)/);
  assert.match(comic, /resolveDirectoryPath\(directoryHandle, folderPath, conflictStrategy\)/);
});

test('all three conflict strategies flow through settings and both backends', async () => {
  const [settings, chromePath, fileSystem] = await Promise.all([
    read('lib/path-settings.js'),
    read('lib/chrome-download-path.js'),
    read('lib/file-system-path.js'),
  ]);
  for (const strategy of ['uniquify', 'skip', 'overwrite']) {
    assert.match(settings, new RegExp(`['"]${strategy}['"]`));
    assert.match(fileSystem, new RegExp(`['"]${strategy}['"]`));
  }
  assert.match(chromePath, /strategy === 'skip'/);
  assert.match(chromePath, /strategy === 'overwrite'/);
});
