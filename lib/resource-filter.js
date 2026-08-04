import { normalizeResourceFilters } from './resource-filter-settings.js';

/**
 * 判断资源是否应当被保留（未命中任何过滤规则）。纯函数，不接触 chrome.* API，
 * 供 background/resource-store.js 在入库前调用，也便于单测。
 * @param {Object} resource - 至少含 ext/mime/size/source/url
 * @param {Object} filters - normalizeResourceFilters() 产出的对象（未归一化也可，内部会再跑一次）
 * @returns {boolean}
 */
export function shouldKeepResource(resource, filters) {
  const rules = normalizeResourceFilters(filters);

  if (rules.showHookResources === false && resource?.source === 'hook') return false;

  const ext = String(resource?.ext || '').replace(/^\.+/, '').toLowerCase();
  if (ext && rules.extBlacklist.includes(ext)) return false;

  const mime = String(resource?.mime || '').toLowerCase();
  if (mime && rules.mimeBlacklist.some((blocked) => mime === blocked || mime.startsWith(blocked))) return false;

  const size = Number(resource?.size);
  if (Number.isFinite(size) && size >= 0) {
    const threshold = rules.minSizeBytes[resource?.kind];
    if (Number.isFinite(threshold) && threshold > 0 && size < threshold) return false;
  }

  const url = String(resource?.url || '');
  if (url && rules.urlBlacklistPatterns.length) {
    for (const pattern of rules.urlBlacklistPatterns) {
      try {
        if (new RegExp(pattern).test(url)) return false;
      } catch {
        // 无效正则视为不生效，不阻断其他规则
      }
    }
  }

  return true;
}
