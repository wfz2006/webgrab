import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { getTaskPresentation, selectTabTask } from '../background/companion-manager.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('任务状态映射为角色状态和有界进度', () => {
  assert.deepEqual(getTaskPresentation({ status: 'downloading', downloaded: 25, total: 100 }), {
    phase: 'downloading', progress: 0.25, error: '', taskId: '', status: 'downloading',
  });
  assert.equal(getTaskPresentation({ status: 'extracting', downloaded: 2, total: 10 }).phase, 'scanning');
  assert.equal(getTaskPresentation({ status: 'done', downloaded: 10, total: 10 }).phase, 'done');
  assert.equal(getTaskPresentation({ status: 'failed', error: '403' }).phase, 'error');
  assert.equal(getTaskPresentation({ status: 'writing', downloaded: 999, total: 10 }).progress, 1);
});

test('同标签页优先选择活跃且最近更新的任务', () => {
  const selected = selectTabTask([
    { id: 'old', tabId: 7, status: 'done', createdAt: 100 },
    { id: 'other', tabId: 8, status: 'downloading', createdAt: 300 },
    { id: 'active', tabId: 7, status: 'packing', createdAt: 200 },
  ], 7);
  assert.equal(selected.id, 'active');
});

test('资源角标由 resource-store 的同一计数源发布', () => {
  const manager = fs.readFileSync(path.join(root, 'background', 'companion-manager.js'), 'utf8');
  const store = fs.readFileSync(path.join(root, 'background', 'resource-store.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'background', 'sw.js'), 'utf8');
  assert.match(manager, /getResourcesByTab/);
  assert.match(store, /setResourceChangeListener/);
  assert.match(sw, /setResourceChangeListener\s*\(/);
  assert.doesNotMatch(manager, /resourceCount\s*\+\+/);
});

test('所有 popup 下载入口把当前 tabId 交给同一任务表', () => {
  const popup = fs.readFileSync(path.join(root, 'ui', 'popup.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'background', 'sw.js'), 'utf8');
  assert.ok((popup.match(/tabId:\s*currentTabId/g) || []).length >= 5);
  assert.match(sw, /sourceTabId:\s*tabId/);
  assert.match(sw, /startDownload\([\s\S]*tabId/);
});

test('任务 upsert 是发布点，直接下载终态也不会漏掉角色状态', () => {
  const manager = fs.readFileSync(path.join(root, 'background', 'download-manager.js'), 'utf8');
  const sw = fs.readFileSync(path.join(root, 'background', 'sw.js'), 'utf8');
  assert.match(manager, /setTaskChangeListener/);
  assert.match(manager, /taskChangeListener\?\./);
  assert.match(sw, /setTaskChangeListener\s*\(/);
});
