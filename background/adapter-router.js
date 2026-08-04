/**
 * 站点适配器路由 —— 按 URL 派发到对应适配器
 *
 * P0 阶段只有 generic 兜底适配器。
 * P3 阶段新增 bilibili.js 后，在此注册并按 match() 优先级路由。
 * 核心代码中不得出现任何站点判断的 if/else 硬编码（决策约束 #6）。
 */

import { GenericAdapter } from '../adapters/generic.js';
import { BilibiliAdapter } from '../adapters/bilibili.js';

/**
 * 适配器注册表（按优先级排序，越靠前越优先）
 * @type {import('../adapters/base.js').SiteAdapter[]}
 */
const adapters = [
  BilibiliAdapter,  // P3: B 站深度适配，优先匹配
  GenericAdapter,
];

/**
 * 按 tabId + URL 路由到适配器
 * @param {number} tabId
 * @param {string} url
 * @returns {Promise<import('../adapters/base.js').SiteAdapter | null>}
 */
export async function routeByTab(tabId, url) {
  for (const adapter of adapters) {
    try {
      if (adapter.match(url)) {
        return adapter;
      }
    } catch (err) {
      console.warn('[WebGrab] 适配器匹配异常:', adapter.constructor.name, err);
    }
  }
  return null;
}

/**
 * 获取指定 URL 的适配器（同步）
 * @param {string} url
 * @returns {import('../adapters/base.js').SiteAdapter | null}
 */
export function getAdapterForUrl(url) {
  for (const adapter of adapters) {
    try {
      if (adapter.match(url)) return adapter;
    } catch {
      // continue
    }
  }
  return null;
}
