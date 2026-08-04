/**
 * 站点适配器接口定义
 *
 * 每个站点适配器实现此接口，核心代码通过统一接口调用，
 * 不出现任何站点判断的 if/else 硬编码。
 *
 * P0 阶段仅定义接口，P3 阶段由 BilibiliAdapter 实现。
 */

/**
 * @typedef {Object} MediaVariant
 * @property {string} id              - 变体 ID（如 "video_32" / "audio_30216"）
 * @property {'video'|'audio'|'muxed'} kind
 * @property {string[]} urls          - 主 URL + backup URLs
 * @property {string} codecs          - 编码（如 "avc1.64001F"）
 * @property {number} [width]         - 视频宽度
 * @property {number} [height]        - 视频高度
 * @property {number} [bandwidth]     - 码率
 * @property {string} qualityLabel    - 质量标签（如 "1080P60"）
 */

/**
 * @typedef {Object} MediaPart
 * @property {number} [cid]           - 内容 ID（B 站的 cid）
 * @property {string} title           - 分 P 标题
 * @property {MediaVariant[]} variants - 可选的清晰度/编码变体
 */

/**
 * @typedef {Object} ExtractResult
 * @property {string} title           - 资源标题
 * @property {string} [cover]         - 封面 URL
 * @property {string} [uploader]      - UP 主 / 作者
 * @property {MediaPart[]} parts      - 分 P 列表
 */

/**
 * @typedef {Object} RequiredHeaders
 * @property {string} [Referer]
 * @property {string} [Origin]
 * @property {string} [User-Agent]
 */

/**
 * 站点适配器抽象基类
 * 子类必须实现 match() 和 extract()，其余可选
 */
export class SiteAdapter {
  /**
   * 是否接管此页面
   * @param {string} url
   * @returns {boolean}
   */
  static match(url) {
    return false;
  }

  /**
   * 从页面提取媒体信息
   * @param {number} tabId
   * @param {string} pageUrl
   * @returns {Promise<ExtractResult>}
   */
  async extract(tabId, pageUrl) {
    throw new Error('子类必须实现 extract()');
  }

  /**
   * 返回下载所需注入的请求头（供 DNR 使用）
   *
   * 注意：返回非空不代表"必须先注册 DNR 才能下载"——
   * 对于小文件直接下载路径，SW 会先尝试 chrome.downloads.download()，
   * 失败（如 SERVER_FORBIDDEN）后再用此处的 headers 注册临时 DNR，
   * 并切换到 offscreen + fetch 路径。DNR modifyHeaders 不能依赖于
   * chrome.downloads.download() 的请求管线生效。
   *
   * @param {string} url - 资源 URL
   * @param {string} [pageUrl] - 来源页面 URL（用于防盗链 Referer 注入）
   * @returns {RequiredHeaders}
   */
  requiredHeaders(url, pageUrl) {
    return {};
  }

  /**
   * 构建文件名
   * @param {ExtractResult} meta
   * @param {MediaVariant} variant
   * @returns {string}
   */
  buildFileName(meta, variant) {
    const title = sanitizeFileName(meta.title || 'webgrab');
    return `${title}_${variant.qualityLabel || 'unknown'}`;
  }

  /**
   * 后处理策略（合并 / 转码等）
   * @param {string[]} files
   * @returns {Promise<string>}
   */
  async postProcess(files) {
    return files[0] || '';
  }
}

/**
 * 净化文件名中的非法字符（Windows: \ / : * ? " < > |）
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFileName(name) {
  return name
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200); // Windows MAX_PATH 260 预留余量
}
