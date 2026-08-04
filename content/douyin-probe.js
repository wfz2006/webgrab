/**
 * 抖音 MAIN world 探针。
 *
 * 抖音播放器使用 MediaSource/blob，并会同时请求页面动效与许多 Range 片段；
 * 这些网络请求都不是可直接观看的作品成品。作品的完整可重放地址只存在于
 * aweme/detail JSON 中，因此在页面消费响应的同时 clone 一份做结构化提取。
 *
 * 真机实测（2026-08-04，登录态）发现：从首页信息流点开一条视频时，PC 网页版
 * 实际走的是 `POST /aweme/v2/web/module/feed/`（返回 `aweme_list` 数组，同时
 * 带回当前视频 + 若干条预加载的相关推荐），从未请求过 `aweme/detail`。两条
 * 路径应并存——`aweme/detail` 对应分享链接等其它入口，抓包时也曾真实命中过。
 */
(function () {
  'use strict';

  if (window.__webgrabDouyinProbeInstalled) return;
  window.__webgrabDouyinProbeInstalled = true;

  const MESSAGE_SOURCE = 'webgrab-hook';
  const DETAIL_PATH = '/aweme/v1/web/aweme/detail/';
  const MULTI_DETAIL_PATH = '/aweme/v2/web/module/feed/';
  const parsedMediaIds = new Set();

  function isDetailRequest(value) {
    try {
      const raw = typeof value === 'string' ? value : value?.url;
      if (!raw) return false;
      const pathname = new URL(raw, location.href).pathname;
      return pathname.includes(DETAIL_PATH) || pathname.includes(MULTI_DETAIL_PATH);
    } catch {
      return false;
    }
  }

  // module/feed 是抖音网页版通用的信息流接口，无限滚动加载新推荐时也会调用它，
  // 每次返回的 aweme_list 里除了用户正在看的这条，通常还带着若干条预加载的相关
  // 推荐。只有 URL 上明确带着 modal_id（用户点开视频弹层时页面会同步跳到这个
  // query）时，才认为“当前正在看的就是这一条”，避免把用户根本没点开的预加载
  // 推荐也当成下载目标上报。
  function currentModalAwemeId() {
    try {
      return new URL(location.href).searchParams.get('modal_id') || '';
    } catch {
      return '';
    }
  }

  function positiveNumber(value, fallback = -1) {
    const number = Number(value);
    return Number.isFinite(number) && number > 0 ? number : fallback;
  }

  function addressUrls(address) {
    const urls = Array.isArray(address?.url_list) ? address.url_list : [];
    const unique = [];
    for (const value of urls) {
      if (typeof value !== 'string' || !/^https?:\/\//i.test(value)) continue;
      if (!unique.includes(value)) unique.push(value);
    }
    return unique;
  }

  function isH264Rate(rate) {
    if (!rate || typeof rate !== 'object') return false;
    if (rate.is_h265 === true || rate.is_h265 === 1 || rate.is_bytevc1 === true || rate.is_bytevc1 === 1) {
      return false;
    }
    const codecText = `${rate.codec_type || ''} ${rate.codec || ''} ${rate.gear_name || ''}`.toLowerCase();
    return !/(h265|hevc|bytevc1|hvc1)/.test(codecText);
  }

  function bestRate(rates, predicate) {
    return (Array.isArray(rates) ? rates : [])
      .filter((rate) => predicate(rate) && addressUrls(rate?.play_addr).length > 0)
      .sort((a, b) => positiveNumber(b.bit_rate, 0) - positiveNumber(a.bit_rate, 0))[0] || null;
  }

  function choosePlayableAddress(video) {
    if (addressUrls(video?.play_addr_h264).length > 0) {
      return video.play_addr_h264;
    }

    const h264Rate = bestRate(video?.bit_rate, isH264Rate);
    if (h264Rate) return h264Rate.play_addr;

    if (addressUrls(video?.play_addr).length > 0) {
      return video.play_addr;
    }

    const anyRate = bestRate(video?.bit_rate, () => true);
    if (anyRate) return anyRate.play_addr;

    if (addressUrls(video?.download_addr).length > 0) {
      return video.download_addr;
    }
    return null;
  }

  function detailFromPayload(payload) {
    const direct = payload?.aweme_detail
      || payload?.aweme_details?.[0]
      || payload?.data?.aweme_detail;
    if (direct) return direct;

    if (Array.isArray(payload?.aweme_list) && payload.aweme_list.length > 0) {
      const modalId = currentModalAwemeId();
      if (!modalId) return null; // 没有明确的“当前视频”标识，宁可不报也不猜。
      return payload.aweme_list.find((item) => String(item?.aweme_id || '') === modalId) || null;
    }

    return null;
  }

  function reportPayload(payload) {
    try {
      const detail = detailFromPayload(payload);
      const video = detail?.video;
      if (!detail || !video) return;

      const mediaId = String(detail.aweme_id || detail.awemeId || '');
      if (mediaId && parsedMediaIds.has(mediaId)) return;

      const address = choosePlayableAddress(video);
      const urls = addressUrls(address);
      if (urls.length === 0) return;

      if (mediaId) parsedMediaIds.add(mediaId);
      const description = String(detail.desc || '').trim();
      const title = `${description || (mediaId ? `抖音视频_${mediaId}` : '抖音视频')}.mp4`;

      window.postMessage({
        source: MESSAGE_SOURCE,
        type: 'resource',
        data: {
          url: urls[0],
          backupUrls: urls.slice(1),
          kind: 'video',
          ext: 'mp4',
          mime: 'video/mp4',
          size: positiveNumber(address?.data_size, positiveNumber(video.data_size)),
          title,
          width: positiveNumber(video.width),
          height: positiveNumber(video.height),
          duration: positiveNumber(video.duration),
          isPrimaryMedia: true,
          mediaId,
        },
      }, '*');
    } catch {
      // 页面数据变化不能影响站点自身执行。
    }
  }

  function inspectFetchResponse(response) {
    try {
      response.clone().json().then(reportPayload).catch(() => {});
    } catch {
      // opaque/已消费响应等情况静默跳过。
    }
  }

  if (typeof window.fetch === 'function') {
    const originalFetch = window.fetch;
    window.fetch = function (input) {
      const result = originalFetch.apply(this, arguments);
      if (isDetailRequest(input)) {
        result.then(inspectFetchResponse).catch(() => {});
      }
      return result;
    };
  }

  if (typeof window.XMLHttpRequest === 'function') {
    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSend = XMLHttpRequest.prototype.send;
    const requestUrls = new WeakMap();

    XMLHttpRequest.prototype.open = function (method, url) {
      try { requestUrls.set(this, url); } catch {}
      return originalOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      const requestUrl = requestUrls.get(this);
      if (isDetailRequest(requestUrl)) {
        this.addEventListener('load', function () {
          try {
            if (this.responseType === 'json' && this.response) {
              reportPayload(this.response);
            } else {
              reportPayload(JSON.parse(this.responseText));
            }
          } catch {
            // 非 JSON/跨域响应静默跳过。
          }
        }, { once: true });
      }
      return originalSend.apply(this, arguments);
    };
  }
})();
