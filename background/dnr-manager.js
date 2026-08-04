/**
 * DNR (declarativeNetRequest) 规则管理器
 *
 * 职责：
 *   - 管理规则 ID 池（1000-1999，保留给下载任务）
 *   - acquire(taskId, { domains, headers }) → 分配 ID 并注入会话规则
 *   - release(taskId) → 回收规则
 *   - 扩展启动时清空遗留的 session rules
 *
 * 所有操作都在 SW 中执行（offscreen 无权调用 DNR API）。
 */

/** 规则 ID 段：下载任务专用 */
const RULE_ID_MIN = 1000;
const RULE_ID_MAX = 1999;

/** @type {Map<string, number[]>} taskId → ruleIds */
const taskRuleMap = new Map();

/** 空闲 ID 栈（从大到小压入，弹出时取最小的可用 ID） */
const freeIds = [];
for (let i = RULE_ID_MAX; i >= RULE_ID_MIN; i--) {
  freeIds.push(i);
}

/** 已分配的 ID 集合（用于快速查找） */
const usedIds = new Set();

/**
 * 分配一个空闲规则 ID
 * @returns {number|null}
 */
function allocateId() {
  while (freeIds.length > 0) {
    const id = freeIds.pop();
    if (!usedIds.has(id)) {
      usedIds.add(id);
      return id;
    }
  }
  return null;
}

/**
 * 回收规则 ID
 * @param {number} id
 */
function releaseId(id) {
  if (id >= RULE_ID_MIN && id <= RULE_ID_MAX) {
    usedIds.delete(id);
    freeIds.push(id);
  }
}

/**
 * 从 URL 提取域名
 * @param {string} url
 * @returns {string}
 */
function extractDomain(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * 为下载任务申请 DNR 规则
 * 注入 Referer / Origin / User-Agent 等请求头，绕过 CDN 防盗链。
 *
 * @param {string} taskId - 任务 ID
 * @param {{ domains?: string[], urls?: string[], headers: { Referer?: string, Origin?: string, 'User-Agent'?: string }, resourceTypes?: string[] }} options
 *        - resourceTypes: 可选，默认 ['xmlhttprequest']（适配 offscreen 的 fetch 请求）
 *          仅对明确需要的 fetch/XHR 场景扩展；不应将它用于尝试影响
 *          chrome.downloads.download() 的 Referer/Origin。
 * @returns {Promise<number|null>} 规则 ID，无需注入时返回 null
 */
export async function acquire(taskId, options) {
  const { headers } = options;
  if (!headers || Object.keys(headers).length === 0) {
    return null;
  }

  // 收集需要注入的域名
  let domains = options.domains || [];
  if (domains.length === 0 && options.urls) {
    domains = options.urls.map(extractDomain).filter(Boolean);
  }
  if (domains.length === 0) {
    return null;
  }

  const ruleId = allocateId();
  if (ruleId === null) {
    throw new Error('DNR 规则 ID 池已耗尽（1000-1999）');
  }

  // 构建请求头修改规则
  const requestHeaders = [];
  if (headers.Referer) {
    requestHeaders.push({ header: 'Referer', operation: 'set', value: headers.Referer });
  }
  if (headers.Origin) {
    requestHeaders.push({ header: 'Origin', operation: 'set', value: headers.Origin });
  }
  if (headers['User-Agent']) {
    requestHeaders.push({ header: 'User-Agent', operation: 'set', value: headers['User-Agent'] });
  }

  // resourceTypes 默认 xmlhttprequest（offscreen fetch 路径）
  const resourceTypes = options.resourceTypes || ['xmlhttprequest'];

  const rule = {
    id: ruleId,
    priority: 1,
    action: {
      type: 'modifyHeaders',
      requestHeaders,
    },
    condition: {
      requestDomains: domains,
      resourceTypes,
    },
  };

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      addRules: [rule],
    });
  } catch (err) {
    releaseId(ruleId);
    throw new Error(`DNR 规则注入失败: ${err.message}`);
  }

  const ruleIds = taskRuleMap.get(taskId) || [];
  ruleIds.push(ruleId);
  taskRuleMap.set(taskId, ruleIds);
  console.log(`[WebGrab] DNR 规则已申请: taskId=${taskId} ruleId=${ruleId} domains=${domains.join(',')}`);
  return ruleId;
}

/**
 * 回收下载任务的 DNR 规则
 * @param {string} taskId
 * @returns {Promise<void>}
 */
export async function release(taskId) {
  const ruleIds = taskRuleMap.get(taskId);
  if (!ruleIds || ruleIds.length === 0) return;

  try {
    await chrome.declarativeNetRequest.updateSessionRules({
      removeRuleIds: ruleIds,
    });
    console.log(`[WebGrab] DNR 规则已回收: taskId=${taskId} ruleIds=${ruleIds.join(',')}`);
  } catch (err) {
    console.error(`[WebGrab] DNR 规则回收失败: taskId=${taskId} ruleIds=${ruleIds.join(',')}`, err);
  }

  taskRuleMap.delete(taskId);
  for (const ruleId of ruleIds) {
    releaseId(ruleId);
  }
}

/**
 * 清空所有 DNR 会话规则（扩展启动/安装时调用）
 * @returns {Promise<void>}
 */
export async function cleanupAll() {
  try {
    // 获取当前所有会话规则
    const existingRules = await chrome.declarativeNetRequest.getSessionRules();
    // 只删除 1000-1999 范围内的规则
    const idsToRemove = existingRules
      .filter((r) => r.id >= RULE_ID_MIN && r.id <= RULE_ID_MAX)
      .map((r) => r.id);

    if (idsToRemove.length > 0) {
      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: idsToRemove,
      });
      console.log(`[WebGrab] DNR 清理: 移除 ${idsToRemove.length} 条遗留规则`);
    }

    // 重置内部状态
    taskRuleMap.clear();
    usedIds.clear();
    freeIds.length = 0;
    for (let i = RULE_ID_MAX; i >= RULE_ID_MIN; i--) {
      freeIds.push(i);
    }
  } catch (err) {
    console.error('[WebGrab] DNR 清理失败:', err);
  }
}

/**
 * 获取当前活跃的规则数量
 * @returns {number}
 */
export function getActiveCount() {
  return taskRuleMap.size;
}
