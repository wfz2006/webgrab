import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');

test('悬浮 iframe 指向 panel.html，panel 只复用 popup 而不复制业务脚本', () => {
  const companion = read('content/floating-companion.js');
  const panel = read('ui/panel.html');
  assert.match(companion, /ui\/panel\.html/);
  assert.match(panel, /popup\.html\?embedded=1/);
  assert.doesNotMatch(panel, /src="popup\.js"/);
  assert.doesNotMatch(panel, /id="list-container"/);
});

test('宿主页和 panel 的 postMessage 都校验来源窗口与 origin', () => {
  const companion = read('content/floating-companion.js');
  const panel = read('ui/panel.js');
  assert.match(companion, /event\.origin\s*!==\s*extensionOrigin/);
  assert.match(companion, /event\.source\s*!==\s*panelFrame\?\.contentWindow/);
  assert.match(panel, /event\.source\s*!==\s*window\.parent/);
  assert.match(panel, /new URL\(event\.data\.pageUrl\)\.origin/);
});

test('Esc 可从宿主页、panel 和嵌入 popup 关闭，关闭后焦点归还角色按钮', () => {
  const companion = read('content/floating-companion.js');
  const panel = read('ui/panel.js');
  const popup = read('ui/popup.js');
  assert.match(companion, /event\.key === 'Escape'/);
  assert.match(companion, /trigger\.focus\(\)/);
  assert.match(panel, /event\.key === 'Escape'/);
  assert.match(panel, /closeButton\.focus/);
  assert.match(popup, /WEBGRAB_POPUP_ESCAPE/);
});

test('面板提供可访问的关闭按钮和 iframe 标题', () => {
  const panel = read('ui/panel.html');
  assert.match(panel, /aria-label="关闭 WebGrab 资源面板"/);
  assert.match(panel, /title="WebGrab 完整资源嗅探页面"/);
});
