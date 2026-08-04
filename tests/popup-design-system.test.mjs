import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const css = await readFile(new URL('../ui/popup.css', import.meta.url), 'utf8');
const html = await readFile(new URL('../ui/popup.html', import.meta.url), 'utf8');

test('popup 声明完整的颜色、字号、间距、圆角和动效 token', () => {
  for (const token of [
    '--neutral-950', '--neutral-900', '--neutral-800', '--neutral-700', '--neutral-600',
    '--neutral-500', '--neutral-400', '--neutral-300', '--neutral-200', '--neutral-100',
    '--accent', '--success', '--warning', '--error',
    '--font-11', '--font-12', '--font-13', '--font-15', '--font-18', '--font-22',
    '--space-1', '--space-2', '--space-3', '--space-4', '--space-6', '--space-8',
    '--radius-1', '--radius-2', '--radius-pill', '--motion-fast', '--motion-base',
  ]) assert.match(css, new RegExp(`${token.replace('-', '\\-')}\\s*:`), `缺少 ${token}`);
});

test('颜色只在 custom property 中声明，组件不散落色值', () => {
  const withoutTokens = css.split(/\r?\n/).filter((line) => !/^\s*--[\w-]+\s*:/.test(line)).join('\n');
  assert.doesNotMatch(withoutTokens, /#[0-9a-f]{3,8}\b|rgba?\s*\(/i);
  assert.doesNotMatch(css, /(?:linear|radial)-gradient\s*\(|backdrop-filter\s*:|\bfilter\s*:/i);
});

test('组件字号、圆角和间距声明使用规定 token', () => {
  for (const match of css.matchAll(/font-size\s*:\s*([^;]+);/g)) assert.match(match[1], /var\(--font-(?:11|12|13|15|18|22)\)/);
  for (const match of css.matchAll(/border-radius\s*:\s*([^;]+);/g)) assert.match(match[1], /^(?:0|var\(--radius-(?:1|2|pill)\))$/);
  for (const match of css.matchAll(/(?:^|[;{])\s*(?:padding(?:-[\w]+)?|margin(?:-[\w]+)?|gap)\s*:\s*([^;]+);/gm)) {
    assert.doesNotMatch(match[1], /\b(?:[1-9]\d*)px\b/, `间距值未走 token: ${match[1]}`);
  }
});

test('支持系统与强制明暗主题、等宽数字和减少动效', () => {
  assert.match(css, /@media\s*\(prefers-color-scheme:\s*light\)/);
  assert.match(css, /html\[data-theme="light"\]/);
  assert.match(css, /html\[data-theme="dark"\]/);
  assert.match(css, /font-variant-numeric:\s*tabular-nums/);
  assert.match(css, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  assert.match(css, /animation-duration:\s*0\.01ms/);
});

test('页面保持原生实现并具有可操作空状态', () => {
  assert.doesNotMatch(html, /react|vue|angular|bootstrap|tailwind/i);
  assert.match(html, /id="empty-refresh"/);
  assert.match(html, /播放视频|滚动图片/);
  assert.match(html, /RESOURCE CONSOLE/);
});
