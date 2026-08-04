/**
 * 兜底适配器 —— 所有未被特化适配器接管的页面走此适配器
 *
 * 不做任何站点特化逻辑，仅提供默认行为。
 */

import { SiteAdapter } from './base.js';

export class GenericAdapter extends SiteAdapter {
  /**
   * 兜底适配器匹配所有 URL
   * @param {string} url
   * @returns {boolean}
   */
  static match(url) {
    return true;
  }

  /**
   * 通用提取：不提取任何结构化信息，资源来自三层嗅探的原始 URL
   * @param {number} tabId
   * @param {string} pageUrl
   * @returns {Promise<ExtractResult>}
   */
  async extract(tabId, pageUrl) {
    let title = '';
    try {
      const tab = await chrome.tabs.get(tabId);
      title = tab.title || '';
    } catch {
      // 标签页可能已关闭
    }

    return {
      title: title || pageUrl,
      parts: [],
    };
  }

  /**
   * 通用兜底：返回来源页 Referer/Origin，应对 CDN 防盗链
   *
   * 仅当 pageUrl 可用且为 http(s) 时返回非空。
   * 实际注入时机由 SW 决定：
   *   - 小文件直接下载路径：首次 chrome.downloads.download() 不预注册 DNR，
   *     失败（SERVER_FORBIDDEN）后才用此 headers 注册临时 DNR，
   *     并切换到 offscreen + fetch
   *   - offscreen 路径（大文件 / fileHandle）：预注册 DNR
   *
   * @param {string} url
   * @param {string} [pageUrl]
   * @returns {RequiredHeaders}
   */
  requiredHeaders(url, pageUrl) {
    if (!pageUrl) return {};
    try {
      const u = new URL(pageUrl);
      if (u.protocol !== 'http:' && u.protocol !== 'https:') return {};
      return {
        Referer: pageUrl,
        Origin: `${u.protocol}//${u.host}`,
      };
    } catch {
      return {};
    }
  }

  /**
   * 通用文件名
   * @param {ExtractResult} meta
   * @param {MediaVariant} variant
   * @returns {string}
   */
  buildFileName(meta, variant) {
    const base = super.buildFileName(meta, variant);
    return `${base}`;
  }
}
