/**
 * 资源登记表 —— 去重、归类、持久化到 chrome.storage.session
 *
 * 所有状态写 chrome.storage.session，SW 重启后可恢复。
 * 内存中维护一份缓存用于快速查询，每次写入同步落盘。
 */

/** @typedef {'image'|'video'|'audio'|'subtitle'|'stream'} ResourceKind */
/** @typedef {'network'|'dom'|'hook'} ResourceSource */

/**
 * @typedef {Object} Resource
 * @property {string} id              - 唯一 ID（tabId + normalizedUrl 哈希）
 * @property {string} url             - 原始 URL
 * @property {ResourceKind} kind      - 资源类型
 * @property {string} ext             - 扩展名（不含点，如 "mp4"）
 * @property {string} [mime]          - MIME 类型
 * @property {number} [size]          - 文件大小（字节），未知为 -1
 * @property {number} tabId           - 标签页 ID
 * @property {number} frameId         - 帧 ID
 * @property {string} pageUrl         - 页面 URL
 * @property {ResourceSource} source  - 发现来源层
 * @property {Object} [requestHeaders]- 请求头（含 Referer、Cookie）
 * @property {number} discoveredAt    - 发现时间戳
 * @property {string} [title]         - 资源标题（页面的 title 或文件名推测）
 */

/** @type {Map<number, Map<string, Resource>>} tabId → (normalizedUrl → Resource) */
const cache = new Map();
let resourceChangeListener = null;

// ─── 资源过滤规则（P4-6） ────────────────────────────────
// 在入库前拦截，badge 计数和 popup 列表天然共用同一份已过滤缓存，不会再出现
// "角标数字和列表数量对不上"的问题——两者读的都是这份 cache。
import { DEFAULT_RESOURCE_FILTERS, loadResourceFilters, watchResourceFilters } from '../lib/resource-filter-settings.js';
import { shouldKeepResource } from '../lib/resource-filter.js';

let activeFilters = DEFAULT_RESOURCE_FILTERS;
loadResourceFilters().then((filters) => { activeFilters = filters; }).catch(() => {});
watchResourceFilters((filters) => { activeFilters = filters; });

export function setResourceChangeListener(listener) {
  resourceChangeListener = typeof listener === 'function' ? listener : null;
}

function notifyResourceChange(tabId, found = false) {
  const count = cache.get(tabId)?.size || 0;
  try {
    const result = resourceChangeListener?.({ tabId, count, found });
    if (result?.catch) result.catch(() => {});
  } catch {
    // 悬浮窗通知不能影响资源入库主流程。
  }
}

const STORAGE_PREFIX = 'webgrab_resources_';

function getTabStorageKey(tabId) {
  return `${STORAGE_PREFIX}${tabId}`;
}

/**
 * 已知时效性 query 参数名（统一小写比对）。
 * 覆盖通用签名/过期参数 + B 站 CDN 实测参数。
 */
const PARAMS_TO_STRIP = new Set([
  // ── 通用签名 / 过期 / 认证 ──
  'token', 'expires', 'expire', 'sign', 'signature',
  'auth_key', 'authkey', 'ts', 't', 'timestamp',
  'nonce', 'access_key', 'accesskey',
  'wts', 'w_rid', 'web_location',
  // ── AWS / CloudFront ──
  'x-amz-date', 'x-amz-signature', 'x-amz-credential',
  'x-amz-algorithm', 'x-amz-expires',
  'key-pair-id', 'policy',
  // ── B 站 CDN 实测参数（m4s 分片 URL） ──
  'deadline',      // Unix 过期时间戳
  'upsig',         // 上传签名
  'uipk',          // 用户 IP 密钥
  'e',             // 编码过期信息（长 base64 串）
  'oi',            // 订单索引（CDN 路由用，会变）
  'trid',          // 传输路由 ID
  'cv',            // 缓存版本
  'bvc_vod_id',    // BVC VOD ID
  'cdn',           // CDN 节点选择
  'ssign',         // 站点签名
  'bvcdn',         // BVC CDN
  'orderid',       // 订单 ID
  'gen',           // 生成版本
  'os',            // 源服务器
  'og',            // 来源
  'mid',           // 会员 ID（同一资源不同账号不同）
  'nbs',           // ?
  'slbc', 'slbr', 'slhd', 'slld', 'sldd', // 流媒体逻辑标志
  'p2p_type',      // P2P 类型
  'verno',         // 版本号
  'expire_info',   // 过期信息
  'duniq',         // 去重 ID
  'hpplays',       // ?
  'pts',           // 时间戳点
]);

/**
 * 判断某个 query 参数是否为时效性参数（应被剥离）。
 * 使用两层判定：已知名称 → 名称模式。
 * 不做"值模式猜测"——内容版本哈希（?v=<hash>）的值和签名一样长，
 * 但语义相反（区分内容而非时效），按值猜测会误合并不同资源。
 * @param {string} name  - 参数名（原始大小写）
 * @param {string} value - 参数值
 * @returns {boolean}
 */
function isTimeSensitiveParam(name, value) {
  const n = name.toLowerCase();

  // 1. 已知时效性参数名
  if (PARAMS_TO_STRIP.has(n)) return true;

  // 2. 参数名匹配签名 / 过期 / 随机数模式
  if (/^(.*)_?(sig|sign|token|expire|deadline|nonce|auth)$/i.test(n)) return true;
  if (n.endsWith('_rid') || n.endsWith('rid')) return true; // *_rid (w_rid, trid 等)

  return false;
}

// ─── URL 归一化（剥离时效性参数后比对去重） ──────────────────

/**
 * 归一化 URL：剥离时效性 query 参数，用于去重比对
 * @param {string} url
 * @returns {string}
 */
function normalizeUrl(url) {
  try {
    const u = new URL(url);
    const params = u.searchParams;
    // 遍历所有参数，删除时效性参数
    const toDelete = [];
    for (const [key, value] of params) {
      if (isTimeSensitiveParam(key, value)) {
        toDelete.push(key);
      }
    }
    for (const key of toDelete) {
      params.delete(key);
    }
    // 移除 hash 片段
    u.hash = '';
    return u.toString();
  } catch {
    // 非 URL 或 blob: 等，原样返回
    return url;
  }
}

/**
 * 简单字符串哈希（用于生成 ID）
 * @param {string} str
 * @returns {string}
 */
function hashStr(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) {
    h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(36);
}

// ─── 存储 I/O ──────────────────────────────────────────────

/**
 * 只持久化一个标签页的资源，避免任意资源变化都重写全部标签页。
 * @param {number} tabId
 * @returns {Promise<void>}
 */
async function persistTab(tabId) {
  const resources = cache.get(tabId);
  const storageKey = getTabStorageKey(tabId);
  if (!resources || resources.size === 0) {
    await chrome.storage.session.remove(storageKey);
    return;
  }
  await chrome.storage.session.set({
    [storageKey]: Array.from(resources.values()),
  });
}

/**
 * 从 session storage 恢复缓存（SW 重启后调用）
 * @returns {Promise<void>}
 */
export async function restoreFromStorage() {
  const storedValues = await chrome.storage.session.get(null);

  // 只补不清：sw.js 是先同步注册 webRequest 监听、再异步调用本函数的，
  // 嗅探器在这次 storage 读取往返期间完全可能已经写入过新资源。
  // 早先的 cache.clear() 会把这些资源静默丢掉，而它们此前的 persistTab
  // 又已经用"只有新资源"的数组覆盖过存储，导致缓存和存储双向丢数据。
  // 因此这里按 URL 合并，内存里已有的那份永远优先（它只会比磁盘更新）。
  const touchedTabIds = new Set();
  for (const [storageKey, resources] of Object.entries(storedValues)) {
    if (!storageKey.startsWith(STORAGE_PREFIX) || !Array.isArray(resources)) continue;
    const tabIdText = storageKey.slice(STORAGE_PREFIX.length);
    if (!/^\d+$/.test(tabIdText)) continue;
    const tabId = Number(tabIdText);
    if (!Number.isSafeInteger(tabId)) continue;

    let map = cache.get(tabId);
    if (!map) {
      map = new Map();
      cache.set(tabId, map);
    }
    let restoredAny = false;
    for (const res of resources) {
      if (!res || typeof res.url !== 'string') continue;
      const normUrl = normalizeUrl(res.url);
      if (map.has(normUrl)) continue;
      map.set(normUrl, res);
      restoredAny = true;
    }
    if (restoredAny) touchedTabIds.add(tabId);
  }

  // 把合并结果写回，修掉恢复窗口内 persistTab 用不完整缓存造成的覆盖。
  for (const tabId of touchedTabIds) {
    await persistTab(tabId);
    await updateBadge(tabId);
  }
}

// ─── 核心操作 ──────────────────────────────────────────────

/**
 * 添加一个资源（自动去重，已存在则合并信息）
 * @param {Partial<Resource> & { url: string; tabId: number }} resource
 * @returns {Promise<boolean>} 是否为新资源
 */
export async function addResource(resource) {
  const tabId = resource.tabId;
  if (tabId == null) return false;

  const resolvedExt = resource.ext || extractExt(resource.url);
  const resolvedKind = resource.kind || guessKind(resolvedExt, resource.mime);
  if (!shouldKeepResource({ ...resource, ext: resolvedExt, kind: resolvedKind }, activeFilters)) return false;

  const normUrl = normalizeUrl(resource.url);
  const id = `${tabId}_${hashStr(normUrl)}`;

  if (!cache.has(tabId)) {
    cache.set(tabId, new Map());
  }
  const tabMap = cache.get(tabId);

  const existing = tabMap.get(normUrl);
  if (existing) {
    // 合并：网络层拿到的 headers / size 可以补充 DOM 层的缺失
    let updated = false;
    if (resource.size && resource.size > 0 && (!existing.size || existing.size < 0)) {
      existing.size = resource.size;
      updated = true;
    }
    if (resource.mime && !existing.mime) {
      existing.mime = resource.mime;
      updated = true;
    }
    if (resource.requestHeaders && !existing.requestHeaders) {
      existing.requestHeaders = resource.requestHeaders;
      updated = true;
    }
    if (Number.isFinite(resource.domIndex) && !Number.isFinite(existing.domIndex)) {
      existing.domIndex = resource.domIndex;
      updated = true;
    }
    if (resource.isPrimaryMedia === true) {
      const primaryFields = [
        'kind', 'ext', 'mime', 'size', 'title', 'pageUrl', 'width', 'height',
        'duration', 'mediaId',
      ];
      for (const field of primaryFields) {
        const value = resource[field];
        if (value !== undefined && value !== null && value !== '' && existing[field] !== value) {
          existing[field] = value;
          updated = true;
        }
      }
      if (Array.isArray(resource.backupUrls)) {
        existing.backupUrls = [...resource.backupUrls];
        updated = true;
      }
      if (existing.isPrimaryMedia !== true) {
        existing.isPrimaryMedia = true;
        updated = true;
      }
    }
    // 如果已有网络层来源，不需要被 DOM 层覆盖来源标记
    // 但保留最早发现时间
    if (updated) {
      await persistTab(tabId);
    }
    return false;
  }

  /** @type {Resource} */
  const entry = {
    id,
    url: resource.url,
    kind: resolvedKind,
    ext: resolvedExt,
    mime: resource.mime || '',
    size: resource.size ?? -1,
    tabId,
    frameId: resource.frameId ?? 0,
    pageUrl: resource.pageUrl || '',
    source: resource.source || 'network',
    requestHeaders: resource.requestHeaders || null,
    discoveredAt: resource.discoveredAt ?? Date.now(),
    title: resource.title || '',
    domIndex: Number.isFinite(resource.domIndex) ? resource.domIndex : null,
    backupUrls: Array.isArray(resource.backupUrls) ? [...resource.backupUrls] : [],
    width: Number.isFinite(resource.width) ? resource.width : null,
    height: Number.isFinite(resource.height) ? resource.height : null,
    duration: Number.isFinite(resource.duration) ? resource.duration : null,
    isPrimaryMedia: resource.isPrimaryMedia === true,
    mediaId: resource.mediaId || '',
  };

  tabMap.set(normUrl, entry);
  await persistTab(tabId);
  await updateBadge(tabId);
  notifyResourceChange(tabId, true);
  return true;
}

/**
 * 获取指定标签页的所有资源
 * @param {number} tabId
 * @returns {Promise<Resource[]>}
 */
export async function getResourcesByTab(tabId) {
  const tabMap = cache.get(tabId);
  if (!tabMap) return [];
  return Array.from(tabMap.values()).sort((a, b) => b.discoveredAt - a.discoveredAt);
}

/**
 * 获取指定标签页的资源统计
 * @param {number} tabId
 * @returns {Promise<Object>}
 */
export async function getStatsByTab(tabId) {
  const resources = await getResourcesByTab(tabId);
  const stats = { total: 0, image: 0, video: 0, audio: 0, subtitle: 0, stream: 0 };
  for (const r of resources) {
    stats.total++;
    if (stats[r.kind] != null) stats[r.kind]++;
  }
  return stats;
}

/**
 * 清理指定标签页的所有资源
 * @param {number} tabId
 */
export function clearTab(tabId) {
  cache.delete(tabId);
  chrome.storage.session.remove(getTabStorageKey(tabId))
    .catch((err) => console.error('[WebGrab] 清理持久化失败:', err));
  updateBadge(tabId).catch(() => {});
  notifyResourceChange(tabId, false);
}

// ─── Badge ────────────────────────────────────────────────

/**
 * 更新扩展图标上的 badge 数字
 * @param {number} tabId
 * @returns {Promise<void>}
 */
export async function updateBadge(tabId) {
  const tabMap = cache.get(tabId);
  const count = tabMap ? tabMap.size : 0;
  const text = count > 0 ? String(count > 999 ? '999+' : count) : '';

  try {
    await chrome.action.setBadgeText({ text, tabId });
    await chrome.action.setBadgeBackgroundColor({ color: '#4A90D9', tabId });
  } catch (err) {
    // 标签页可能已关闭
  }
}

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 从 URL 中提取扩展名
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
    // blob: 或其他非标准 URL
    const dot = url.lastIndexOf('.');
    if (dot === -1) return '';
    const ext = url.slice(dot + 1).toLowerCase().split(/[?#]/)[0];
    return ext;
  }
}

/** @type {Record<string, ResourceKind>} */
const EXT_KIND_MAP = {
  // 视频
  mp4: 'video', webm: 'video', m4s: 'video', ts: 'video',
  flv: 'video', mkv: 'video', mov: 'video', m3u8: 'stream', mpd: 'stream',
  // 音频
  mp3: 'audio', m4a: 'audio', aac: 'audio', flac: 'audio',
  wav: 'audio', ogg: 'audio', opus: 'audio',
  // 图片
  jpg: 'image', jpeg: 'image', png: 'image', gif: 'image',
  webp: 'image', avif: 'image', svg: 'image', bmp: 'image', ico: 'image',
  // 字幕
  vtt: 'subtitle', srt: 'subtitle', ass: 'subtitle',
};

/** @type {Record<string, ResourceKind>} */
const MIME_KIND_MAP = {
  'video/': 'video',
  'audio/': 'audio',
  'image/': 'image',
  'application/vnd.apple.mpegurl': 'stream',
  'application/x-mpegurl': 'stream',
  'application/dash+xml': 'stream',
  'text/vtt': 'subtitle',
};

/**
 * 根据扩展名和 MIME 推断资源类型
 * @param {string} ext
 * @param {string} [mime]
 * @returns {ResourceKind}
 */
function guessKind(ext, mime) {
  if (ext && EXT_KIND_MAP[ext]) return EXT_KIND_MAP[ext];
  if (mime) {
    for (const [prefix, kind] of Object.entries(MIME_KIND_MAP)) {
      if (mime.startsWith(prefix)) return kind;
    }
  }
  return 'video'; // 默认归为视频
}

/**
 * 导出扩展名映射，供 sniffer-network 使用
 * @returns {Set<string>}
 */
export function getKnownExtensions() {
  return new Set(Object.keys(EXT_KIND_MAP));
}

/**
 * 导出扩展名→类型映射
 * @returns {Record<string, ResourceKind>}
 */
export function getExtKindMap() {
  return { ...EXT_KIND_MAP };
}
