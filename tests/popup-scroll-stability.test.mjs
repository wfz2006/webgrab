import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const popup = await readFile(new URL('../ui/popup.js', import.meta.url), 'utf8');

function functionSlice(name, nextName) {
  const start = popup.indexOf(`function ${name}`);
  const end = popup.indexOf(`function ${nextName}`, start + 1);
  assert.ok(start >= 0 && end > start, `找不到函数范围: ${name} → ${nextName}`);
  return popup.slice(start, end);
}

test('render 不再无条件置空 listSizer，非空列表可复用外层滚动容器', () => {
  const render = functionSlice('render()', 'createResourceItem');
  assert.doesNotMatch(render, /listSizer\s*=\s*null/);
  assert.match(popup, /if\s*\(listSizer\s*&&\s*listSizer\.parentElement\s*===\s*listContainer\)\s*return\s+listSizer/);
});

test('空态仍会移除旧 sizer，新资源出现时由 parentElement 检查自然重建', () => {
  const render = functionSlice('render()', 'createResourceItem');
  assert.match(render, /currentFilteredResources\.length\s*===\s*0[\s\S]*?listContainer\.innerHTML\s*=\s*['"]{2}[\s\S]*?listContainer\.appendChild\(emptyState\)/);
  assert.match(render, /emptyState\.style\.display\s*=\s*['"]none['"][\s\S]*?renderWindow\(\)/);
});

test('轮询资源未变化时不执行 render，资源字段变化时仍会更新', () => {
  const loadResources = functionSlice('loadResources()', 'bindEvents');
  assert.match(popup, /function\s+hasResourceListChanged\s*\(previous,\s*next\)/);
  assert.match(loadResources, /const\s+nextResources\s*=\s*response\.data\.resources\s*\|\|\s*\[\]/);
  assert.match(loadResources, /if\s*\(!hasResourceListChanged\(allResources,\s*nextResources\)\)\s*return/);
  assert.ok(loadResources.indexOf('hasResourceListChanged') < loadResources.indexOf('render()'));
});
