/**
 * 文件名净化工具 —— 公共模块
 *
 * 处理 Windows 非法字符、保留名、长度截断、首尾空格和点号。
 * 供 SW、offscreen、popup 共同使用。
 */

/** Windows 保留设备名（不区分大小写） */
const RESERVED_NAMES = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

/** 最大文件名长度（给路径留余量，Windows MAX_PATH 260） */
const MAX_NAME_LENGTH = 200;

/**
 * 净化文件名
 * @param {string} name - 原始文件名
 * @returns {string} 净化后的文件名
 */
export function sanitizeFileName(name) {
  if (!name || typeof name !== 'string') return 'webgrab_download';

  let result = name;

  // 1. 替换 Windows 非法字符和控制字符
  // 非法：\ / : * ? " < > |
  // 控制字符：\x00-\x1f \x7f
  result = result.replace(/[\\/:*?"<>|]/g, '_');
  result = result.replace(/[\x00-\x1f\x7f]/g, '');

  // 2. 去除首尾空格和点号（Windows 不允许文件名以点号或空格结尾）
  result = result.replace(/^[\s.]+/, '');
  result = result.replace(/[\s.]+$/, '');

  // 3. 处理保留名
  // 检查去掉扩展名后的主名是否是保留名
  const dotIndex = result.lastIndexOf('.');
  const baseName = dotIndex > 0 ? result.slice(0, dotIndex) : result;
  if (RESERVED_NAMES.has(baseName.toUpperCase())) {
    result = '_' + result;
  }

  // 4. 长度截断（从中间截断，保留扩展名）
  if (result.length > MAX_NAME_LENGTH) {
    const ext = dotIndex > 0 ? result.slice(dotIndex) : '';
    const maxBase = MAX_NAME_LENGTH - ext.length;
    if (maxBase > 10) {
      // 从中间截断，保留头尾各一半
      const keepStart = Math.ceil(maxBase / 2);
      const keepEnd = Math.floor(maxBase / 2);
      result = result.slice(0, keepStart) + '…' + result.slice(result.length - keepEnd);
      // 重新拼接扩展名
      if (ext && !result.endsWith(ext)) {
        result = result.slice(0, keepStart) + '…' + result.slice(result.length - keepEnd, result.length - ext.length) + ext;
      }
    } else {
      result = result.slice(0, MAX_NAME_LENGTH);
    }
  }

  // 5. 最终检查：空字符串兜底
  if (!result || result === '.' || result === '..') {
    result = 'webgrab_download';
  }

  return result;
}

/**
 * 从 URL 构建建议文件名
 * @param {string} url - 资源 URL
 * @param {string} [title] - 资源标题
 * @param {string} [ext] - 扩展名（不含点）
 * @returns {string}
 */
export function buildFileName(url, title, ext) {
  let name = '';

  // 优先使用标题
  if (title && title.trim()) {
    name = title.trim();
  } else {
    // 从 URL 提取文件名
    try {
      const u = new URL(url);
      const path = u.pathname;
      const slash = path.lastIndexOf('/');
      name = slash !== -1 ? path.slice(slash + 1) : path;
    } catch {
      name = url.split('/').pop() || 'download';
    }
  }

  // 确保有扩展名
  const dotIndex = name.lastIndexOf('.');
  if (dotIndex <= 0) {
    // 没有扩展名或以点开头，追加已知扩展名
    if (ext) {
      name = name + '.' + ext;
    }
  }

  return sanitizeFileName(name);
}

/**
 * 文件名模板格式化
 *
 * 支持的变量：{title} {up} {bvid} {quality} {codec} {date} {p} {partTitle}
 * 空值会被替换为空字符串，连续下划线会被合并，首尾下划线会被去除。
 *
 * @param {string} tpl - 模板字符串，如 "{title}_{quality}" 或 "{title}_P{p}_{partTitle}_{quality}"
 * @param {Object} vars - 变量值
 * @returns {string} 格式化后的字符串（未净化，调用方负责 sanitize）
 */
export function formatTemplate(tpl, vars) {
  if (!tpl) return '';
  return tpl
    .replace(/\{(\w+)\}/g, (m, key) => {
      const v = vars[key];
      return v != null && v !== '' ? String(v) : '';
    })
    .replace(/_+/g, '_')   // 合并连续下划线
    .replace(/^_|_$/g, ''); // 去除首尾下划线
}

/**
 * 解析 SegmentBase.Initialization 字符串，返回 init segment 字节长度
 *
 * B 站的 segmentBase.initialization 形如 "0-974"，表示 init segment 是字节 0~974（共 975 字节）。
 *
 * @param {Object} segmentBase - { initialization: "0-974", indexRange: "975-1762" }
 * @returns {number} init segment 字节长度；解析失败返回 0
 */
export function parseSegmentBaseInitSize(segmentBase) {
  if (!segmentBase || !segmentBase.initialization) return 0;
  const parts = segmentBase.initialization.split('-');
  if (parts.length !== 2) return 0;
  const start = parseInt(parts[0], 10);
  const end = parseInt(parts[1], 10);
  if (isNaN(start) || isNaN(end) || end < start) return 0;
  return end - start + 1;
}
