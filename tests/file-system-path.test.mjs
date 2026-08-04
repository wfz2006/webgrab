import test from 'node:test';
import assert from 'node:assert/strict';

import { resolveDirectoryPath, resolveFilePath } from '../lib/file-system-path.js';

class FakeFileHandle {
  constructor(name) { this.name = name; }
}

class FakeDirectoryHandle {
  constructor(name = '') {
    this.name = name;
    this.directories = new Map();
    this.files = new Map();
  }
  async getDirectoryHandle(name, options = {}) {
    if (this.directories.has(name)) return this.directories.get(name);
    if (!options.create) throw new DOMException('missing', 'NotFoundError');
    const directory = new FakeDirectoryHandle(name);
    this.directories.set(name, directory);
    return directory;
  }
  async getFileHandle(name, options = {}) {
    if (this.files.has(name)) return this.files.get(name);
    if (!options.create) throw new DOMException('missing', 'NotFoundError');
    const file = new FakeFileHandle(name);
    this.files.set(name, file);
    return file;
  }
}

test('resolveFilePath sanitizes every directory and file segment', async () => {
  const root = new FakeDirectoryHandle();
  const result = await resolveFilePath(root, 'WebGrab/漫画/A:B/CON/第1?话.cbz', 'overwrite');
  assert.equal(result.relativePath, 'WebGrab/漫画/A_B/CON_/第1_话.cbz');
  assert.equal(result.fileHandle.name, '第1_话.cbz');
  assert.ok(root.directories.get('WebGrab').directories.get('漫画').directories.get('A_B').directories.has('CON_'));
});

test('resolveFilePath implements rename, skip, and overwrite conflicts', async () => {
  const root = new FakeDirectoryHandle();
  await resolveFilePath(root, 'WebGrab/file.txt', 'overwrite');

  const renamed = await resolveFilePath(root, 'WebGrab/file.txt', 'uniquify');
  assert.equal(renamed.relativePath, 'WebGrab/file (2).txt');
  assert.equal(renamed.skipped, false);

  const skipped = await resolveFilePath(root, 'WebGrab/file.txt', 'skip');
  assert.equal(skipped.skipped, true);
  assert.equal(skipped.fileHandle, null);

  const overwritten = await resolveFilePath(root, 'WebGrab/file.txt', 'overwrite');
  assert.equal(overwritten.relativePath, 'WebGrab/file.txt');
  assert.equal(overwritten.skipped, false);
});

test('resolveDirectoryPath applies conflict policies to gallery folders', async () => {
  const root = new FakeDirectoryHandle();
  await resolveDirectoryPath(root, 'WebGrab/漫画/作品/章节', 'overwrite');
  assert.equal((await resolveDirectoryPath(root, 'WebGrab/漫画/作品/章节', 'skip')).skipped, true);
  const renamed = await resolveDirectoryPath(root, 'WebGrab/漫画/作品/章节', 'uniquify');
  assert.equal(renamed.relativePath, 'WebGrab/漫画/作品/章节 (2)');
});
