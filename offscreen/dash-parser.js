/**
 * DASH (MPD) 解析器 —— Offscreen Document 中使用
 *
 * 功能：
 *   - parseMpd: 解析 MPD，提取 AdaptationSet → Representation
 *   - 区分 video / audio track，各自列出可选质量
 *   - 处理 SegmentTemplate（$Number$ / $Time$ 占位符替换）与 SegmentList
 *   - 处理 BaseURL 继承与相对路径
 *
 * 设计原则：本模块只负责"解析"，不负责"下载"。
 */

/**
 * @typedef {Object} DashSegment
 * @property {number}   number    - 分片序号
 * @property {string}   uri       - 分片 URL（绝对 URL）
 * @property {number}   duration  - 分片时长（秒）
 * @property {number}   [startTime] - 分片起始时间（秒，DASH 用 timescale 计算）
 */

/**
 * @typedef {Object} DashRepresentation
 * @property {string}           id           - Representation ID
 * @property {number}           bandwidth    - 带宽
 * @property {number}           [width]
 * @property {number}           [height]
 * @property {number}           [frameRate]
 * @property {string}           codecs       - 编码字符串
 * @property {string}           [mimeType]
 * @property {DashSegment[]}    segments     - 分片列表
 * @property {string}           [initSegmentUri] - init segment URL
 * @property {number}           [timescale]  - 时间刻度
 */

/**
 * @typedef {Object} DashAdaptationSet
 * @property {string}                 id              - AdaptationSet ID
 * @property {'video'|'audio'}        contentType     - 内容类型
 * @property {string}                 [lang]          - 语言
 * @property {DashRepresentation[]}   representations - 可选质量列表
 */

/**
 * @typedef {Object} DashManifest
 * @property {number}                   duration       - 总时长（秒）
 * @property {boolean}                  isLive         - 是否直播
 * @property {number}                   minBufferTime  - 最小缓冲时间（秒）
 * @property {DashAdaptationSet[]}      adaptations    - 适配集列表
 */

// ─── MPD 解析 ────────────────────────────────────────────

/**
 * 解析 MPD 文件
 * @param {string} text - MPD XML 文本
 * @param {string} baseUrl - 用于解析相对 URL 的基础 URL
 * @returns {DashManifest}
 */
export function parseMpd(text, baseUrl) {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, 'application/xml');

  // 检查解析错误
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error('MPD XML 解析错误: ' + parseError.textContent);
  }

  const mpd = doc.querySelector('MPD');
  if (!mpd) {
    throw new Error('不是有效的 MPD 文件（缺少 MPD 根元素）');
  }

  const isLive = mpd.getAttribute('type') === 'dynamic';
  const mediaPresentationDuration = parseDuration(mpd.getAttribute('mediaPresentationDuration'));
  const minBufferTime = parseDuration(mpd.getAttribute('minBufferTime')) || 0;

  // 基础 URL 继承
  const mpdBaseUrl = getBaseUrl(mpd, baseUrl);

  const adaptations = [];
  const periodEls = doc.querySelectorAll('MPD > Period');
  for (const period of periodEls) {
    const periodBaseUrl = getBaseUrl(period, mpdBaseUrl);
    const periodDuration = parseDuration(period.getAttribute('duration')) || mediaPresentationDuration;

    const adaptationEls = period.querySelectorAll(':scope > AdaptationSet');
    for (const adaptionSet of adaptationEls) {
      const adaptation = parseAdaptationSet(adaptionSet, periodBaseUrl, periodDuration);
      if (adaptation) {
        adaptations.push(adaptation);
      }
    }
  }

  return {
    duration: mediaPresentationDuration || 0,
    isLive,
    minBufferTime,
    adaptations,
  };
}

// ─── AdaptationSet 解析 ──────────────────────────────────

/**
 * 解析 AdaptationSet
 *
 * DASH 规范允许 SegmentTemplate / SegmentList / SegmentBase 声明在 AdaptationSet 层级，
 * 由下面所有 Representation 共享继承（ Representation 自己的分段信息优先级更高，
 * 没有则回退到 AdaptationSet 层级的默认值）。很多真实流（包括 DASH-IF 参考流
 * Big Buck Bunny）就是这么写的——SegmentTemplate 在 AdaptationSet 层级，
 * Representation 自己只有属性、没有子元素。如果不处理继承，这类流会解析到 0 个分片。
 */
function parseAdaptationSet(el, parentBaseUrl, periodDuration) {
  const id = el.getAttribute('id') || '';
  const contentType = el.getAttribute('contentType') || guessContentType(el);
  const lang = el.getAttribute('lang') || '';

  if (contentType !== 'video' && contentType !== 'audio') {
    // 跳过字幕等非音视频
    return null;
  }

  const adaptationBaseUrl = getBaseUrl(el, parentBaseUrl);

  // 解析 AdaptationSet 层级的分段信息（作为 Representation 的默认值）
  const adaptationSegmentInfo = parseSegmentInfo(el, adaptationBaseUrl, periodDuration);

  const representations = [];

  const repEls = el.querySelectorAll(':scope > Representation');
  for (const repEl of repEls) {
    const rep = parseRepresentation(repEl, adaptationBaseUrl, periodDuration, contentType, adaptationSegmentInfo);
    if (rep) {
      representations.push(rep);
    }
  }

  // 按带宽降序排序
  representations.sort((a, b) => b.bandwidth - a.bandwidth);

  return { id, contentType, lang, representations };
}

/**
 * 从一个元素（AdaptationSet 或 Representation）解析分段信息
 *
 * 按优先级查找：SegmentList > SegmentTemplate > SegmentBase
 * 返回 null 表示该元素没有声明分段信息（调用方应该用继承的默认值）。
 *
 * @param {Element} el - AdaptationSet 或 Representation 元素
 * @param {string} baseUrl - 该元素对应的 BaseURL
 * @param {number} periodDuration - Period 时长（秒）
 * @param {string} [representationId] - Representation ID（SegmentTemplate 占位符用），AdaptationSet 层级传空
 * @param {number} [representationBandwidth] - Representation 带宽（占位符用）
 * @returns {{segments: Array, initSegmentUri: string|null, timescale: number}|null}
 */
function parseSegmentInfo(el, baseUrl, periodDuration, representationId = '', representationBandwidth = 0) {
  const segmentListEl = el.querySelector(':scope > SegmentList');
  const segmentTemplateEl = el.querySelector(':scope > SegmentTemplate');
  const segmentBaseEl = el.querySelector(':scope > SegmentBase');

  if (segmentListEl) {
    return parseSegmentList(segmentListEl, baseUrl, periodDuration);
  }
  if (segmentTemplateEl) {
    return parseSegmentTemplate(segmentTemplateEl, baseUrl, periodDuration, representationId, representationBandwidth);
  }
  if (segmentBaseEl) {
    return parseSegmentBase(segmentBaseEl, baseUrl);
  }
  return null;
}

/**
 * 解析 Representation
 *
 * 分段信息优先级：Representation 自己的 > AdaptationSet 继承的 > BaseURL 单文件兜底
 *
 * @param {Element} el
 * @param {string} parentBaseUrl
 * @param {number} periodDuration
 * @param {string} contentType
 * @param {{segments: Array, initSegmentUri: string|null, timescale: number}|null} [inheritedInfo]
 *        从 AdaptationSet 继承的分段信息，Representation 没有自己的分段元素时使用
 */
function parseRepresentation(el, parentBaseUrl, periodDuration, contentType, inheritedInfo = null) {
  const id = el.getAttribute('id') || '';
  const bandwidth = parseInt(el.getAttribute('bandwidth') || '0', 10);
  const width = parseInt(el.getAttribute('width') || '0', 10) || undefined;
  const height = parseInt(el.getAttribute('height') || '0', 10) || undefined;
  const frameRate = parseFloat(el.getAttribute('frameRate') || '0') || undefined;
  const codecs = el.getAttribute('codecs') || '';
  const mimeType = el.getAttribute('mimeType') || '';

  const repBaseUrl = getBaseUrl(el, parentBaseUrl);

  // 优先用 Representation 自己的分段信息；没有则用从 AdaptationSet 继承的
  // 注意：SegmentTemplate 的 $RepresentationID$ / $Bandwidth$ 占位符需要用 Representation 的属性替换，
  // 所以继承时要带上 Representation 的 id 和 bandwidth 重新解析
  let ownInfo = parseSegmentInfo(el, repBaseUrl, periodDuration, id, bandwidth);

  let segments = [];
  let initSegmentUri = null;
  let timescale = 1;

  if (ownInfo) {
    segments = ownInfo.segments;
    initSegmentUri = ownInfo.initSegmentUri;
    timescale = ownInfo.timescale;
  } else if (inheritedInfo) {
    // AdaptationSet 层级的 SegmentTemplate 已经在 parseAdaptationSet 里用空 representationId 解析过了，
    // 但 $RepresentationID$ / $Bandwidth$ 占位符需要用真实 Representation 的属性重新替换。
    // 检查 inheritedInfo 是否需要重解析：如果原始 media/initialization 模板含占位符，
    // segments 里的 uri 会是空 representationId 替换后的结果，需要重做。
    // 简化做法：直接重新解析 AdaptationSet 层级的分段元素，用当前 Representation 的 id/bandwidth。
    ownInfo = parseSegmentInfo(el.parentElement, repBaseUrl, periodDuration, id, bandwidth);
    if (ownInfo) {
      segments = ownInfo.segments;
      initSegmentUri = ownInfo.initSegmentUri;
      timescale = ownInfo.timescale;
    } else {
      // parseSegmentInfo 在 el.parentElement 上应该能找到（因为 inheritedInfo 非空说明父级有）
      // 走到这里是异常情况，用继承的原值
      segments = inheritedInfo.segments;
      initSegmentUri = inheritedInfo.initSegmentUri;
      timescale = inheritedInfo.timescale;
    }
  } else if (repBaseUrl && repBaseUrl !== parentBaseUrl) {
    // 没有分段信息，但 Representation 有自己的 BaseURL → 单文件
    segments = [{ number: 0, uri: repBaseUrl, duration: periodDuration, startTime: 0 }];
  } else if (mimeType) {
    // 单文件 Representation（继承父 BaseURL）
    segments = [{ number: 0, uri: parentBaseUrl, duration: periodDuration, startTime: 0 }];
  }

  return {
    id,
    bandwidth,
    width,
    height,
    frameRate,
    codecs,
    mimeType,
    segments,
    initSegmentUri,
    timescale,
  };
}

// ─── SegmentList 解析 ────────────────────────────────────

function parseSegmentList(el, baseUrl, periodDuration) {
  const timescale = parseInt(el.getAttribute('timescale') || '1', 10);
  const duration = parseInt(el.getAttribute('duration') || '0', 10);
  const startNumber = parseInt(el.getAttribute('startNumber') || '1', 10);

  let initSegmentUri = null;
  const initializationEl = el.querySelector(':scope > Initialization');
  if (initializationEl) {
    const sourceURL = initializationEl.getAttribute('sourceURL');
    const range = initializationEl.getAttribute('range');
    initSegmentUri = sourceURL ? resolveUrl(sourceURL, baseUrl) : baseUrl;
    if (range) {
      initSegmentUri += '#range=' + range; // 用 hash 传递 range 信息
    }
  }

  const segments = [];
  const segmentUrls = el.querySelectorAll(':scope > SegmentURL');
  let currentTime = 0;
  for (let i = 0; i < segmentUrls.length; i++) {
    const segEl = segmentUrls[i];
    const media = segEl.getAttribute('media');
    const segDuration = duration / timescale; // 秒
    segments.push({
      number: startNumber + i,
      uri: media ? resolveUrl(media, baseUrl) : baseUrl,
      duration: segDuration,
      startTime: currentTime,
    });
    currentTime += segDuration;
  }

  return { segments, initSegmentUri, timescale };
}

// ─── SegmentTemplate 解析 ────────────────────────────────

function parseSegmentTemplate(el, baseUrl, periodDuration, representationId = '', bandwidth = 0) {
  const timescale = parseInt(el.getAttribute('timescale') || '1', 10);
  const duration = parseInt(el.getAttribute('duration') || '0', 10);
  const startNumber = parseInt(el.getAttribute('startNumber') || '1', 10);
  const mediaTemplate = el.getAttribute('media') || '';
  const initializationTemplate = el.getAttribute('initialization') || '';

  /** 占位符替换上下文 */
  const ctx = { representationId, number: startNumber, time: 0, bandwidth };

  let initSegmentUri = null;
  if (initializationTemplate) {
    initSegmentUri = resolveUrl(
      replaceTemplatePlaceholders(initializationTemplate, { ...ctx, number: startNumber }),
      baseUrl
    );
  }

  const segments = [];

  // 优先用 SegmentTimeline 精确计算
  const timelineEl = el.querySelector(':scope > SegmentTimeline');
  if (timelineEl) {
    const sEls = timelineEl.querySelectorAll(':scope > S');
    let currentTime = 0;
    let segNumber = startNumber;
    for (const sEl of sEls) {
      const t = parseInt(sEl.getAttribute('t') || '0', 10);
      const d = parseInt(sEl.getAttribute('d') || '0', 10);
      const r = parseInt(sEl.getAttribute('r') || '0', 10);

      if (t) currentTime = t;

      const repeatCount = r >= 0 ? r + 1 : 1;
      for (let i = 0; i < repeatCount; i++) {
        const segDuration = d / timescale;
        const uri = resolveUrl(
          replaceTemplatePlaceholders(mediaTemplate, {
            representationId,
            number: segNumber,
            time: currentTime,
            bandwidth,
          }),
          baseUrl
        );
        segments.push({
          number: segNumber,
          uri,
          duration: segDuration,
          startTime: currentTime / timescale,
        });
        currentTime += d;
        segNumber++;
      }
    }
  } else if (duration > 0) {
    // 用 duration + periodDuration 计算
    const segDurationSec = duration / timescale;
    const segCount = periodDuration > 0 ? Math.ceil(periodDuration / segDurationSec) : 0;
    for (let i = 0; i < segCount; i++) {
      const segNumber = startNumber + i;
      const time = i * duration;
      const uri = resolveUrl(
        replaceTemplatePlaceholders(mediaTemplate, {
          representationId,
          number: segNumber,
          time,
          bandwidth,
        }),
        baseUrl
      );
      segments.push({
        number: segNumber,
        uri,
        duration: segDurationSec,
        startTime: time / timescale,
      });
    }
  }

  return { segments, initSegmentUri, timescale };
}

// ─── SegmentBase 解析 ────────────────────────────────────

function parseSegmentBase(el, baseUrl) {
  const timescale = parseInt(el.getAttribute('timescale') || '1', 10);

  let initSegmentUri = null;
  const initializationEl = el.querySelector(':scope > Initialization');
  if (initializationEl) {
    const sourceURL = initializationEl.getAttribute('sourceURL');
    const range = initializationEl.getAttribute('range');
    initSegmentUri = sourceURL ? resolveUrl(sourceURL, baseUrl) : baseUrl;
    if (range) {
      initSegmentUri += '#range=' + range;
    }
  }

  const segments = [];
  // SegmentBase 通常用于单文件，用 IndexRange 指定索引范围
  // 这里简化处理：把整个 BaseURL 作为一个分片
  segments.push({ number: 0, uri: baseUrl, duration: 0, startTime: 0 });

  return { segments, initSegmentUri, timescale };
}

// ─── 辅助函数 ────────────────────────────────────────────

/**
 * 替换 SegmentTemplate 占位符
 * $Number$ → number
 * $Time$ → time
 * $RepresentationID$ → representationId
 * $Bandwidth$ → bandwidth
 */
function replaceTemplatePlaceholders(template, { representationId, number, time, bandwidth }) {
  return template
    .replace(/\$\$()/g, '$$') // 转义的 $$
    .replace(/\$RepresentationID\$/g, representationId || '')
    .replace(/\$Number\$/g, String(number || 0))
    .replace(/\$Time\$/g, String(time || 0))
    .replace(/\$Bandwidth\$/g, String(bandwidth || 0));
}

/**
 * 获取 BaseURL 元素（继承自父级）
 */
function getBaseUrl(el, parentBaseUrl) {
  const baseUrlEl = el.querySelector(':scope > BaseURL');
  if (baseUrlEl && baseUrlEl.textContent.trim()) {
    return resolveUrl(baseUrlEl.textContent.trim(), parentBaseUrl);
  }
  return parentBaseUrl;
}

/**
 * 解析 ISO 8601 duration（PT1H2M3.5S 格式）
 * @param {string|null} durationStr
 * @returns {number} 秒
 */
function parseDuration(durationStr) {
  if (!durationStr) return 0;
  const match = durationStr.match(/^P(?:T(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?)?$/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseFloat(match[3] || '0');
  return hours * 3600 + minutes * 60 + seconds;
}

/**
 * 猜测 contentType
 */
function guessContentType(el) {
  const mimeType = el.getAttribute('mimeType') || '';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';

  // 从子元素 codecs 推断
  const repEl = el.querySelector(':scope > Representation');
  if (repEl) {
    const codecs = (repEl.getAttribute('codecs') || '').toLowerCase();
    if (codecs.startsWith('avc') || codecs.startsWith('hev') || codecs.startsWith('av01')) return 'video';
    if (codecs.startsWith('mp4a') || codecs.startsWith('aac') || codecs.startsWith('opus')) return 'audio';
  }

  return '';
}

/**
 * 解析 URL（相对 → 绝对）
 */
function resolveUrl(uri, baseUrl) {
  if (!uri) return '';
  if (/^https?:\/\//i.test(uri)) return uri;
  try {
    return new URL(uri, baseUrl).href;
  } catch {
    return baseUrl.replace(/\/[^/]*$/, '/') + uri;
  }
}
