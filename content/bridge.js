/**
 * 消息桥 —— MAIN world (hook.js) <-> ISOLATED world <-> Service Worker
 *
 * 职责：
 *   1. 监听 hook.js 通过 window.postMessage 发来的事件，转发到 SW
 *   2. 监听 SW 的消息，必要时转发到 MAIN world（P0 暂不需要）
 *   3. Trusted Types 兼容：为可能的 DOM 注入创建策略
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__webgrabBridgeInstalled) return;
  window.__webgrabBridgeInstalled = true;

  const HOOK_SOURCE = 'webgrab-hook';
  const PROBE_SOURCE = 'webgrab-bili-probe';
  const BRIDGE_SOURCE = 'webgrab-bridge';

  /**
   * 扩展上下文是否已失效（扩展重载后旧 content script 会命中）
   * 一旦失效，停止所有后续转发，避免刷屏错误。
   */
  let extensionInvalidated = false;

  /**
   * 安全的 sendMessage 封装
   * 捕获 "Extension context invalidated" 错误，命中后标记失效。
   * @param {Object} message
   * @returns {Promise<any>}
   */
  function safeSendMessage(message) {
    if (extensionInvalidated) return Promise.resolve();
    try {
      return chrome.runtime.sendMessage(message).catch((err) => {
        if (err && /Extension context invalidated/i.test(err.message)) {
          extensionInvalidated = true;
          console.log('[WebGrab/Bridge] 扩展上下文已失效，停止转发');
        }
        // 其他错误静默（SW 可能休眠）
      });
    } catch (err) {
      if (err && /Extension context invalidated/i.test(err.message)) {
        extensionInvalidated = true;
        console.log('[WebGrab/Bridge] 扩展上下文已失效，停止转发');
      }
      return Promise.resolve();
    }
  }

  /**
   * 待响应的 PROBE_GET_DATA 请求映射
   * key: requestId, value: { sendResponse, timer }
   * @type {Map<string, {sendResponse: Function, timer: number}>}
   */
  const pendingProbeRequests = new Map();

  /**
   * PROBE_GET_DATA 超时时间
   * probe 内部普通投稿最长等 5s __playinfo__；番剧页并行等 hydrate/playinfo(各5s)
   * + 分集列表 fetch（无固定上限，弱网可能较慢），给足余量避免误报超时。
   */
  const PROBE_TIMEOUT = 12000;

  // ─── Trusted Types 兼容 ───────────────────────────────────
  // content script (ISOLATED) 如果需要注入 DOM，使用此策略
  let ttPolicy = null;
  try {
    if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
      ttPolicy = window.trustedTypes.createPolicy('webgrab-bridge', {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    }
  } catch {
    // 策略可能已存在
  }

  /**
   * 提取文件名：从 URL 中提取最后一个路径段
   * @param {string} url
   * @returns {string}
   */
  function extractFileName(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname;
      const slash = path.lastIndexOf('/');
      const name = slash !== -1 ? path.slice(slash + 1) : path;
      return name || 'unknown';
    } catch {
      return 'unknown';
    }
  }

  /**
   * 从 URL 提取扩展名
   * @param {string} url
   * @returns {string}
   */
  function extractExt(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname;
      const dot = path.lastIndexOf('.');
      if (dot === -1) return '';
      return path.slice(dot + 1).toLowerCase();
    } catch {
      return '';
    }
  }

  // ─── 监听 hook.js (MAIN world) 的消息 ─────────────────────
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== HOOK_SOURCE) return;
    if (event.source !== window) return; // 只接受同窗口消息

    handleHookMessage(data);
  });

  // ─── 监听 bilibili-probe.js (MAIN world) 的消息 ───────────
  // probe 通过 window.postMessage 把响应/通知发给 bridge，bridge 再转发到 SW
  window.addEventListener('message', (event) => {
    const data = event.data;
    if (!data || data.source !== PROBE_SOURCE) return;
    if (event.source !== window) return;

    handleProbeMessage(data);
  });

  /**
   * 处理来自 bilibili-probe.js 的消息
   * @param {{type: string, requestId?: string, result?: Object, error?: string, url?: string}} msg
   */
  function handleProbeMessage(msg) {
    switch (msg.type) {
      case 'PROBE_READY':
        // 探针已安装，通知 SW（可选，SW 据此知道探针存在）
        safeSendMessage({
          type: 'PROBE_READY',
          url: msg.url,
        });
        break;

      case 'PROBE_UPDATE':
        // 探针数据已更新（分 P 切换），转发到 SW
        safeSendMessage({
          type: 'PROBE_UPDATE',
          url: msg.url,
        });
        break;

      case 'PROBE_RESPONSE': {
        // 探针对 PROBE_GET_DATA 的响应，用 requestId 配对找到 sendResponse
        const pending = pendingProbeRequests.get(msg.requestId);
        if (!pending) return; // 可能已超时被清理
        clearTimeout(pending.timer);
        pendingProbeRequests.delete(msg.requestId);
        if (msg.error) {
          pending.sendResponse({ error: msg.error });
        } else {
          pending.sendResponse(msg.result);
        }
        break;
      }

      default:
        break;
    }
  }

  /**
   * 处理来自 hook.js 的消息，转发到 SW
   * @param {{type: string, data: Object}} msg
   */
  function handleHookMessage(msg) {
    const { type, data } = msg;

    try {
      switch (type) {
        case 'hookReady':
          // hook.js 安装完成，通知 SW
          safeSendMessage({ type: 'HOOK_READY', url: data.url });
          break;

        case 'sourceBuffer':
          // SourceBuffer 创建事件
          safeSendMessage({
            type: 'HOOK_SOURCE_BUFFER',
            mimeType: data.mimeType,
            url: data.url,
          });
          break;

        case 'bufferStats':
          // Buffer 累积统计
          safeSendMessage({
            type: 'HOOK_BUFFER_STATS',
            mimeType: data.mimeType,
            totalBytes: data.totalBytes,
            chunkCount: data.chunkCount,
            url: data.url,
          });
          break;

        case 'createObjectURL':
          // blob URL 创建 —— P0 阶段记录日志，P2 阶段用于关联 buffer
          if (data.isMediaSource || (data.blobType && data.blobType.startsWith('video'))) {
            // 记录 MediaSource 关联的 blob URL
            safeSendMessage({
              type: 'HOOK_RESOURCE',
              resource: {
                url: data.blobUrl,
                kind: 'stream',
                ext: '',
                mime: data.blobType || '',
                size: data.size ?? -1,
                title: '[blob] ' + extractFileName(data.blobUrl),
              },
            });
          }
          break;

        case 'fetchMedia':
        case 'xhrMedia':
          // fetch / XHR 捕获的媒体 URL
          safeSendMessage({
            type: 'HOOK_RESOURCE',
            resource: {
              url: data.url,
              kind: data.kind || 'video',
              ext: extractExt(data.url),
              mime: data.mime || '',
              size: data.size ?? -1,
              title: extractFileName(data.url),
            },
          });
          break;

        case 'videoSrc':
          // video.src 直接赋值
          safeSendMessage({
            type: 'HOOK_RESOURCE',
            resource: {
              url: data.url,
              kind: 'video',
              ext: extractExt(data.url),
              mime: '',
              size: -1,
              title: extractFileName(data.url),
            },
          });
          break;

        case 'resource':
          // 站点探针产出的结构化资源。探针负责解析站点数据，bridge 只做通用透传，
          // 避免在核心消息层出现站点判断。
          if (!data?.url) break;
          safeSendMessage({
            type: 'HOOK_RESOURCE',
            resource: {
              url: data.url,
              backupUrls: Array.isArray(data.backupUrls) ? data.backupUrls : [],
              kind: data.kind || 'video',
              ext: data.ext || extractExt(data.url),
              mime: data.mime || '',
              size: data.size ?? -1,
              title: data.title || extractFileName(data.url),
              width: data.width ?? -1,
              height: data.height ?? -1,
              duration: data.duration ?? -1,
              isPrimaryMedia: data.isPrimaryMedia === true,
              mediaId: data.mediaId || '',
            },
          });
          break;

        default:
          break;
      }
    } catch {
      // 静默失败，不影响页面
    }
  }

  // ─── 监听 SW 的消息（转发到 MAIN world） ──────────────────
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // PROBE_GET_DATA：SW → bridge → probe (MAIN world) → bridge → SW
    // 异步请求-响应模式，需要 requestId 配对
    if (message.type === 'PROBE_GET_DATA') {
      const requestId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
      pendingProbeRequests.set(requestId, {
        sendResponse,
        timer: setTimeout(() => {
          // 超时：探针未响应（可能未注入、页面非 B 站、或等待 __playinfo__ 超时）
          pendingProbeRequests.delete(requestId);
          sendResponse({
            error: '探针未响应（可能页面尚未加载完成或不是 B 站视频页）',
          });
        }, PROBE_TIMEOUT),
      });

      // 转发请求到 MAIN world 探针
      try {
        window.postMessage({
          source: BRIDGE_SOURCE,
          type: 'PROBE_GET_DATA',
          requestId,
        }, '*');
      } catch {
        // postMessage 失败，立即清理并响应
        const pending = pendingProbeRequests.get(requestId);
        if (pending) {
          clearTimeout(pending.timer);
          pendingProbeRequests.delete(requestId);
        }
        sendResponse({ error: 'bridge 转发失败' });
      }
      return true; // 异步响应
    }

    if (message.target === 'hook') {
      // 转发到 MAIN world（hook.js）
      try {
        window.postMessage({ source: BRIDGE_SOURCE, ...message }, '*');
      } catch {
        // 静默
      }
    }
    // 其他消息不返回 true，不需要异步响应
  });
})();
