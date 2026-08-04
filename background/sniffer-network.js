/**
 * L1 网络层嗅探 —— webRequest 监听
 *
 * 三阶段流水线：
 *   onBeforeRequest  → 快速 URL 预过滤，创建 pending 条目
 *   onSendHeaders    → 暂存请求头（Referer / Cookie），以 requestId 为 key
 *   onHeadersReceived → 读取 Content-Type / Content-Length，三维过滤后入库
 *   onCompleted / onErrorOccurred → 清理 pending，防止内存泄漏
 *
 * 三维过滤规则表：扩展名 + MIME + 大小阈值 + 正则黑名单
 */

import { addResource, getExtKindMap } from './resource-store.js';
import { parseResponseMetadata } from '../lib/http-response-metadata.js';

/** @type {Record<string, string>} 扩展名 → kind 映射 */
const EXT_KIND = getExtKindMap();

/**
 * @typedef {Object} FilterRule
 * @property {string} [ext]       - 匹配扩展名
 * @property {string} [mime]      - 匹配 MIME 前缀
 * @property {string} [regex]     - 正则表达式
 * @property {boolean} [blacklist] - 是否为黑名单规则
 * @property {number} [minSize]   - 最小大小阈值
 * @property {'KB'|'MB'} [unit]   - 大小单位
 * @property {boolean} enabled    - 是否启用
 */

/**
 * 默认过滤规则表
 * @type {FilterRule[]}
 */
const DEFAULT_RULES = [
  // ── 视频 ──
  { ext: 'mp4', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'webm', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'm4s', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'ts', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'flv', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'mkv', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'mov', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'video/', minSize: 100, unit: 'KB', enabled: true },
  // ── 流媒体清单 ──
  { ext: 'm3u8', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'mpd', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'application/vnd.apple.mpegurl', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'application/x-mpegurl', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'application/dash+xml', minSize: 0, unit: 'KB', enabled: true },
  // ── 音频 ──
  { ext: 'mp3', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'm4a', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'aac', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'flac', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'wav', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'ogg', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'opus', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'audio/', minSize: 30, unit: 'KB', enabled: true },
  // ── 图片 ──
  { ext: 'jpg', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'jpeg', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'png', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'gif', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'webp', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'avif', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'svg', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'bmp', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'ico', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'image/', minSize: 10, unit: 'KB', enabled: true },
  // ── 字幕 ──
  { ext: 'vtt', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'srt', minSize: 0, unit: 'KB', enabled: true },
  { ext: 'ass', minSize: 0, unit: 'KB', enabled: true },
  { mime: 'text/vtt', minSize: 0, unit: 'KB', enabled: true },
  // ── 黑名单（通用，站点特定规则由适配器提供） ──
  { regex: '/favicon', blacklist: true, enabled: true },
  { regex: '/avatar/', blacklist: true, enabled: true },
  { regex: 'data:', blacklist: true, enabled: true },
  { regex: 'blob:', blacklist: true, enabled: true },
];

/** 当前生效的规则（可从 storage.local 覆盖） */
let activeRules = DEFAULT_RULES;

/** 黑名单正则缓存 */
let blacklistRegexes = [];
/** 扩展名规则缓存 */
let extRules = [];
/** MIME 规则缓存 */
let mimeRules = [];

/**
 * 重新编译规则缓存
 */
function compileRules() {
  blacklistRegexes = [];
  extRules = [];
  mimeRules = [];
  for (const rule of activeRules) {
    if (!rule.enabled) continue;
    if (rule.blacklist && rule.regex) {
      try {
        blacklistRegexes.push(new RegExp(rule.regex, 'i'));
      } catch (e) {
        console.warn('[WebGrab] 无效正则:', rule.regex, e);
      }
    } else if (rule.ext) {
      extRules.push(rule);
    } else if (rule.mime) {
      mimeRules.push(rule);
    }
  }
}
compileRules();

/**
 * 从 URL 路径中提取扩展名
 * @param {string} url
 * @returns {string}
 */
function extractExt(url) {
  try {
    const u = new URL(url);
    const path = u.pathname;
    const dot = path.lastIndexOf('.');
    if (dot === -1) return '';
    return path.slice(dot + 1).toLowerCase();
  } catch {
    return '';
  }
}

/**
 * URL 黑名单检查
 * @param {string} url
 * @returns {boolean} true 表示被黑名单拦截
 */
function isBlacklisted(url) {
  for (const re of blacklistRegexes) {
    if (re.test(url)) return true;
  }
  return false;
}

/**
 * 大小阈值检查
 * @param {number} sizeBytes  - 实际大小（-1 表示未知）
 * @param {number} minSize    - 阈值数值
 * @param {'KB'|'MB'} unit    - 单位
 * @returns {boolean} true 表示通过（未知大小也通过）
 */
function checkSize(sizeBytes, minSize, unit) {
  if (sizeBytes < 0) return true; // 未知大小，放行
  const threshold = unit === 'MB' ? minSize * 1024 * 1024 : minSize * 1024;
  return sizeBytes >= threshold;
}

/**
 * 三维过滤：判断 URL + MIME + 大小 是否应捕获
 * @param {string} url
 * @param {string} mime
 * @param {number} sizeBytes
 * @returns {{pass: boolean, kind?: string, ext?: string}}
 */
function shouldCapture(url, mime, sizeBytes) {
  // 黑名单优先
  if (isBlacklisted(url)) return { pass: false };

  const ext = extractExt(url);

  // 扩展名匹配
  for (const rule of extRules) {
    if (rule.ext === ext) {
      if (checkSize(sizeBytes, rule.minSize || 0, rule.unit || 'KB')) {
        return { pass: true, kind: EXT_KIND[ext] || 'video', ext };
      }
    }
  }

  // MIME 匹配（扩展名没命中时）
  if (mime) {
    for (const rule of mimeRules) {
      if (mime.startsWith(rule.mime)) {
        if (checkSize(sizeBytes, rule.minSize || 0, rule.unit || 'KB')) {
          // 从 MIME 推断 kind
          let kind = 'video';
          if (mime.startsWith('audio/')) kind = 'audio';
          else if (mime.startsWith('image/')) kind = 'image';
          else if (mime.includes('mpegurl') || mime.includes('dash')) kind = 'stream';
          else if (mime === 'text/vtt') kind = 'subtitle';
          return { pass: true, kind, ext: ext || '' };
        }
      }
    }
  }

  return { pass: false };
}

// ─── Pending 请求表 ────────────────────────────────────────

/**
 * @typedef {Object} PendingRequest
 * @property {string} url
 * @property {number} tabId
 * @property {number} frameId
 * @property {string} method
 * @property {number} createdAt
 * @property {Object} [requestHeaders]  - 请求头键值对
 * @property {string} [contentType]     - 响应 Content-Type
 * @property {number} [contentLength]   - 响应 Content-Length
 * @property {boolean} [added]          - 是否已加入资源表
 */

/** @type {Map<string, PendingRequest>} requestId → pending */
const pending = new Map();

// 定期清理超时 pending（30 秒未完成的）
const CLEANUP_INTERVAL = 30_000;
const PENDING_TIMEOUT = 60_000;

setInterval(() => {
  const now = Date.now();
  for (const [id, req] of pending) {
    if (now - req.createdAt > PENDING_TIMEOUT) {
      pending.delete(id);
    }
  }
}, CLEANUP_INTERVAL);

// ─── webRequest 监听 ──────────────────────────────────────

const URL_FILTER = { urls: ['<all_urls>'] };
const EXTRA_HEADERS = ['extraHeaders', 'requestHeaders', 'responseHeaders'];

/**
 * 初始化嗅探器：注册所有 webRequest 监听
 */
export function initSniffer() {
  // ── onBeforeRequest：URL 预过滤 ──
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const { requestId, url, tabId, frameId, method } = details;

      // 只关注 GET 请求（媒体资源都是 GET）
      if (method !== 'GET') return;
      // 忽略非 HTTP(S)
      if (!url.startsWith('http')) return;

      // 快速预过滤：有已知扩展名 或 URL 含媒体相关路径
      const ext = extractExt(url);
      const hasKnownExt = ext && EXT_KIND[ext];
      if (!hasKnownExt) {
        // 没有已知扩展名的 URL 先放行，留给 onHeadersReceived 按 MIME 判断
        // 但做一些快速排除：明显不是媒体的路径
        if (!url.match(/\.(m4s|ts|mp4|webm|flv|mkv|mov|m3u8|mpd|mp3|m4a|aac|flac|wav|ogg|opus|jpg|jpeg|png|gif|webp|avif|svg|bmp|ico|vtt|srt|ass)(\?|#|$)/i)) {
          // 也没有明显的媒体路径特征，跳过（onHeadersReceived 还会兜底）
          return;
        }
      }

      // 黑名单快速排除
      if (isBlacklisted(url)) return;

      // 创建 pending 条目
      pending.set(requestId, {
        url,
        tabId,
        frameId: frameId ?? 0,
        method,
        createdAt: Date.now(),
        added: false,
      });
    },
    URL_FILTER
  );

  // ── onSendHeaders：暂存请求头 ──
  chrome.webRequest.onSendHeaders.addListener(
    (details) => {
      const { requestId, requestHeaders } = details;
      const entry = pending.get(requestId);
      if (!entry) return;

      // 提取关键请求头
      const headers = {};
      if (requestHeaders) {
        for (const h of requestHeaders) {
          const name = h.name.toLowerCase();
          if (name === 'referer' || name === 'cookie' || name === 'origin' ||
              name === 'user-agent' || name === 'range') {
            headers[name] = h.value;
          }
        }
      }
      entry.requestHeaders = headers;
    },
    URL_FILTER,
    ['requestHeaders', 'extraHeaders']
  );

  // ── onHeadersReceived：读取 Content-Type / Content-Length，三维过滤 ──
  chrome.webRequest.onHeadersReceived.addListener(
    (details) => {
      const { requestId, url, tabId, frameId, responseHeaders } = details;
      const responseMeta = parseResponseMetadata(responseHeaders);
      const contentType = responseMeta.contentType;
      // 206 的 Content-Length 只是当前 Range 大小，资源总大小来自 Content-Range。
      const contentLength = responseMeta.totalLength;

      // 三维过滤
      const result = shouldCapture(url, contentType, contentLength);
      if (!result.pass) return;

      // 如果在 pending 中，丰富信息后入库
      const entry = pending.get(requestId);
      if (entry) {
        entry.contentType = contentType;
        entry.contentLength = contentLength;
        if (entry.added) return; // 已入库，不重复添加
        entry.added = true;
      }

      // 加入资源表
      addResource({
        url,
        kind: /** @type {any} */ (result.kind),
        ext: result.ext || responseMeta.inferredExt || extractExt(url),
        mime: contentType,
        size: contentLength,
        tabId,
        frameId: frameId ?? 0,
        pageUrl: '', // onBeforeRequest 时无法获取页面 URL，由 content script 补充
        source: 'network',
        requestHeaders: entry?.requestHeaders || null,
      }).catch((err) => {
        console.error('[WebGrab] 资源入库失败:', err);
      });
    },
    URL_FILTER,
    ['responseHeaders', 'extraHeaders']
  );

  // ── onCompleted：清理 pending ──
  chrome.webRequest.onCompleted.addListener(
    (details) => {
      pending.delete(details.requestId);
    },
    URL_FILTER
  );

  // ── onErrorOccurred：清理 pending ──
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => {
      pending.delete(details.requestId);
    },
    URL_FILTER
  );
}

/**
 * 清理指定标签页的 pending 数据
 * @param {number} tabId
 */
export function disposeTab(tabId) {
  for (const [id, entry] of pending) {
    if (entry.tabId === tabId) {
      pending.delete(id);
    }
  }
}
