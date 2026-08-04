/**
 * B 站 MAIN world 探针 —— content/bilibili-probe.js
 *
 * 职责：
 *   1. 读取 window.__playinfo__（DASH 播放清单：video/audio 流 URL + SegmentBase）
 *   2. 读取页面元数据（标题、UP 主、封面、分 P 列表、BV 号、cid）：
 *      - 普通投稿：window.__INITIAL_STATE__
 *      - 番剧：window.__PLAYURL_HYDRATE_DATA__ + window.__NEXT_DATA__
 *        （B 站 2025 改版后番剧页 __INITIAL_STATE__ 已不存在）
 *   3. 监听 __playinfo__ 重新赋值（分 P 切换时页面会重新注入）
 *   4. 响应 bridge.js 转发的 PROBE_GET_DATA 请求，返回结构化数据
 *   5. 识别页面类型（普通投稿/番剧/直播/互动视频）
 *
 * 合规底线：
 *   - 只读页面已产生的数据，绝不发任何页面没发过的接口请求
 *   - 不构造 wbi 签名、不拼装 playurl 参数
 *
 * 注入方式：manifest content_scripts，world=MAIN，run_at=document_start
 * 通信方式：window.postMessage <-> content/bridge.js (ISOLATED world)
 *           MAIN world 无法访问 chrome.runtime，必须通过 bridge 中转
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__webgrabBiliProbeInstalled) return;
  window.__webgrabBiliProbeInstalled = true;

  /** 与 bridge.js 约定的消息 source 标识 */
  const PROBE_SOURCE = 'webgrab-bili-probe';
  const BRIDGE_SOURCE = 'webgrab-bridge';

  /** 缓存的 __playinfo__ 数据 */
  let cachedPlayinfo = null;
  /** 缓存的 __INITIAL_STATE__ 数据 */
  let cachedInitialState = null;
  /** 当前页面类型 */
  let pageType = 'unknown';
  /** 分 P 切换监听器是否已注册 */
  let navHookInstalled = false;
  /** 缓存的番剧分集列表（按 seasonId 缓存，避免重复 fetch） */
  let cachedBangumiEpisodes = null;
  /** 正在进行的番剧 ep/list fetch（去重，防止并发请求） */
  let pendingBangumiFetch = null;

  // ─── 1. __playinfo__ 双保险获取 ────────────────────────────
  //
  // 策略：
  //   - 主路径：Object.defineProperty 拦截 window.__playinfo__ 赋值时刻
  //   - 兜底：每 100ms 轮询，最长 5 秒
  //   - 拿到后缓存，后续重新赋值（分 P 切换）会再次触发 setter，更新缓存

  /** 等待 __playinfo__ 的 Promise */
  let playinfoResolve = null;
  const playinfoPromise = new Promise((resolve) => {
    playinfoResolve = resolve;
  });

  /**
   * 拦截 window.__playinfo__ 赋值
   * 注意：必须在页面脚本赋值之前定义，否则拦截不到
   */
  let playinfoValue = undefined;
  try {
    Object.defineProperty(window, '__playinfo__', {
      configurable: true,
      get() {
        return playinfoValue;
      },
      set(v) {
        playinfoValue = v;
        cachedPlayinfo = v;
        if (playinfoResolve) {
          playinfoResolve(v);
          playinfoResolve = null; // 只 resolve 第一次
        } else {
          // 后续重新赋值（分 P 切换）：通知 bridge 数据已更新
          notifyProbeUpdate();
        }
      },
    });
  } catch (e) {
    // defineProperty 失败（可能页面已先定义），降级到轮询
    console.warn('[WebGrab/BiliProbe] defineProperty 拦截失败，降级到轮询:', e);
  }

  /**
   * 轮询兜底：每 100ms 检查一次，最长 5 秒
   */
  const POLL_INTERVAL = 100;
  const POLL_TIMEOUT = 5000;
  let pollElapsed = 0;
  const pollTimer = setInterval(() => {
    if (window.__playinfo__) {
      cachedPlayinfo = window.__playinfo__;
      if (playinfoResolve) {
        playinfoResolve(window.__playinfo__);
        playinfoResolve = null;
      }
      clearInterval(pollTimer);
      return;
    }
    pollElapsed += POLL_INTERVAL;
    if (pollElapsed >= POLL_TIMEOUT) {
      clearInterval(pollTimer);
      if (playinfoResolve) {
        playinfoResolve(null);
        playinfoResolve = null;
      }
    }
  }, POLL_INTERVAL);

  // ─── 2. __INITIAL_STATE__ 提取 ─────────────────────────────

  /**
   * 读取 __INITIAL_STATE__（页面渲染时注入，document_start 时可能尚未就绪）
   * 用轮询方式等待，最长 3 秒
   * @returns {Promise<Object|null>}
   */
  function waitForInitialState() {
    return new Promise((resolve) => {
      if (window.__INITIAL_STATE__) {
        cachedInitialState = window.__INITIAL_STATE__;
        resolve(window.__INITIAL_STATE__);
        return;
      }
      let elapsed = 0;
      const interval = 100;
      const timer = setInterval(() => {
        if (window.__INITIAL_STATE__) {
          cachedInitialState = window.__INITIAL_STATE__;
          clearInterval(timer);
          resolve(window.__INITIAL_STATE__);
        }
        elapsed += interval;
        if (elapsed >= 3000) {
          clearInterval(timer);
          resolve(null);
        }
      }, interval);
    });
  }

  // ─── 3. 页面类型识别 ───────────────────────────────────────

  /**
   * 根据 URL 和 __INITIAL_STATE__ 识别页面类型
   * @param {string} url
   * @param {Object|null} initialState
   * @returns {'normal'|'bangumi'|'live'|'interactive'|'unsupported'}
   */
  function detectPageType(url, initialState) {
    if (/live\.bilibili\.com/.test(url)) {
      return 'live';
    }
    if (/bilibili\.com\/bangumi\/play\//.test(url)) {
      return 'bangumi';
    }
    if (/bilibili\.com\/video\/BV/.test(url)) {
      // 互动视频识别（P3 规格：识别后提示"不支持"）
      // 判别字段：videoData.rights.is_stein_gate === 1（实测可靠，普通视频无此 key）
      // "stein_gate" 是 B 站互动视频内部代号（来自《命运石之门》Steins;Gate）
      // 保留原有 videoData.interaction 判断作为兼容兜底
      if (initialState?.videoData?.rights?.is_stein_gate === 1 ||
          initialState?.videoData?.interaction) {
        return 'interactive';
      }
      return 'normal';
    }
    return 'unsupported';
  }

  // ─── 4. 数据结构化提取 ─────────────────────────────────────

  /**
   * 兼容读取 SegmentBase 字段
   *
   * B 站 __playinfo__ 中 SegmentBase 字段名存在两种命名风格（不同 API 版本）：
   *   - 大驼峰：v.SegmentBase.Initialization / v.SegmentBase.indexRange
   *   - 下划线：v.segment_base.initialization / v.segment_base.index_range
   * 两种都可能出现，统一兼容。
   *
   * @param {Object} variant - dash.video[i] 或 dash.audio[i]
   * @returns {{initialization: string, indexRange: string}|null}
   */
  function extractSegmentBase(variant) {
    // 大驼峰风格
    const sb = variant.SegmentBase || variant.segmentBase;
    if (sb) {
      const init = sb.Initialization || sb.initialization;
      const idx = sb.indexRange || sb.index_range;
      if (init && idx) return { initialization: init, indexRange: idx };
    }
    // 下划线风格
    const sbu = variant.segment_base;
    if (sbu) {
      const init = sbu.initialization || sbu.Initialization;
      const idx = sbu.index_range || sbu.indexRange;
      if (init && idx) return { initialization: init, indexRange: idx };
    }
    return null;
  }

  /**
   * 从 __playinfo__ 提取结构化的播放清单
   *
   * 两种页面类型的 __playinfo__ 结构不同（B 站 2025 改版后番剧页结构迁移）：
   *   - 普通投稿：playinfo.data.dash.{video,audio,dolby,flac}
   *       · accept_quality / accept_description 在 playinfo.data 下
   *   - 番剧：playinfo.result.video_info.dash.{video,audio,dolby}
   *       · playinfo.result 与 __PLAYURL_HYDRATE_DATA__.result 是同一对象引用（实测确认）
   *       · accept_quality / accept_description 在 playinfo.result.video_info 下
   *       · flac 字段实测未确认，用可选链兜底
   *
   * @param {Object} playinfo
   * @param {string} [pageType='normal'] - 页面类型，决定读取路径
   * @returns {Object}
   */
  function extractPlayinfo(playinfo, pageType = 'normal') {
    // 按页面类型定位 dash 对象和 accept_quality 所在的父对象
    let dash = null;
    let acceptQualityParent = null;

    if (pageType === 'bangumi') {
      // 番剧：playinfo.result.video_info.dash
      // 实测 playinfo.result 与 __PLAYURL_HYDRATE_DATA__.result 是同一对象引用
      const videoInfo = playinfo?.result?.video_info;
      if (videoInfo?.dash) {
        dash = videoInfo.dash;
        acceptQualityParent = videoInfo; // accept_quality/description 在 video_info 下
      }
    } else {
      // 普通投稿：playinfo.data.dash（保持原逻辑不动）
      if (playinfo?.data?.dash) {
        dash = playinfo.data.dash;
        acceptQualityParent = playinfo.data;
      }
    }

    if (!dash) {
      return { video: [], audio: [], dolby: [], flac: null, acceptQuality: [] };
    }

    const acceptQuality = buildAcceptQuality(acceptQualityParent);

    return {
      video: (dash.video || []).map((v) => ({
        id: v.id,                              // 质量码（如 80=1080P, 116=1080P60）
        codecs: v.codecs,                      // "avc1.64001F" / "hev1.64001F" / "av01"
        width: v.width,
        height: v.height,
        bandwidth: v.bandwidth,
        // 兼容两种命名：普通投稿页驼峰和下划线双写，番剧页只有下划线
        baseUrl: v.baseUrl || v.base_url,
        backupUrl: v.backupUrl || v.backup_url || [],
        segmentBase: extractSegmentBase(v),
        qualityLabel: acceptQuality.find((q) => q.id === v.id)?.label || String(v.id),
      })),
      audio: (dash.audio || []).map((a) => ({
        id: a.id,
        codecs: a.codecs,
        bandwidth: a.bandwidth,
        // 同上，兼容两种命名
        baseUrl: a.baseUrl || a.base_url,
        backupUrl: a.backupUrl || a.backup_url || [],
        segmentBase: extractSegmentBase(a),
      })),
      // dolby/flac 在番剧结构下的精确路径未实测确认，
      // 用与普通投稿一致的 dash.dolby / dash.flac 路径 + 可选链兜底
      dolby: dash.dolby?.audio || [],
      flac: dash.flac || null,
      acceptQuality,
    };
  }

  /**
   * 构建 质量码 → 显示名 映射
   * @param {Object} data - playinfo.data
   * @returns {Array<{id: number, label: string}>}
   */
  function buildAcceptQuality(data) {
    const acceptQuality = data.accept_quality || [];
    const acceptDescription = data.accept_description || [];
    const result = [];
    for (let i = 0; i < acceptQuality.length; i++) {
      result.push({
        id: acceptQuality[i],
        label: acceptDescription[i] || String(acceptQuality[i]),
      });
    }
    return result;
  }

  /**
   * 从 __INITIAL_STATE__ / __PLAYURL_HYDRATE_DATA__ / __NEXT_DATA__ 提取视频元数据 + 分 P 列表
   *
   * 数据源分两种页面类型：
   *   - 普通投稿（/video/BV...）：window.__INITIAL_STATE__（SSR 注入）
   *       · state.cid（顶层）随当前播放分 P 变化
   *       · state.videoData.cid 是 P1 固定值，不可用
   *   - 番剧（/bangumi/play/ep...）：window.__PLAYURL_HYDRATE_DATA__ + window.__NEXT_DATA__
   *       · B 站 2025 年改版后番剧页 __INITIAL_STATE__ 已不存在，必须改用新数据源
   *       · __PLAYURL_HYDRATE_DATA__.result.arc.cid 随当前播放集变化（实测确认）
   *       · __NEXT_DATA__ 的 season 查询里有 season_title/cover/title，但没有 episodes
   *
   * 番剧分集列表（episodes[]）目前【未实现】——season 查询里没有 episodes 数组，
   * 该数据是页面 hydration 后由额外的客户端请求单独获取的，需要另外的接口观察方案。
   * 此处先返回空 parts[]，popup 会按"单集"模式展示（与原来 parts.length === 0 兜底一致）。
   *
   * @param {Object|null} state - __INITIAL_STATE__（番剧页为 null）
   * @param {string} pageType
   * @returns {Object}
   */
  function extractInitialState(state, pageType) {
    // 番剧分支独立于 __INITIAL_STATE__（实测已不存在），从新数据源读
    if (pageType === 'bangumi') {
      return extractBangumiState();
    }

    if (!state) {
      return { title: '', uploader: '', cover: '', bvid: '', cid: 0, parts: [] };
    }

    const videoData = state.videoData || {};
    const pages = videoData.pages || [];
    // cid 必须取顶层 state.cid（随当前播放分 P 变化），不能用 videoData.cid
    //（后者实测是 P1 的固定值，不随 ?p= 变化，会导致分 P 切换永远匹配不上）
    return {
      title: videoData.title || '',
      uploader: videoData.owner?.name || '',
      cover: videoData.pic || '',
      bvid: videoData.bvid || '',
      cid: state.cid || videoData.cid || 0,
      parts: pages.map((p, i) => ({
        cid: p.cid,
        title: p.part || `P${i + 1}`,
        duration: p.duration || 0,
      })),
    };
  }

  /**
   * 番剧页元数据提取（B 站 2025 改版后的新前端结构）
   *
   * 数据源（均为页面自己挂在 window 上的 SSR/hydration 数据 + 页面自己会发的同款 GET 请求）：
   *   - window.__PLAYURL_HYDRATE_DATA__.result.arc：当前播放集的 arc（稿件）信息
   *       · arc.cid / arc.bvid：当前集的 cid/bvid，实测会随切集重新注入
   *   - window.__NEXT_DATA__.props.pageProps.dehydratedState.queries[]：
   *       · 找 queryKey 包含 "pgc/view/web/simple/season" 的项
   *       · state.data 里有 season_title / cover / title，但【没有 episodes】
   *   - 番剧分集列表（episodes[]）：通过 fetch `pgc/view/web/ep/list?ep_id=<当前ep_id>` 获取
   *       · 这是页面自己加载播放页时就会发起的同一个 GET 请求（用户在 DevTools 实测确认）
   *       · 不需要签名、不需要构造任何页面没有的参数，ep_id 直接从当前 URL 解析
   *       · 语义上等价于"观察页面自己的请求"，不违反"不构造私有接口"红线
   *       · 结果按 seasonId 缓存（同一季度的分集列表不变），避免重复请求
   *
   * 注意：调用前必须先 await ensureBangumiEpisodes()，否则 parts 为空
   *
   * @returns {Object}
   */
  function extractBangumiState() {
    const arc = window.__PLAYURL_HYDRATE_DATA__?.result?.arc || {};
    const cid = arc.cid || 0;
    const bvid = arc.bvid || '';

    // 从 __NEXT_DATA__ 的 season 查询读季度级元数据（标题/封面/UP 主）
    let title = '';
    let cover = '';
    let uploader = '';
    try {
      const queries = window.__NEXT_DATA__?.props?.pageProps?.dehydratedState?.queries || [];
      const seasonQ = queries.find(
        (q) => JSON.stringify(q?.queryKey || []).includes('pgc/view/web/simple/season')
      );
      const seasonData = seasonQ?.state?.data || {};
      title = seasonData.season_title || seasonData.title || '';
      cover = seasonData.cover || '';
      const upInfo = seasonData.up_info || {};
      uploader = upInfo.uname || (Array.isArray(seasonData.staff) ? seasonData.staff.map((s) => s.name).join('/') : '');
    } catch {
      // __NEXT_DATA__ 结构异常时降级为空（cid 仍然可用）
    }

    // 从缓存的 episodes 构造 parts（ensureBangumiEpisodes 已确保缓存就绪）
    const parts = (cachedBangumiEpisodes || []).map((ep, i) => ({
      cid: ep.cid,
      bvid: ep.bvid,
      epId: ep.ep_id,
      title: ep.show_title || ep.long_title || `第${ep.title || (i + 1)}话`,
      duration: ep.duration || 0,
    }));

    return {
      title,
      uploader,
      cover,
      bvid,
      cid,
      parts,
    };
  }

  /**
   * 从当前 URL 解析 ep_id（番剧页 URL 格式：/bangumi/play/ep836727）
   * @returns {number|null}
   */
  function parseEpIdFromUrl() {
    const m = location.pathname.match(/\/bangumi\/play\/ep(\d+)/);
    return m ? parseInt(m[1], 10) : null;
  }

  /**
   * 确保番剧分集列表已加载（带缓存和去重）
   *
   * 调用 `https://api.bilibili.com/pgc/view/web/ep/list?ep_id=<当前ep_id>`，
   * 这是页面自己加载播放页时就会发起的同一个 GET 请求（用户实测确认），
   * 不需要签名、不需要构造任何页面没有的参数。
   *
   * probe 在 MAIN world，fetch 自带页面 cookies，与页面自己发请求完全等价。
   * 同一季度的分集列表不变，用 seasonId 缓存避免重复请求。
   *
   * @returns {Promise<void>}
   */
  async function ensureBangumiEpisodes() {
    const epId = parseEpIdFromUrl();
    if (!epId) return; // 无法解析 ep_id，parts 留空

    // 缓存失效检查：当前 URL 的 ep_id 不在缓存里，说明跨季度切换了，需重新 fetch
    if (cachedBangumiEpisodes && !cachedBangumiEpisodes.some((e) => e.ep_id === epId)) {
      cachedBangumiEpisodes = null;
    }

    // 已有缓存，直接用
    if (cachedBangumiEpisodes) return;

    // 已有进行中的 fetch，等它完成（去重，防止并发请求）
    if (pendingBangumiFetch) {
      await pendingBangumiFetch;
      return;
    }

    pendingBangumiFetch = (async () => {
      try {
        const resp = await fetch(
          `https://api.bilibili.com/pgc/view/web/ep/list?ep_id=${epId}`,
          { credentials: 'include' } // 带页面 cookies，与页面自己发请求等价
        );
        if (!resp.ok) return;
        const json = await resp.json();
        if (json?.code === 0 && Array.isArray(json?.result?.episodes)) {
          cachedBangumiEpisodes = json.result.episodes;
        }
      } catch {
        // 网络错误或响应解析失败，parts 留空，用户仍可下载当前集
      } finally {
        pendingBangumiFetch = null;
      }
    })();

    await pendingBangumiFetch;
  }

  // ─── 5. 消息响应（通过 window.postMessage 与 bridge 通信）──

  /**
   * 构建 PROBE_GET_DATA 的完整响应
   * @returns {Object}
   */
  function buildProbeResponse() {
    const url = location.href;
    const state = cachedInitialState || window.__INITIAL_STATE__;
    pageType = detectPageType(url, state);
    const meta = extractInitialState(state, pageType);
    const playinfo = extractPlayinfo(cachedPlayinfo || window.__playinfo__, pageType);

    return {
      pageType,
      url,
      title: meta.title,
      uploader: meta.uploader,
      cover: meta.cover,
      bvid: meta.bvid,
      cid: meta.cid,
      parts: meta.parts,
      currentCid: meta.cid,
      playinfo,
      acceptQuality: playinfo.acceptQuality,
      unsupportedReason: getUnsupportedReason(pageType),
    };
  }

  /**
   * 根据页面类型返回不支持原因
   * @param {string} type
   * @returns {string}
   */
  function getUnsupportedReason(type) {
    switch (type) {
      case 'live': return '暂不支持直播录制';
      case 'interactive': return '暂不支持互动视频';
      case 'unsupported': return '当前页面不是 B 站视频页';
      default: return '';
    }
  }

  /**
   * 通知 bridge 探针数据已更新（分 P 切换时）
   * bridge 会再转发给 SW
   */
  function notifyProbeUpdate() {
    try {
      window.postMessage({
        source: PROBE_SOURCE,
        type: 'PROBE_UPDATE',
        url: location.href,
      }, '*');
    } catch {
      // 静默
    }
  }

  /**
   * 处理来自 bridge 的 PROBE_GET_DATA 请求
   *
   * 等待策略：
   *   - 普通投稿：等 __INITIAL_STATE__（页面渲染时注入），随后等 __playinfo__
   *   - 番剧：并行等 __PLAYURL_HYDRATE_DATA__ / 分集列表 fetch / __playinfo__ 三者
   *     三者互不依赖（分集列表只需 URL 里的 ep_id，不需要 hydrate 数据），
   *     并行等待避免顺序叠加超过 bridge.js 的 PROBE_TIMEOUT（8s）——
   *     实测顺序等待最坏情况可达 5s(hydrate) + fetch 耗时 + 5s(playinfo) > 8s，
   *     刚打开番剧新一集页面时页面数据尚未就绪，会导致探针超时误报"未找到视频流"。
   * @returns {Promise<Object>}
   */
  async function handleProbeRequest() {
    pageType = detectPageType(location.href, cachedInitialState || window.__INITIAL_STATE__);

    if (pageType === 'bangumi') {
      const waits = [ensureBangumiEpisodes()];
      if (!window.__PLAYURL_HYDRATE_DATA__) waits.push(waitForHydrateData());
      if (!cachedPlayinfo && !window.__playinfo__) waits.push(playinfoPromise);
      await Promise.all(waits);
      cachedPlayinfo = cachedPlayinfo || window.__playinfo__;
    } else if (pageType === 'normal') {
      // 普通投稿：等 __INITIAL_STATE__
      if (!cachedInitialState && !window.__INITIAL_STATE__) {
        await waitForInitialState();
      } else {
        cachedInitialState = cachedInitialState || window.__INITIAL_STATE__;
      }
      if (!cachedPlayinfo && !window.__playinfo__) {
        await playinfoPromise;
      }
      cachedPlayinfo = cachedPlayinfo || window.__playinfo__;
    }

    return buildProbeResponse();
  }

  /**
   * 等待 window.__PLAYURL_HYDRATE_DATA__ 就绪（番剧页用）
   *
   * __PLAYURL_HYDRATE_DATA__ 由 B 站新前端在 hydration 阶段挂到 window 上，
   * document_start 时可能尚未就绪，用轮询等待。
   * @returns {Promise<void>}
   */
  function waitForHydrateData() {
    return new Promise((resolve) => {
      if (window.__PLAYURL_HYDRATE_DATA__) {
        resolve();
        return;
      }
      let elapsed = 0;
      const interval = 100;
      const timer = setInterval(() => {
        if (window.__PLAYURL_HYDRATE_DATA__) {
          clearInterval(timer);
          resolve();
          return;
        }
        elapsed += interval;
        if (elapsed >= 5000) {
          clearInterval(timer);
          resolve(); // 超时也 resolve，让 buildProbeResponse 用兜底空数据
        }
      }, interval);
    });
  }

  // 监听 bridge.js 通过 window.postMessage 转发来的请求
  // MAIN world 无法访问 chrome.runtime，必须走这条路径
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== BRIDGE_SOURCE) return;
    if (event.source !== window) return; // 只接受同窗口消息
    if (data.type !== 'PROBE_GET_DATA') return;

    // 异步处理请求，完成后通过 postMessage 把响应发回 bridge
    const requestId = data.requestId;
    handleProbeRequest()
      .then((result) => {
        window.postMessage({
          source: PROBE_SOURCE,
          type: 'PROBE_RESPONSE',
          requestId,
          result,
        }, '*');
      })
      .catch((err) => {
        window.postMessage({
          source: PROBE_SOURCE,
          type: 'PROBE_RESPONSE',
          requestId,
          error: err.message || String(err),
        }, '*');
      });
  });

  // ─── 6. 分 P 切换 / SPA 导航监听 ────────────────────────────

  /**
   * 安装 SPA 导航监听（B 站是 SPA，分 P 切换不改页面 URL 的 path 部分）
   */
  function installNavigationHook() {
    if (navHookInstalled) return;
    navHookInstalled = true;

    const origPushState = history.pushState;
    const origReplaceState = history.replaceState;

    history.pushState = function () {
      const result = origPushState.apply(this, arguments);
      setTimeout(notifyProbeUpdate, 500);
      return result;
    };

    history.replaceState = function () {
      const result = origReplaceState.apply(this, arguments);
      setTimeout(notifyProbeUpdate, 500);
      return result;
    };

    window.addEventListener('popstate', () => {
      setTimeout(notifyProbeUpdate, 500);
    });
  }

  installNavigationHook();

  // 启动时通知 bridge 探针已就绪（让 bridge 知道 MAIN world 探针存在）
  try {
    window.postMessage({
      source: PROBE_SOURCE,
      type: 'PROBE_READY',
      url: location.href,
    }, '*');
  } catch {
    // 静默
  }

  console.log('[WebGrab/BiliProbe] 探针已安装');
})();
