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

  /**
   * 已见过但还不知道用户会不会点开的作品：aweme_id → detail。
   *
   * 真机实测（2026-08-04，登录态）测得的关键时序：`module/feed` 在页面初始加载时
   * 就一次性把整屏信息流（约 10 条，含各自完整的播放地址）取回来了，响应到达时
   * URL 上还没有 `modal_id`；用户过了几十秒才点开其中一条，此时页面只是
   * `history.replaceState` 补上 `modal_id`，**不会再发任何请求**。
   *
   * 所以不能在响应到达那一刻"要么匹配要么丢弃"——那时根本还不知道用户要看哪条。
   * 正确做法是先缓存，等 `modal_id` 指向其中某条时再发布那一条。
   */
  const MAX_CACHED_DETAILS = 200;
  const cachedDetails = new Map();

  function cacheDetail(detail) {
    const id = String(detail?.aweme_id || detail?.awemeId || '');
    if (!id || !detail?.video || cachedDetails.has(id)) return;
    cachedDetails.set(id, detail);
    // 无限滚动会不断追加，按插入序丢最早的，避免长时间停留把内存撑大。
    while (cachedDetails.size > MAX_CACHED_DETAILS) {
      cachedDetails.delete(cachedDetails.keys().next().value);
    }
  }

  /** URL 上的 modal_id 指向哪条，就发布哪条；没有指向或没缓存到就什么都不做。 */
  function publishCurrentModal() {
    const modalId = currentModalAwemeId();
    if (!modalId || parsedMediaIds.has(modalId)) return;
    const detail = cachedDetails.get(modalId);
    if (detail) publishDetail(detail);
  }

  function publishDetail(detail) {
    try {
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

  function reportPayload(payload) {
    try {
      // aweme/detail 这类单条接口是明确的"就是这一条"（分享链接、作品页等入口），
      // 不依赖 modal_id，直接发布。
      const direct = payload?.aweme_detail
        || payload?.aweme_details?.[0]
        || payload?.data?.aweme_detail;
      if (direct) {
        publishDetail(direct);
        return;
      }

      if (Array.isArray(payload?.aweme_list) && payload.aweme_list.length > 0) {
        for (const item of payload.aweme_list) cacheDetail(item);
        // modal_id 可能已经在 URL 上（例如直接带 modal_id 打开页面），先试一次。
        publishCurrentModal();
      }
    } catch {
      // 页面数据变化不能影响站点自身执行。
    }
  }

  /**
   * 监听 URL 变化，好在用户点开某条时把缓存里对应的那条发布出去。
   * 抖音是用 history.replaceState 补 modal_id 的（实测），因此必须包装
   * pushState/replaceState —— 只听 popstate 收不到这类程序化跳转。
   * 这里是链式包装（先调原函数再做自己的事），不改变站点自身行为。
   */
  function watchLocationChanges() {
    const fire = () => {
      try { publishCurrentModal(); } catch { /* 不能影响站点导航 */ }
    };
    try {
      window.addEventListener?.('popstate', fire);
      window.addEventListener?.('hashchange', fire);
    } catch { /* 环境不支持则跳过 */ }
    try {
      const history = window.history;
      for (const name of ['pushState', 'replaceState']) {
        const original = history?.[name];
        if (typeof original !== 'function') continue;
        history[name] = function () {
          const result = original.apply(this, arguments);
          fire();
          return result;
        };
      }
    } catch { /* history 不可写则跳过 */ }
  }
  watchLocationChanges();

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
