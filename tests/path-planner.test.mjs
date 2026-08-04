import test from 'node:test';
import assert from 'node:assert/strict';

import {
  DEFAULT_PATH_TEMPLATES,
  buildOrganizedPath,
  createPathContext,
  renderPathTemplate,
} from '../lib/path-planner.js';

test('default templates create the documented type/site/work hierarchy', () => {
  assert.equal(buildOrganizedPath(createPathContext({
    type: 'comic', site: '动漫屋', work: '火锅家族第八季', chapter: '第27回 手链', ext: 'cbz',
  })), 'WebGrab/漫画/动漫屋/火锅家族第八季/第27回 手链.cbz');
  assert.equal(buildOrganizedPath(createPathContext({
    type: 'novel', site: '笔趣阁', work: '逆天邪神', ext: 'epub',
  })), 'WebGrab/小说/笔趣阁/逆天邪神.epub');
  assert.equal(buildOrganizedPath(createPathContext({
    type: 'video', site: '哔哩哔哩', title: '【互动视频】选择角色，结局由你来定', ext: 'mp4',
  })), 'WebGrab/视频/哔哩哔哩/【互动视频】选择角色，结局由你来定.mp4');
  assert.equal(buildOrganizedPath(createPathContext({
    type: 'image', site: 'SomeACG', date: '2026-07-31', title: '146071231_p0', ext: 'png',
  })), 'WebGrab/图片/SomeACG/2026-07-31/146071231_p0.png');
});

test('all required tokens render and every path segment is sanitized', () => {
  const context = createPathContext({
    root: 'Root', type: 'image', site: 'A:B', work: 'C?D', chapter: 'CON',
    sequence: '007', title: 'E*F', date: '2026-07-31', ext: '.jpg',
  });
  const rendered = renderPathTemplate(
    '{root}/{类型}/{站点}/{作品}/{章节}/{序号}-{标题}-{日期}.{ext}',
    context
  );
  assert.equal(rendered, 'Root/图片/A_B/C_D/CON_/007-E_F-2026-07-31.jpg');
});

test('empty tokens do not leave empty directory segments', () => {
  const context = createPathContext({ type: 'novel', site: '', work: '书名', ext: 'epub' });
  assert.equal(renderPathTemplate('{root}/{类型}/{站点}/{作品}.{ext}', context), 'WebGrab/小说/书名.epub');
});

test('custom template preview and actual path use the same planner output', () => {
  const context = createPathContext({ type: 'image', site: '站点', title: '标题', sequence: 3, ext: 'png' });
  const template = '{root}/自定义/{站点}/{序号}_{标题}.{ext}';
  const preview = renderPathTemplate(template, context);
  const actual = buildOrganizedPath(context, { templates: { image: template } });
  assert.equal(preview, actual);
  assert.equal(actual, 'WebGrab/自定义/站点/3_标题.png');
});

test('a long path stays within MAX_PATH while retaining extension and sequence', () => {
  const context = createPathContext({
    type: 'comic', site: '站'.repeat(80), work: '作'.repeat(100), chapter: '章'.repeat(100),
    title: '题'.repeat(100), sequence: '0007', ext: 'cbz',
  });
  const template = '{root}/{类型}/{站点}/{作品}/{章节}/{序号}_{标题}.{ext}';
  const path = renderPathTemplate(template, context);
  assert.ok(path.length <= 260, `path length was ${path.length}`);
  assert.ok(path.endsWith('.cbz'));
  assert.match(path.split('/').at(-1), /0007/);
  for (const segment of path.split('/')) {
    assert.ok(new TextEncoder().encode(segment).byteLength <= 255);
  }
});

test('every supported type has a default template', () => {
  for (const type of ['comic', 'novel', 'video', 'audio', 'image', 'other']) {
    assert.equal(typeof DEFAULT_PATH_TEMPLATES[type], 'string');
  }
});
