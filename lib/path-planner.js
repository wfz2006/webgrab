import { sanitizePackageName } from './package-utils.js';

export const MAX_RELATIVE_PATH_LENGTH = 260;

export const TYPE_LABELS = Object.freeze({
  comic: '漫画',
  novel: '小说',
  video: '视频',
  audio: '音频',
  image: '图片',
  other: '其他',
});

export const DEFAULT_PATH_TEMPLATES = Object.freeze({
  comic: '{root}/{类型}/{站点}/{作品}/{章节}.{ext}',
  novel: '{root}/{类型}/{站点}/{作品}.{ext}',
  video: '{root}/{类型}/{站点}/{标题}.{ext}',
  audio: '{root}/{类型}/{站点}/{标题}.{ext}',
  image: '{root}/{类型}/{站点}/{日期}/{标题}.{ext}',
  other: '{root}/{类型}/{站点}/{标题}.{ext}',
});

export const PATH_TOKENS = Object.freeze([
  'root', '类型', '站点', '作品', '章节', '序号', '标题', '日期', 'ext',
]);

const TOKEN_PATTERN = /\{(root|类型|站点|作品|章节|序号|标题|日期|ext)\}/g;

function dateString(value) {
  if (value) return String(value).slice(0, 10);
  return new Date().toISOString().slice(0, 10);
}

export function siteNameFromUrl(url) {
  try {
    const hostname = new URL(url).hostname.toLowerCase().replace(/^(?:www|m)\./, '');
    const parts = hostname.split('.').filter(Boolean);
    return parts.length > 1 ? parts.at(-2) : (parts[0] || '未知站点');
  } catch {
    return '未知站点';
  }
}

function cleanValue(value) {
  const text = String(value ?? '').trim();
  return text ? sanitizePackageName(text) : '';
}

export function createPathContext(input = {}) {
  const type = TYPE_LABELS[input.type] ? input.type : 'other';
  const title = input.title || input.fileName || input.chapter || input.work || '未命名';
  const work = input.work || (type === 'comic' || type === 'novel' ? title : '');
  const chapter = input.chapter || (type === 'comic' ? title : '');
  const extension = String(input.ext || input.extension || '').trim().replace(/^\.+/, '').toLowerCase();
  const sourceUrl = input.pageUrl || input.source || input.url || '';
  const site = Object.prototype.hasOwnProperty.call(input, 'site')
    ? input.site
    : (input.siteName || siteNameFromUrl(sourceUrl));
  return {
    type,
    root: cleanValue(input.root || 'WebGrab'),
    类型: cleanValue(input.typeLabel || TYPE_LABELS[type]),
    站点: cleanValue(site),
    作品: cleanValue(work),
    章节: cleanValue(chapter),
    序号: cleanValue(input.sequence ?? input.index ?? ''),
    标题: cleanValue(title),
    日期: cleanValue(dateString(input.date)),
    ext: cleanValue(extension || 'bin').replace(/^\.+/, ''),
  };
}

function renderSegments(template, values) {
  const source = String(template || DEFAULT_PATH_TEMPLATES[values.type] || DEFAULT_PATH_TEMPLATES.other);
  return source
    .split(/[\\/]+/)
    .map((segment) => segment.replace(TOKEN_PATTERN, (_match, token) => values[token] || ''))
    .map((segment) => segment.replace(/\.{2,}/g, '.').replace(/^[-_.\s]+|[-_.\s]+$/g, ''))
    .filter(Boolean)
    .map(sanitizePackageName);
}

function trimCodePoints(value, targetLength) {
  return Array.from(value).slice(0, Math.max(0, targetLength)).join('');
}

function fitValuesToMaxPath(template, initialValues, maxLength) {
  const values = { ...initialValues };
  let segments = renderSegments(template, values);
  let path = segments.join('/');
  const reductionOrder = ['作品', '章节', '标题', '站点', 'root', '类型'];

  for (const token of reductionOrder) {
    if (path.length <= maxLength) break;
    const current = Array.from(values[token] || '');
    if (current.length <= 1) continue;
    const excess = path.length - maxLength;
    values[token] = trimCodePoints(values[token], Math.max(1, current.length - excess));
    segments = renderSegments(template, values);
    path = segments.join('/');
  }

  if (path.length > maxLength) {
    const lastIndex = segments.length - 1;
    for (let index = lastIndex - 1; index >= 0 && path.length > maxLength; index--) {
      const current = Array.from(segments[index]);
      const excess = path.length - maxLength;
      segments[index] = sanitizePackageName(trimCodePoints(segments[index], Math.max(1, current.length - excess)));
      path = segments.join('/');
    }
  }

  if (path.length > maxLength && segments.length) {
    const index = segments.length - 1;
    const filename = segments[index];
    const dot = filename.lastIndexOf('.');
    const extension = dot > 0 ? filename.slice(dot) : '';
    const base = dot > 0 ? filename.slice(0, dot) : filename;
    const excess = path.length - maxLength;
    const sequence = values.序号 && base.includes(values.序号) ? values.序号 : '';
    const keep = Math.max(sequence.length, Array.from(base).length - excess);
    let nextBase = trimCodePoints(base, keep);
    if (sequence && !nextBase.includes(sequence)) nextBase = `${sequence}_${nextBase}`;
    segments[index] = sanitizePackageName(`${nextBase}${extension}`);
    path = segments.join('/');
  }

  return path;
}

export function renderPathTemplate(template, context, options = {}) {
  const values = context?.root && context?.类型 ? { ...context } : createPathContext(context);
  return fitValuesToMaxPath(template, values, options.maxLength || MAX_RELATIVE_PATH_LENGTH);
}

export function buildOrganizedPath(context, settings = {}) {
  const values = context?.root && context?.类型 ? context : createPathContext(context);
  const template = settings.templates?.[values.type]
    || DEFAULT_PATH_TEMPLATES[values.type]
    || DEFAULT_PATH_TEMPLATES.other;
  return renderPathTemplate(template, values, settings);
}
