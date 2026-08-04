/**
 * L3 页面上下文层 Hook —— 在 MAIN world 中劫持 MSE / fetch / XHR / createObjectURL
 *
 * 关键约束：
 *   - 必须在页面任何脚本之前执行（manifest: run_at= document_start, world= MAIN）
 *   - 劫持必须完全透明：任何异常都不能影响页面原有逻辑，所有 hook 用 try/catch 包裹
 *   - Trusted Types 兼容：创建策略后再操作 DOM（P0 阶段 hook 本身不操作 DOM，预留策略）
 *   - 通过 window.postMessage 向 ISOLATED world 的 bridge.js 发送数据
 *
 * P0 阶段：只统计 buffer 大小和 mimeType，不做实际存储。P2 阶段接入下载。
 */

(function () {
  'use strict';

  // 防止重复注入
  if (window.__webgrabHookInstalled) return;
  window.__webgrabHookInstalled = true;

  /** 消息来源标识 */
  const MSG_SOURCE = 'webgrab-hook';

  /**
   * 安全地向 bridge.js 发送消息
   * @param {string} type
   * @param {Object} data
   */
  function postToBridge(type, data) {
    try {
      window.postMessage({ source: MSG_SOURCE, type, data }, '*');
    } catch {
      // 静默失败
    }
  }

  // ─── Trusted Types 兼容 ───────────────────────────────────
  // 若页面启用了 CSP Trusted Types，创建一个策略供后续 DOM 操作使用
  let ttPolicy = null;
  try {
    if (window.trustedTypes && typeof window.trustedTypes.createPolicy === 'function') {
      ttPolicy = window.trustedTypes.createPolicy('webgrab-policy', {
        createHTML: (s) => s,
        createScript: (s) => s,
        createScriptURL: (s) => s,
      });
    }
  } catch {
    // 策略可能已存在或被禁用，忽略
  }
  // 暴露给同 world 的其他扩展代码使用
  window.__webgrabTTPolicy = ttPolicy;

  // ─── 媒体类型检测 ──────────────────────────────────────────

  /** 已知媒体扩展名集合 */
  const MEDIA_EXTS = new Set([
    'mp4', 'webm', 'm4s', 'ts', 'flv', 'mkv', 'mov', 'm3u8', 'mpd',
    'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp',
    'vtt', 'srt', 'ass',
  ]);

  /**
   * 判断 URL 是否为媒体资源
   * @param {string} url
   * @returns {boolean}
   */
  function isMediaUrl(url) {
    if (!url || typeof url !== 'string') return false;
    try {
      const u = new URL(url, location.href);
      const path = u.pathname;
      const dot = path.lastIndexOf('.');
      if (dot !== -1) {
        const ext = path.slice(dot + 1).toLowerCase();
        if (MEDIA_EXTS.has(ext)) return true;
      }
      // 检查 URL 中的媒体特征
      if (/\/(video|audio|media|stream|vod)\//i.test(u.pathname)) return true;
      if (/[?&](mime|type|format)=(video|audio)/i.test(u.search)) return true;
      return false;
    } catch {
      return false;
    }
  }

  /**
   * 判断 MIME 类型是否为媒体
   * @param {string} mime
   * @returns {boolean}
   */
  function isMediaMime(mime) {
    if (!mime) return false;
    const m = mime.toLowerCase().split(';')[0].trim();
    if (m.startsWith('video/') || m.startsWith('audio/') || m.startsWith('image/')) return true;
    if (m.includes('mpegurl') || m.includes('dash+xml')) return true;
    if (m === 'text/vtt') return true;
    if (m === 'application/octet-stream') return false; // 太宽泛，不单独靠此判断
    return false;
  }

  // ─── 1. MediaSource.prototype.addSourceBuffer 劫持 ────────

  /** @type {WeakMap<SourceBuffer, {mimeType: string, totalBytes: number, chunkCount: number, lastReport: number}>} */
  const bufferStats = new WeakMap();

  /** 上报间隔（字节数达到此值或时间达到此值时上报一次） */
  const REPORT_BYTE_INTERVAL = 5 * 1024 * 1024; // 5MB
  const REPORT_TIME_INTERVAL = 3000; // 3 秒

  if (window.MediaSource && MediaSource.prototype.addSourceBuffer) {
    const origAddSourceBuffer = MediaSource.prototype.addSourceBuffer;

    MediaSource.prototype.addSourceBuffer = function (mimeType) {
      let sb;
      try {
        sb = origAddSourceBuffer.call(this, mimeType);
        // 为此 SourceBuffer 建立统计槽
        bufferStats.set(sb, {
          mimeType: mimeType,
          totalBytes: 0,
          chunkCount: 0,
          lastReport: Date.now(),
        });

        postToBridge('sourceBuffer', {
          mimeType: mimeType,
          url: location.href,
        });
      } catch (err) {
        // 页面原始逻辑出错，原样抛出
        throw err;
      }
      return sb;
    };
  }

  // ─── 2. SourceBuffer.prototype.appendBuffer 劫持 ──────────

  if (window.SourceBuffer && SourceBuffer.prototype.appendBuffer) {
    const origAppendBuffer = SourceBuffer.prototype.appendBuffer;

    SourceBuffer.prototype.appendBuffer = function (data) {
      try {
        const stats = bufferStats.get(this);
        if (stats) {
          // data 可能是 ArrayBuffer 或 ArrayBufferView
          let size = 0;
          if (data instanceof ArrayBuffer) {
            size = data.byteLength;
          } else if (data && typeof data.byteLength === 'number') {
            size = data.byteLength;
          }
          stats.totalBytes += size;
          stats.chunkCount++;

          // 按阈值上报，避免消息风暴
          const now = Date.now();
          if (
            stats.totalBytes - (stats.lastReportBytes ?? 0) >= REPORT_BYTE_INTERVAL ||
            now - stats.lastReport >= REPORT_TIME_INTERVAL
          ) {
            stats.lastReport = now;
            stats.lastReportBytes = stats.totalBytes;

            postToBridge('bufferStats', {
              mimeType: stats.mimeType,
              totalBytes: stats.totalBytes,
              chunkCount: stats.chunkCount,
              url: location.href,
            });
          }
        }
      } catch {
        // 统计失败不影响播放
      }

      return origAppendBuffer.call(this, data);
    };
  }

  // ─── 3. URL.createObjectURL 劫持 ──────────────────────────

  if (URL.createObjectURL) {
    const origCreateObjectURL = URL.createObjectURL;

    URL.createObjectURL = function (obj) {
      const url = origCreateObjectURL.call(this, obj);

      try {
        const isMediaSource = obj instanceof MediaSource;
        const isBlob = obj instanceof Blob;
        const blobType = isBlob ? obj.type : '';

        postToBridge('createObjectURL', {
          blobUrl: url,
          isMediaSource: isMediaSource,
          blobType: blobType,
          size: isBlob ? obj.size : -1,
        });

        // 如果是 MediaSource 关联的 blob URL，记录关联关系
        // 这可以帮助将 L1 网络层的 m4s 请求与播放器关联起来
        if (isMediaSource) {
          // 为这个 MediaSource 实例建立 URL 映射
          // P2 阶段可用于将 buffer 数据关联到播放器
        }
      } catch {
        // 静默失败
      }

      return url;
    };
  }

  // ─── 4. window.fetch 劫持 ─────────────────────────────────

  if (window.fetch) {
    const origFetch = window.fetch;

    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input : (input && input.url) || '';

      const promise = origFetch.apply(this, arguments);

      // 只跟踪可能为媒体的请求
      if (url && isMediaUrl(url)) {
        promise
          .then((response) => {
            try {
              const contentType = response.headers.get('content-type') || '';
              const contentLength = response.headers.get('content-length') || '';

              // URL 特征或 MIME 类型命中
              if (isMediaUrl(url) || isMediaMime(contentType)) {
                // 推断类型
                let kind = 'video';
                if (contentType.startsWith('audio/')) kind = 'audio';
                else if (contentType.startsWith('image/')) kind = 'image';
                else if (contentType.includes('mpegurl') || contentType.includes('dash')) kind = 'stream';

                postToBridge('fetchMedia', {
                  url: url,
                  mime: contentType,
                  size: parseInt(contentLength, 10) || -1,
                  kind: kind,
                });
              }
            } catch {
              // 静默
            }
          })
          .catch(() => {
            // 请求失败不处理
          });
      }

      return promise;
    };
  }

  // ─── 5. XMLHttpRequest 劫持 ───────────────────────────────

  if (window.XMLHttpRequest) {
    const origOpen = XMLHttpRequest.prototype.open;
    const origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      try {
        // 用非枚举属性存储，避免干扰页面代码
        Object.defineProperty(this, '__webgrabUrl', {
          value: url,
          writable: true,
          enumerable: false,
          configurable: true,
        });
        Object.defineProperty(this, '__webgrabMethod', {
          value: method,
          writable: true,
          enumerable: false,
          configurable: true,
        });
      } catch {
        // 静默
      }
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      try {
        const url = this.__webgrabUrl;
        const method = this.__webgrabMethod;

        // 只跟踪可能为媒体的 GET 请求
        if (url && method === 'GET' && isMediaUrl(url)) {
          this.addEventListener(
            'load',
            function () {
              try {
                const contentType = this.getResponseHeader('content-type') || '';
                const contentLength = this.getResponseHeader('content-length') || '';

                if (isMediaUrl(url) || isMediaMime(contentType)) {
                  let kind = 'video';
                  if (contentType.startsWith('audio/')) kind = 'audio';
                  else if (contentType.startsWith('image/')) kind = 'image';
                  else if (contentType.includes('mpegurl') || contentType.includes('dash')) kind = 'stream';

                  postToBridge('xhrMedia', {
                    url: url,
                    mime: contentType,
                    size: parseInt(contentLength, 10) || -1,
                    kind: kind,
                  });
                }
              } catch {
                // 静默
              }
            },
            { once: true }
          );
        }
      } catch {
        // 静默
      }

      return origSend.apply(this, arguments);
    };
  }

  // ─── 6. video.src setter 劫持（捕获 blob: 之外的直接 src 赋值） ──

  try {
    const videoProto = HTMLVideoElement.prototype;
    const origSrcDescriptor = Object.getOwnPropertyDescriptor(videoProto, 'src') ||
      Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');

    if (origSrcDescriptor && origSrcDescriptor.set) {
      const origSrcSetter = origSrcDescriptor.set;

      Object.defineProperty(videoProto, 'src', {
        ...origSrcDescriptor,
        set(value) {
          try {
            // 非 blob URL 的直接 src 赋值
            if (typeof value === 'string' && !value.startsWith('blob:')) {
              if (isMediaUrl(value)) {
                postToBridge('videoSrc', {
                  url: value,
                  kind: 'video',
                });
              }
            }
          } catch {
            // 静默
          }
          return origSrcSetter.call(this, value);
        },
      });
    }
  } catch {
    // 静默
  }

  // ─── 通知 bridge.js：hook 已安装 ──────────────────────────
  postToBridge('hookReady', { url: location.href });
})();
