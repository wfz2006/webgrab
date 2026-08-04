import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const tasks = await readFile(new URL('../ui/tasks.js', import.meta.url), 'utf8');

test('批量任务失败项有独立的重试入口，不会误用单文件重试路径', () => {
  assert.match(tasks, /function retryBatchFailures/);
  assert.match(tasks, /streamMeta\?\.kind\s*===\s*['"]batch['"]/);
  assert.match(tasks, /START_BATCH_DOWNLOAD/);
  // 单文件重试按钮必须显式排除 batch，否则会用 task.url（只是第一个资源）误重试整批
  assert.match(tasks, /!isBatch/);
});

test('重试失败项按钮从 diagnostics 反查原始资源，去重后只发失败的那些', () => {
  assert.match(tasks, /task\.streamMeta\?\.resources/);
  assert.match(tasks, /new Set\(\(task\.diagnostics[\s\S]{0,80}\.map\(\(item\) => item\.url\)/);
});
