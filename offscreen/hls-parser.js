/**
 * HLS (m3u8) 解析器 —— Offscreen Document 中使用
 *
 * 功能：
 *   - parseMasterPlaylist: 解析 master playlist，返回所有清晰度变体
 *   - parseMediaPlaylist:  解析 media playlist，返回分片列表
 *   - 支持 EXT-X-KEY AES-128（解密由 segment-fetcher 配合 WebCrypto 完成）
 *   - 支持 EXT-X-MAP（fMP4 init segment）
 *   - 支持 EXT-X-BYTERANGE
 *   - 处理相对 URL 拼接
 *
 * 设计原则：本模块只负责"解析"，不负责"下载"。
 *   解析结果是一个纯数据结构，由 segment-fetcher 消费。
 */

/**
 * @typedef {Object} HlsVariant
 * @property {string}   uri         - 变体的 media playlist URL（绝对 URL）
 * @property {number}   bandwidth   - 带宽（bps）
 * @property {string}   [codecs]    - 编码字符串（如 "avc1.64001f,mp4a.40.2"）
 * @property {number}   [width]
 * @property {number}   [height]
 * @property {number}   [frameRate]
 * @property {string}   [resolution]- "WIDTHxHEIGHT" 字符串（来自 RESOLUTION 属性）
 * @property {string}   [name]      - NAME 属性或由分辨率+带宽生成的标签
 * @property {Object}   [attributes]- 其他 ATTRIBUTES
 */

/**
 * @typedef {Object} HlsKey
 * @property {string}   method     - "NONE" | "AES-128" | "SAMPLE-AES"
 * @property {string}   [uri]      - key URL（绝对 URL）
 * @property {string}   [iv]       - 16 字节 IV 的 hex 字符串
 * @property {string}   [keyformat]
 * @property {string}   [keyformatversions]
 */

/**
 * @typedef {Object} HlsMap
 * @property {string}   uri        - init segment URL（绝对 URL）
 * @property {string}   [byteRange]- "start-end" 字符串
 */

/**
 * @typedef {Object} HlsSegment
 * @property {number}   sequence    - 分片序号（EXT-X-MEDIA-SEQUENCE 起始 + 索引）
 * @property {string}   uri         - 分片 URL（绝对 URL）
 * @property {number}   duration    - 分片时长（秒）
 * @property {string}   [byteRange] - "start-end" 字符串
 * @property {HlsKey}   [key]       - 解密密钥信息（继承自上级 EXT-X-KEY）
 * @property {HlsMap}   [map]       - init segment（继承自上级 EXT-X-MAP）
 * @property {number}   [programDateTime] - EXT-X-PROGRAM-DATE-TIME 时间戳
 * @property {boolean}  [discontinuity] - EXT-X-DISCONTINUITY 标记
 */

/**
 * @typedef {Object} HlsMediaPlaylist
 * @property {number}          version          - HLS 版本
 * @property {number}          targetDuration   - 最大分片时长
 * @property {number}          mediaSequence    - 起始序号
 * @property {HlsSegment[]}    segments         - 分片列表
 * @property {HlsKey|null}     key              - playlist 级别的默认 key
 * @property {HlsMap|null}     map              - playlist 级别的默认 init segment
 * @property {boolean}         isLive           - 是否是直播（无 EXT-X-ENDLIST）
 * @property {number}          totalDuration    - 总时长（秒，所有分片 duration 之和）
 * @property {string}          [playlistType]   - "VOD" | "EVENT"
 */

// ─── 主 playlist 解析 ────────────────────────────────────

/**
 * 解析 master playlist
 * @param {string} text - m3u8 文本
 * @param {string} baseUrl - 用于解析相对 URL 的基础 URL
 * @returns {{ variants: HlsVariant[], mediaGroups: Object }}
 */
export function parseMasterPlaylist(text, baseUrl) {
  if (!text.startsWith('#EXTM3U')) {
    throw new Error('不是有效的 m3u8 文件（缺少 #EXTM3U 头）');
  }

  const variants = [];
  const mediaGroups = {};
  let currentAttributes = {};

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXT-X-MEDIA:')) {
      // 处理 MEDIA 标签（AUDIO/VIDEO/SUBTITLES 分组）
      const attrs = parseAttributes(line.slice('#EXT-X-MEDIA:'.length));
      const type = attrs.TYPE;
      const groupId = attrs['GROUP-ID'];
      if (!mediaGroups[type]) mediaGroups[type] = {};
      if (!mediaGroups[type][groupId]) mediaGroups[type][groupId] = [];
      mediaGroups[type][groupId].push({
        type,
        groupId,
        name: attrs.NAME,
        language: attrs.LANGUAGE,
        defaultLanguage: attrs.DEFAULT === 'YES',
        autoselect: attrs.AUTOSELECT === 'YES',
        uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
      });
      continue;
    }

    if (line.startsWith('#EXT-X-STREAM-INF:')) {
      currentAttributes = parseAttributes(line.slice('#EXT-X-STREAM-INF:'.length));
      continue;
    }

    // 非 tag 行 + 上一行是 EXT-X-STREAM-INF → 这是 variant URI
    if (!line.startsWith('#') && currentAttributes.BANDWIDTH) {
      const variant = {
        uri: resolveUrl(line, baseUrl),
        bandwidth: parseInt(currentAttributes.BANDWIDTH, 10),
        codecs: currentAttributes.CODECS || '',
        resolution: currentAttributes.RESOLUTION || '',
        frameRate: currentAttributes['FRAME-RATE'] ? parseFloat(currentAttributes['FRAME-RATE']) : undefined,
        name: currentAttributes.NAME || '',
        audioGroup: currentAttributes.AUDIO,
        videoGroup: currentAttributes.VIDEO,
        subtitlesGroup: currentAttributes.SUBTITLES,
      };

      // 解析分辨率字符串
      if (variant.resolution) {
        const parts = variant.resolution.split('x');
        variant.width = parseInt(parts[0], 10);
        variant.height = parseInt(parts[1], 10);
      }

      // 生成可读标签
      if (!variant.name) {
        variant.name = variant.resolution
          ? `${variant.height}p`
          : `${Math.round(variant.bandwidth / 1000)}kbps`;
      }

      variants.push(variant);
      currentAttributes = {};
    }
  }

  // 按带宽降序排序（高质量在前）
  variants.sort((a, b) => b.bandwidth - a.bandwidth);

  return { variants, mediaGroups };
}

// ─── media playlist 解析 ─────────────────────────────────

/**
 * 解析 media playlist
 * @param {string} text - m3u8 文本
 * @param {string} baseUrl - 用于解析相对 URL 的基础 URL
 * @returns {HlsMediaPlaylist}
 */
export function parseMediaPlaylist(text, baseUrl) {
  if (!text.startsWith('#EXTM3U')) {
    throw new Error('不是有效的 m3u8 文件（缺少 #EXTM3U 头）');
  }

  let version = 0;
  let targetDuration = 0;
  let mediaSequence = 0;
  let playlistType = null;
  let isLive = true;
  let totalDuration = 0;

  /** @type {HlsKey|null} */
  let currentKey = null;
  /** @type {HlsMap|null} */
  let currentMap = null;

  /** @type {HlsSegment[]} */
  const segments = [];

  // 当前分片的临时状态
  let currentDuration = 0;
  let currentByteRange = null;
  let currentProgramDateTime = null;
  let currentDiscontinuity = false;
  let byteRangeOffset = 0;

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    // ── 全局信息标签 ──
    if (line.startsWith('#EXT-X-VERSION:')) {
      version = parseInt(line.slice('#EXT-X-VERSION:'.length), 10);
    } else if (line.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(line.slice('#EXT-X-TARGETDURATION:'.length), 10);
    } else if (line.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(line.slice('#EXT-X-MEDIA-SEQUENCE:'.length), 10);
    } else if (line.startsWith('#EXT-X-PLAYLIST-TYPE:')) {
      playlistType = line.slice('#EXT-X-PLAYLIST-TYPE:'.length);
    } else if (line === '#EXT-X-ENDLIST') {
      isLive = false;
    }
    // ── KEY 标签 ──
    else if (line.startsWith('#EXT-X-KEY:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-KEY:'.length));
      if (attrs.METHOD === 'NONE') {
        currentKey = null;
      } else {
        currentKey = {
          method: attrs.METHOD,
          uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
          iv: attrs.IV || null,
          keyformat: attrs.KEYFORMAT || 'identity',
          keyformatversions: attrs.KEYFORMATVERSIONS,
        };
      }
    }
    // ── MAP 标签（init segment） ──
    else if (line.startsWith('#EXT-X-MAP:')) {
      const attrs = parseAttributes(line.slice('#EXT-X-MAP:'.length));
      currentMap = {
        uri: attrs.URI ? resolveUrl(attrs.URI, baseUrl) : null,
        byteRange: attrs.BYTERANGE || null,
      };
    }
    // ── 分片属性标签 ──
    else if (line.startsWith('#EXTINF:')) {
      const rest = line.slice('#EXTINF:'.length);
      const [dur, ...titleParts] = rest.split(',');
      currentDuration = parseFloat(dur);
      // title 忽略
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      currentByteRange = line.slice('#EXT-X-BYTERANGE:'.length);
    } else if (line.startsWith('#EXT-X-PROGRAM-DATE-TIME:')) {
      currentProgramDateTime = Date.parse(line.slice('#EXT-X-PROGRAM-DATE-TIME:'.length));
    } else if (line === '#EXT-X-DISCONTINUITY') {
      currentDiscontinuity = true;
    }
    // ── 分片 URI 行 ──
    else if (!line.startsWith('#') && currentDuration > 0) {
      const segment = {
        sequence: mediaSequence + segments.length,
        uri: resolveUrl(line, baseUrl),
        duration: currentDuration,
        byteRange: currentByteRange,
        key: currentKey,
        map: currentMap,
        programDateTime: currentProgramDateTime,
        discontinuity: currentDiscontinuity,
      };

      // 处理 byteRange 的 offset 累计
      if (currentByteRange) {
        const { length, offset } = parseByteRange(currentByteRange, byteRangeOffset);
        segment.byteRange = `${offset}-${offset + length - 1}`;
        byteRangeOffset = offset + length;
      }

      segments.push(segment);
      totalDuration += currentDuration;

      // 重置分片临时状态
      currentDuration = 0;
      currentByteRange = null;
      currentProgramDateTime = null;
      currentDiscontinuity = false;
    }
  }

  return {
    version,
    targetDuration,
    mediaSequence,
    segments,
    key: segments.length > 0 ? segments[0].key : null,
    map: segments.length > 0 ? segments[0].map : null,
    isLive,
    totalDuration,
    playlistType,
  };
}

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 解析 m3u8 属性字符串
 * 格式：KEY=VALUE,KEY2="STRING VALUE",KEY3=0x1A2B
 * @param {string} attrStr
 * @returns {Object}
 */
function parseAttributes(attrStr) {
  const attrs = {};
  let i = 0;
  while (i < attrStr.length) {
    // 跳过空白和前导逗号
    while (i < attrStr.length && (attrStr[i] === ',' || attrStr[i] === ' ')) i++;
    if (i >= attrStr.length) break;

    // 读取 key
    const keyStart = i;
    while (i < attrStr.length && attrStr[i] !== '=') i++;
    const key = attrStr.slice(keyStart, i);
    if (i >= attrStr.length) break;
    i++; // 跳过 =

    // 读取 value
    let value;
    if (attrStr[i] === '"') {
      // 带引号的字符串
      i++; // 跳过开头引号
      const valStart = i;
      while (i < attrStr.length && attrStr[i] !== '"') i++;
      value = attrStr.slice(valStart, i);
      i++; // 跳过结尾引号
    } else {
      // 不带引号的值
      const valStart = i;
      while (i < attrStr.length && attrStr[i] !== ',') i++;
      value = attrStr.slice(valStart, i);
    }

    attrs[key] = value;
  }
  return attrs;
}

/**
 * 解析 byte range 字符串
 * @param {string} byteRangeStr - "length@offset" 或 "length"
 * @param {number} defaultOffset - 当未指定 offset 时的默认值
 * @returns {{length: number, offset: number}}
 */
function parseByteRange(byteRangeStr, defaultOffset) {
  const [lengthStr, offsetStr] = byteRangeStr.split('@');
  const length = parseInt(lengthStr, 10);
  const offset = offsetStr != null ? parseInt(offsetStr, 10) : defaultOffset;
  return { length, offset };
}

/**
 * 解析 URL（相对 → 绝对）
 * @param {string} uri
 * @param {string} baseUrl
 * @returns {string}
 */
function resolveUrl(uri, baseUrl) {
  if (!uri) return '';
  // 绝对 URL
  if (/^https?:\/\//i.test(uri)) return uri;
  // data URI
  if (uri.startsWith('data:')) return uri;
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    // URL 构造失败，简单拼接
    return baseUrl.replace(/\/[^/]*$/, '/') + uri;
  }
}

/**
 * 构造 AES-128 的 IV
 * IV 缺省时用分片序号构造（32 位序号左填充到 16 字节）
 * @param {string|null} ivHex - IV 的 hex 字符串
 * @param {number} sequence - 分片序号
 * @returns {Uint8Array} 16 字节 IV
 */
export function buildAesIv(ivHex, sequence) {
  if (ivHex) {
    // 去掉 0x 前缀，解析 hex
    const hex = ivHex.startsWith('0x') ? ivHex.slice(2) : ivHex;
    const bytes = new Uint8Array(16);
    for (let i = 0; i < Math.min(hex.length / 2, 16); i++) {
      bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
    }
    return bytes;
  }

  // 用分片序号构造：序号作为 32 位整数放在 16 字节的末尾
  const iv = new Uint8Array(16);
  const view = new DataView(iv.buffer);
  view.setUint32(12, sequence >>> 0, false); // big-endian
  return iv;
}
