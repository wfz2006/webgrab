import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, popup, tasks] = await Promise.all([
  readFile(new URL('../ui/popup.html', import.meta.url), 'utf8'),
  readFile(new URL('../ui/popup.js', import.meta.url), 'utf8'),
  readFile(new URL('../ui/tasks.js', import.meta.url), 'utf8'),
]);

test('批量操作条默认隐藏，选中后显示并可一键取消', () => {
  assert.match(html, /id="batch-bar"[^>]*hidden/);
  assert.match(html, /id="batch-cancel"/);
  assert.match(popup, /batchBar\.hidden\s*=\s*selectedInFilter\.length\s*===\s*0/);
  assert.match(popup, /batchCancel(?:Btn)?\.addEventListener\(['"]click['"]/);
  assert.match(popup, /selectedUrls\.clear\s*\(\)/);
});

test('失败原因默认折叠且通过无障碍按钮展开', () => {
  assert.match(tasks, /className\s*=\s*['"]task-error-toggle['"]/);
  assert.match(tasks, /setAttribute\(['"]aria-expanded['"],\s*['"]false['"]\)/);
  assert.match(tasks, /errorDetail\.hidden\s*=\s*true/);
  assert.match(tasks, /aria-controls/);
  assert.match(tasks, /查看原因/);
  assert.match(tasks, /task-btn task-btn-retry/);
});

test('资源与任务状态图标使用本地内联 SVG，不依赖 emoji 字符', () => {
  assert.match(popup, /KIND_ICON_PATHS/);
  assert.match(tasks, /STATUS_ICON_PATHS/);
  assert.doesNotMatch(tasks, /[⏳⬇📖💾📚✅❌⛔]/u);
});

test('工具栏任务徽章由 tasks.js 统一的任务表推导，不再单独轮询 GET_TASKS', () => {
  // 徽章渲染函数是纯同步函数，接收 tasks.js 算好的计数，不再自己发消息拉取任务表。
  assert.match(popup, /function renderTaskBadge\(count\)/);
  assert.doesNotMatch(
    popup,
    /async function (?:updateTaskBadge|renderTaskBadge)/,
    '徽章渲染不应再是异步函数——一旦又变成 async 就说明可能重新引入了独立的 GET_TASKS 拉取'
  );
  // 徽章计数通过回调订阅，而不是独立的 setInterval 轮询。
  assert.match(popup, /onActiveCountChange:\s*renderTaskBadge/);
  assert.doesNotMatch(
    popup,
    /setInterval\(\s*(?:updateTaskBadge|renderTaskBadge)\s*,/,
    '徽章不应再有自己的定时轮询——应完全由 tasks.js 的广播/兜底刷新驱动'
  );

  // tasks.js 一侧：updateSummary() 统计出的 active 数会通过回调发布出去，
  // 并且提供 getActiveCount() 供 popup.js 取初值。
  assert.match(tasks, /onActiveCountChange\?\.\(active\)/);
  assert.match(tasks, /getActiveCount/);
  assert.match(tasks, /ACTIVE_STATUSES/);
});
