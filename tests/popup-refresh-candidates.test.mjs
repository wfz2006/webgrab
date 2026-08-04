import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const [html, popup] = await Promise.all([
  readFile(new URL('../ui/popup.html', import.meta.url), 'utf8'),
  readFile(new URL('../ui/popup.js', import.meta.url), 'utf8'),
]);

function functionSlice(name, nextName) {
  const start = popup.indexOf(`function ${name}`);
  const end = popup.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `找不到函数范围: ${name} → ${nextName}`);
  return popup.slice(start, end);
}

test('刷新按钮清空当前标签页缓存后重载真实网页，而不是重复读取缓存', () => {
  const refresh = functionSlice('refreshCurrentPage()', 'bindEvents');
  assert.match(refresh, /type:\s*['"]CLEAR_TAB['"]/);
  assert.match(refresh, /chrome\.tabs\.reload\(currentTabId,\s*\{\s*bypassCache:\s*true\s*\}\)/);
  assert.ok(refresh.indexOf('CLEAR_TAB') < refresh.indexOf('chrome.tabs.reload'));
  assert.doesNotMatch(refresh, /await\s+loadResources\(\)/);
  assert.match(html, /id="btn-refresh"[^>]*title="重新加载页面并重新嗅探"/);
});

test('媒体候选区明确区分主视频和推荐候选，并允许展开其他候选', () => {
  assert.match(html, /id="media-candidate-bar"[^>]*hidden/);
  assert.match(html, /id="media-candidate-toggle"/);
  assert.match(popup, /主视频/);
  assert.match(popup, /推荐候选/);
  assert.match(popup, /显示其他候选/);
  assert.match(popup, /buildMediaCandidateView/);
});

test('结构化主视频字段变化会触发资源列表重渲染', () => {
  assert.match(popup, /RESOURCE_RENDER_FIELDS[\s\S]*?['"]isPrimaryMedia['"]/);
});

test('候选 URL 没有可读文件名时仍显示可理解的名称', () => {
  assert.match(popup, /function\s+resourceDisplayName\s*\(resource\)/);
  assert.match(popup, /推荐视频候选/);
  assert.match(popup, /视频候选/);
  assert.match(popup, /name\.textContent\s*=\s*resourceDisplayName\(res\)/);
});
