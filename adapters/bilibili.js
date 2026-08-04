/**
 * B 站适配器 —— adapters/bilibili.js
 *
 * 职责：
 *   - match(): 识别 B 站视频/番剧/直播页
 *   - extract(): 通过 chrome.tabs.sendMessage 向 bilibili-probe.js 取数据，转成 ExtractResult
 *   - requiredHeaders(): 返回 Referer/Origin（用于 DNR 注入，绕过 CDN 防盗链）
 *   - buildFileName(): 模板格式化
 *
 * 合规底线：
 *   - 不发任何页面没发过的接口请求
 *   - 只消费 probe 从 window.__playinfo__ / __INITIAL_STATE__ 读到的数据
 */

import { SiteAdapter, sanitizeFileName } from './base.js';
import { formatTemplate } from '../lib/filename.js';

/** B 站 CDN 域名模式（用于 DNR 规则作用域） */
const BILI_CDN_PATTERNS = [
  'bilivideo.com',
  'bilivideo.cn',
  'akamaized.net',
  'bilivideo.cc',
];

export class BilibiliAdapter extends SiteAdapter {
  /**
   * 识别 B 站页面
   * @param {string} url
   * @returns {boolean}
   */
  static match(url) {
    return (
      /bilibili\.com\/(video\/BV|bangumi\/play)/.test(url) ||
      /live\.bilibili\.com/.test(url)
    );
  }

  /**
   * 从页面提取媒体信息
   * @param {number} tabId
   * @param {string} pageUrl
   * @returns {Promise<ExtractResult>}
   */
  async extract(tabId, pageUrl) {
    // 通过 chrome.tabs.sendMessage 向 bridge.js (ISOLATED world) 取数据
    // bridge 再通过 window.postMessage 转发给 bilibili-probe.js (MAIN world)
    // MAIN world 无法访问 chrome.runtime，必须经 bridge 中转
    // 指定 frameId: 0 只发给主 frame（probe 只在主 frame 运行）
    let data;
    try {
      data = await chrome.tabs.sendMessage(
        tabId,
        { type: 'PROBE_GET_DATA' },
        { frameId: 0 }
      );
    } catch (err) {
      // probe 可能未注入（页面刚加载、非 B 站页面等）
      return {
        title: '',
        parts: [],
        unsupportedReason: '探针未就绪，请刷新页面后重试',
      };
    }

    if (!data || data.error) {
      return {
        title: data?.title || '',
        parts: [],
        unsupportedReason: data?.error || '探针数据获取失败',
      };
    }

    // 不支持的页面类型
    if (data.unsupportedReason) {
      return {
        title: data.title || '',
        parts: [],
        unsupportedReason: data.unsupportedReason,
      };
    }

    // 没有播放清单数据
    if (!data.playinfo || data.playinfo.video.length === 0) {
      return {
        title: data.title || '',
        parts: [],
        unsupportedReason: '未找到可下载的视频流（可能需要登录或视频已下架）',
      };
    }

    // 按 id（质量码）分组 video 变体
    // 同一个 id 可能有多条不同 codecs（avc1 / hev1 / av01）
    const variantsByQuality = new Map();
    for (const v of data.playinfo.video) {
      if (!variantsByQuality.has(v.id)) variantsByQuality.set(v.id, []);
      variantsByQuality.get(v.id).push(v);
    }

    // 构建 parts（分 P 列表）
    // 注意：probe 返回的 playinfo 是当前 cid 的播放清单
    //       其他分 P 需要切换后 probe 重新读取
    const parts = data.parts.length > 0
      ? data.parts.map((p, index) => ({
          cid: p.cid,
          // 番剧页需要 epId 来构造切换 URL（/bangumi/play/ep<epId>）
          // 普通投稿没有 epId，保持 undefined，buildPartUrl 会走 ?p=N 分支
          epId: p.epId,
          title: p.title,
          isCurrent: p.cid === data.currentCid,
          // 只有当前 P 有播放清单数据，其他 P 需要切换后重新 extract
          variants: p.cid === data.currentCid
            ? buildVariants(variantsByQuality, data.playinfo.audio, data.playinfo)
            : [],
          needSwitch: p.cid !== data.currentCid,
        }))
      : [
          // 没有分 P 信息，单 P
          {
            cid: data.cid,
            title: data.title,
            isCurrent: true,
            variants: buildVariants(variantsByQuality, data.playinfo.audio, data.playinfo),
            needSwitch: false,
          },
        ];

    return {
      title: data.title,
      cover: data.cover,
      uploader: data.uploader,
      bvid: data.bvid,
      parts,
      acceptQuality: data.acceptQuality,
      // 提示：最高清晰度 = 当前账号能看的清晰度
      maxQualityNote: '可下载的最高清晰度等于当前登录账号本身能观看的清晰度',
      // 额外的音频选项（Dolby/FLAC）
      audioOptions: buildAudioOptions(data.playinfo),
    };
  }

  /**
   * 返回下载所需注入的请求头（供 DNR 使用）
   * B 站 CDN 校验 Referer，必须注入
   *
   * 注意：B 站适配器忽略 pageUrl 参数，始终返回 bilibili.com 的 Referer/Origin。
   * 因为 B 站 CDN 校验的是固定的 bilibili.com Referer，不是来源页 URL。
   *
   * @param {string} url
   * @param {string} [pageUrl] - B 站适配器忽略此参数
   * @returns {RequiredHeaders}
   */
  requiredHeaders(url, pageUrl) {
    return {
      Referer: 'https://www.bilibili.com/',
      Origin: 'https://www.bilibili.com',
    };
  }

  /**
   * 从 m4s URL 列表提取需要注入 DNR 的域名
   * @param {Object} variant - video 或 audio 变体
   * @returns {string[]}
   */
  extractDomains(variant) {
    const domains = new Set();
    for (const url of [variant.baseUrl, ...(variant.backupUrl || [])]) {
      try {
        const u = new URL(url);
        domains.add(u.hostname);
      } catch {
        // 忽略无效 URL
      }
    }
    return Array.from(domains);
  }

  /**
   * 构建文件名
   * @param {Object} meta - extract() 返回的元数据
   * @param {Object} variant - 选中的变体
   * @param {Object} [options]
   * @param {string} [options.template] - 文件名模板
   * @param {number} [options.partIndex] - 分 P 序号（1-based）
   * @param {string} [options.partTitle] - 分 P 标题
   * @param {string} [options.ext] - 扩展名（含点，如 ".mp4"）
   * @returns {string}
   */
  buildFileName(meta, variant, options = {}) {
    const tpl = options.template || '{title}_{quality}';
    const codecGroup = (variant.codecs || '').split('.')[0]; // avc1 / hev1 / av01

    const formatted = formatTemplate(tpl, {
      title: meta.title,
      up: meta.uploader,
      bvid: meta.bvid,
      quality: variant.qualityLabel,
      codec: codecGroup,
      date: new Date().toISOString().slice(0, 10),
      p: options.partIndex != null ? String(options.partIndex) : '',
      partTitle: options.partTitle,
    });

    return sanitizeFileName(formatted) + (options.ext || '.mp4');
  }
}

/**
 * 构建 video 变体列表（展开 codecs 分组）
 * @param {Map<number, Array>} variantsByQuality - 按质量码分组的 video 变体
 * @param {Array} audioVariants - audio 变体列表
 * @param {Object} playinfo - 完整播放清单
 * @returns {Array} 展开后的变体列表
 */
function buildVariants(variantsByQuality, audioVariants, playinfo) {
  const result = [];

  for (const [qualityId, codecVariants] of variantsByQuality) {
    for (const v of codecVariants) {
      // 每个 video 变体配一个默认 audio（最高码率）
      const defaultAudio = audioVariants.length > 0
        ? [...audioVariants].sort((a, b) => b.bandwidth - a.bandwidth)[0]
        : null;

      const codecGroup = (v.codecs || '').split('.')[0]; // avc1 / hev1 / av01

      result.push({
        id: `${v.id}_${codecGroup}`,              // 变体 ID
        kind: 'video',
        urls: [v.baseUrl, ...(v.backupUrl || [])], // 主 + 备 URL
        codecs: v.codecs,
        codecGroup,
        width: v.width,
        height: v.height,
        bandwidth: v.bandwidth,
        qualityLabel: v.qualityLabel,
        qualityId: qualityId,
        // 关联的 audio 变体（下载时需要同时下 video+audio）
        audioVariant: defaultAudio
          ? {
              urls: [defaultAudio.baseUrl, ...(defaultAudio.backupUrl || [])],
              codecs: defaultAudio.codecs,
              bandwidth: defaultAudio.bandwidth,
              segmentBase: defaultAudio.segmentBase,
            }
          : null,
        // video 的 SegmentBase（init segment 字节范围）
        segmentBase: v.segmentBase,
      });
    }
  }

  return result;
}

/**
 * 构建音频选项列表（标准 + Dolby + FLAC）
 * @param {Object} playinfo
 * @returns {Array}
 */
function buildAudioOptions(playinfo) {
  const options = [];

  // 标准音频
  if (playinfo.audio && playinfo.audio.length > 0) {
    const best = [...playinfo.audio].sort((a, b) => b.bandwidth - a.bandwidth)[0];
    options.push({
      id: 'standard',
      label: '标准',
      urls: [best.baseUrl, ...(best.backupUrl || [])],
      codecs: best.codecs,
      bandwidth: best.bandwidth,
      segmentBase: best.segmentBase,
    });
  }

  // Dolby Atmos
  if (playinfo.dolby && playinfo.dolby.length > 0) {
    const dolby = playinfo.dolby[0];
    options.push({
      id: 'dolby',
      label: '杜比全景声',
      urls: [dolby.baseUrl, ...(dolby.backupUrl || [])],
      codecs: dolby.codecs,
      bandwidth: dolby.bandwidth,
      segmentBase: dolby.segmentBase,
    });
  }

  // Hi-Res FLAC
  if (playinfo.flac) {
    options.push({
      id: 'flac',
      label: 'Hi-Res 无损',
      urls: [playinfo.flac.baseUrl, ...(playinfo.flac.backupUrl || [])],
      codecs: playinfo.flac.codecs,
      bandwidth: playinfo.flac.bandwidth,
      segmentBase: playinfo.flac.segmentBase,
    });
  }

  return options;
}

export { BILI_CDN_PATTERNS };
