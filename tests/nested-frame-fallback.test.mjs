import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const popup = await readFile(new URL('../ui/popup.js', import.meta.url), 'utf8');
const tasks = await readFile(new URL('../ui/tasks.js', import.meta.url), 'utf8');
const popupCss = await readFile(new URL('../ui/popup.css', import.meta.url), 'utf8');

test('用 window.self !== window.top 检测嵌套 iframe，不是复用 embeddedMode', () => {
  // 侧边栏也用 ?embedded=1，但侧边栏是真正的顶层文档，不该被当成嵌套环境处理
  assert.match(popup, /isNestedFrame\s*=\s*window\.self\s*!==\s*window\.top/);
});

test('单文件下载和 B 站下载在嵌套 iframe 里跳过会被拒绝的文件选择器', () => {
  assert.match(popup, /needsFileStreamable\(resource\)\s*&&\s*typeof window\.showDirectoryPicker === 'function'\s*&&\s*!isNestedFrame/);
  assert.match(popup, /typeof window\.showSaveFilePicker === 'function'\s*&&\s*!isNestedFrame/);
});

test('批量下载、漫画打包、EPUB 导出在嵌套 iframe 里给出明确引导而不是静默失败', () => {
  const guidanceCount = (popup.match(/工具栏图标或侧边栏/g) || []).length;
  assert.ok(guidanceCount >= 3, `期望至少 3 处引导文案（批量下载/漫画打包/EPUB 导出），实际 ${guidanceCount}`);
});

test('B 站视图在嵌套 iframe 里不渲染原生 select，直接给出顶层窗口引导', () => {
  assert.match(popup, /renderBiliView[\s\S]{0,400}isNestedFrame[\s\S]{0,300}bili-unsupported/);
});

test('任务面板独立判断嵌套 iframe，不依赖 popup IIFE 的局部变量', () => {
  assert.match(tasks, /const\s+isNestedFrame\s*=\s*window\.self\s*!==\s*window\.top\s*;/);
});

test('单任务和批量失败项重试在嵌套 iframe 中先显示引导并返回，不调用文件选择器', () => {
  const retryTask = tasks.slice(tasks.indexOf('async function retryTask'), tasks.indexOf('async function retryBatchFailures'));
  const retryBatch = tasks.slice(tasks.indexOf('async function retryBatchFailures'), tasks.indexOf('async function clearFinished'));
  const nestedGuard = /if\s*\(isNestedFrame\)\s*\{[\s\S]*?showTaskNotice\(task\.id,\s*NESTED_RETRY_GUIDANCE\);[\s\S]*?return;[\s\S]*?\}/;

  assert.match(retryTask, nestedGuard);
  assert.match(retryBatch, nestedGuard);
  assert.ok(retryTask.indexOf('if (isNestedFrame)') < retryTask.indexOf('showDirectoryPicker'));
  assert.ok(retryTask.indexOf('if (isNestedFrame)') < retryTask.indexOf('showSaveFilePicker'));
  assert.ok(retryBatch.indexOf('if (isNestedFrame)') < retryBatch.indexOf('showDirectoryPicker'));
});

test('嵌套重试引导渲染在任务卡片内，而不是只写 console', () => {
  assert.match(tasks, /NESTED_RETRY_GUIDANCE\s*=\s*['"][^'"]*悬浮窗里无法弹出选择框[^'"]*工具栏图标或侧边栏[^'"]*['"]/);
  assert.match(tasks, /function\s+showTaskNotice[\s\S]*?taskNotices\.set[\s\S]*?renderItem/);
  assert.match(tasks, /className\s*=\s*['"]task-action-notice['"][\s\S]*?textContent\s*=\s*taskNotices\.get/);
  assert.match(popupCss, /\.task-action-notice\s*\{/);
});
