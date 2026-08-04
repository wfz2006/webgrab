/**
 * L2 DOM 层扫描 —— ISOLATED world content script
 *
 * 扫描页面 DOM 中的媒体资源：
 *   - img[src] / img[srcset] / picture > source / video / audio / source[src]
 *   - 懒加载属性：data-src / data-original / data-lazy / data-echo / data-actualsrc
 *   - CSS background-image（含 ::before / ::after 伪元素）
 *   - srcset 解析出最高分辨率候选
 *
 * 使用 MutationObserver 持续监听动态插入的节点（debounce 200ms）
 */

(function () {
  'use strict';

  if (window.__webgrabScannerInstalled) return;
  window.__webgrabScannerInstalled = true;

  /**
   * 扩展上下文是否已失效（扩展重载后旧 content script 会命中）
   * 一旦失效，停止所有后续上报和 MutationObserver，避免刷屏错误。
   */
  let extensionInvalidated = false;

  /**
   * 安全的 sendMessage 封装
   * 捕获 "Extension context invalidated" 错误，命中后标记失效并停止所有上报。
   * @param {Object} message
   * @returns {Promise<any>}
   */
  function safeSendMessage(message) {
    if (extensionInvalidated) return Promise.resolve();
    try {
      return chrome.runtime.sendMessage(message).catch((err) => {
        if (err && /Extension context invalidated/i.test(err.message)) {
          extensionInvalidated = true;
          shutdown();
        }
        // 其他错误静默（SW 可能休眠）
      });
    } catch (err) {
      // 同步抛出的 "Extension context invalidated"
      if (err && /Extension context invalidated/i.test(err.message)) {
        extensionInvalidated = true;
        shutdown();
      }
      return Promise.resolve();
    }
  }

  /**
   * 关闭所有监听，停止后续上报
   * 在扩展上下文失效后调用，避免 MutationObserver 继续触发 sendMessage 刷屏
   */
  function shutdown() {
    try { if (observer) observer.disconnect(); } catch {}
    try { if (scanTimer) clearTimeout(scanTimer); } catch {}
    try { if (scrollTimer) clearTimeout(scrollTimer); } catch {}
    console.log('[WebGrab/Scanner] 扩展上下文已失效，停止扫描与上报');
  }

  /** 懒加载属性列表 */
  const LAZY_ATTRS = [
    'data-src', 'data-original', 'data-lazy', 'data-echo',
    'data-actualsrc', 'data-lazy-src', 'data-srcset',
  ];
  const MEDIA_SELECTOR = 'img, video, audio, source, picture';
  const LAZY_SELECTOR = LAZY_ATTRS.map((attr) => `[${attr}]`).join(',');
  const INCREMENTAL_SELECTOR = `${MEDIA_SELECTOR},${LAZY_SELECTOR}`;

  /** 已知图片扩展名 */
  const IMAGE_EXTS = new Set([
    'jpg', 'jpeg', 'png', 'gif', 'webp', 'avif', 'svg', 'bmp', 'ico',
  ]);
  /** 已知视频扩展名 */
  const VIDEO_EXTS = new Set([
    'mp4', 'webm', 'm4s', 'ts', 'flv', 'mkv', 'mov', 'm3u8', 'mpd',
  ]);
  /** 已知音频扩展名 */
  const AUDIO_EXTS = new Set([
    'mp3', 'm4a', 'aac', 'flac', 'wav', 'ogg', 'opus',
  ]);

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

  /**
   * 提取文件名
   * @param {string} url
   * @returns {string}
   */
  function extractFileName(url) {
    try {
      const u = new URL(url, location.href);
      const path = u.pathname;
      const slash = path.lastIndexOf('/');
      return slash !== -1 ? path.slice(slash + 1) : path;
    } catch {
      return url.split('/').pop() || 'unknown';
    }
  }

  /**
   * 推断资源类型
   * @param {string} ext
   * @param {string} [mime]
   * @returns {string}
   */
  function guessKind(ext, mime) {
    if (IMAGE_EXTS.has(ext)) return 'image';
    if (VIDEO_EXTS.has(ext)) return ext === 'm3u8' || ext === 'mpd' ? 'stream' : 'video';
    if (AUDIO_EXTS.has(ext)) return 'audio';
    if (mime) {
      if (mime.startsWith('image/')) return 'image';
      if (mime.startsWith('video/')) return 'video';
      if (mime.startsWith('audio/')) return 'audio';
      if (mime.includes('mpegurl') || mime.includes('dash')) return 'stream';
    }
    return 'image'; // 默认
  }

  /**
   * 解析 srcset，返回最高分辨率的候选 URL
   * @param {string} srcset
   * @returns {string|null}
   */
  function parseSrcset(srcset) {
    if (!srcset) return null;
    const parts = srcset.split(',').map((s) => s.trim());
    let bestUrl = null;
    let bestValue = 0;

    for (const part of parts) {
      const tokens = part.split(/\s+/);
      const url = tokens[0];
      const descriptor = tokens[1] || '';

      let value = 0;
      if (descriptor.endsWith('x')) {
        value = parseFloat(descriptor) || 1;
      } else if (descriptor.endsWith('w')) {
        value = parseInt(descriptor, 10) || 0;
      } else {
        value = 1; // 无描述符，默认
      }

      if (value >= bestValue) {
        bestValue = value;
        bestUrl = url;
      }
    }

    return bestUrl;
  }

  /**
   * 从 CSS background-image 值中提取 URL
   * @param {string} bgValue
   * @returns {string[]}
   */
  function extractBgUrls(bgValue) {
    if (!bgValue || bgValue === 'none') return [];
    const urls = [];
    // 匹配 url(...) 和 url("...") 和 url('...')
    const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
    let match;
    while ((match = re.exec(bgValue)) !== null) {
      const url = match[1];
      if (url && !url.startsWith('data:') && !url.startsWith('blob:')) {
        urls.push(url);
      }
    }
    return urls;
  }

  /** 已上报的 URL 集合（页面内去重，减少消息量） */
  const reportedUrls = new Set();

  // DOM 资源第一次被看见时分配稳定顺序。初次扫描严格按 querySelectorAll 的
  // 文档顺序执行；懒加载只更新已有元素的 URL，不会改变已记录页序。
  const elementDomIndexes = new WeakMap();
  let nextDomIndex = 0;

  function getElementDomIndex(element) {
    if (!elementDomIndexes.has(element)) {
      elementDomIndexes.set(element, nextDomIndex++);
    }
    return elementDomIndexes.get(element);
  }

  /**
   * 上报资源列表到 SW
   * @param {Array<{url: string, kind: string, ext: string, mime: string, size: number, title: string}>} resources
   */
  function reportResources(resources) {
    if (resources.length === 0) return;

    // 页面内去重
    const newResources = resources.filter((r) => {
      if (reportedUrls.has(r.url)) return false;
      reportedUrls.add(r.url);
      return true;
    });

    if (newResources.length === 0) return;

    safeSendMessage({
      type: 'DOM_RESOURCES',
      resources: newResources,
    });
  }

  /**
   * 创建资源对象
   * @param {string} url
   * @param {string} [mime]
   * @param {number} [size]
   * @param {string} [title]
   * @returns {{url: string, kind: string, ext: string, mime: string, size: number, title: string}}
   */
  function makeResource(url, mime, size, title) {
    const ext = extractExt(url);
    return {
      url,
      kind: guessKind(ext, mime),
      ext,
      mime: mime || '',
      size: size ?? -1,
      title: title || extractFileName(url),
    };
  }

  /**
   * 扫描单个元素的媒体属性
   * @param {Element} el
   * @returns {Array}
   */
  function scanElement(el) {
    const results = [];
    if (!el || el.nodeType !== Node.ELEMENT_NODE) return results;
    const domIndex = getElementDomIndex(el);

    try {
      const tagName = el.tagName.toLowerCase();

      // ── img 元素 ──
      if (tagName === 'img') {
        // src
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
          results.push(makeResource(resolveUrl(src)));
        }
        // srcset → 取最高分辨率
        const srcset = el.getAttribute('srcset') || el.getAttribute('data-srcset');
        if (srcset) {
          const bestUrl = parseSrcset(srcset);
          if (bestUrl && !bestUrl.startsWith('data:')) {
            results.push(makeResource(resolveUrl(bestUrl)));
          }
        }
        // 懒加载属性
        for (const attr of LAZY_ATTRS) {
          const val = el.getAttribute(attr);
          if (val && !val.startsWith('data:')) {
            if (attr === 'data-srcset') {
              const bestUrl = parseSrcset(val);
              if (bestUrl) results.push(makeResource(resolveUrl(bestUrl)));
            } else {
              results.push(makeResource(resolveUrl(val)));
            }
          }
        }
      }

      // ── picture > source ──
      if (tagName === 'source') {
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:')) {
          results.push(makeResource(resolveUrl(src)));
        }
        const srcset = el.getAttribute('srcset');
        if (srcset) {
          const bestUrl = parseSrcset(srcset);
          if (bestUrl && !bestUrl.startsWith('data:')) {
            results.push(makeResource(resolveUrl(bestUrl)));
          }
        }
      }

      // ── video 元素 ──
      if (tagName === 'video') {
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
          results.push(makeResource(resolveUrl(src), '', -1, 'video'));
        }
        const poster = el.getAttribute('poster');
        if (poster && !poster.startsWith('data:')) {
          results.push(makeResource(resolveUrl(poster), 'image/jpeg', -1, 'poster'));
        }
      }

      // ── audio 元素 ──
      if (tagName === 'audio') {
        const src = el.getAttribute('src');
        if (src && !src.startsWith('data:') && !src.startsWith('blob:')) {
          results.push(makeResource(resolveUrl(src), 'audio/mpeg', -1, 'audio'));
        }
      }

      // ── 所有元素的懒加载属性（通用） ──
      for (const attr of LAZY_ATTRS) {
        if (tagName !== 'img' && tagName !== 'source') {
          const val = el.getAttribute(attr);
          if (val && !val.startsWith('data:') && !val.startsWith('blob:')) {
            const ext = extractExt(val);
            if (IMAGE_EXTS.has(ext) || VIDEO_EXTS.has(ext)) {
              results.push(makeResource(resolveUrl(val)));
            }
          }
        }
      }

      // ── CSS background-image（内联样式） ──
      const inlineBg = el.style && el.style.backgroundImage;
      if (inlineBg && inlineBg !== 'none') {
        const urls = extractBgUrls(inlineBg);
        for (const url of urls) {
          results.push(makeResource(resolveUrl(url)));
        }
      }
    } catch {
      // 扫描单个元素出错不影响其他元素
    }

    for (const resource of results) resource.domIndex = domIndex;
    return results;
  }

  /**
   * 扫描 CSS background-image（计算样式 + 伪元素）
   * 只在初次全量扫描时调用，避免性能问题
   * @returns {Array}
   */
  function scanComputedBackgrounds() {
    const results = [];
    try {
      // 只检查可能含有背景图的元素，避免遍历全部 DOM
      const candidates = document.querySelectorAll(
        'div, section, article, aside, header, footer, nav, main, span, a, li, figure, picture, [class*="bg"], [class*="background"], [class*="image"], [class*="banner"], [class*="cover"], [class*="thumb"], [class*="hero"], [style*="background"]'
      );

      for (const el of candidates) {
        const resultStart = results.length;
        try {
          // 主元素背景
          const bg = getComputedStyle(el).backgroundImage;
          if (bg && bg !== 'none') {
            const urls = extractBgUrls(bg);
            for (const url of urls) {
              results.push(makeResource(resolveUrl(url)));
            }
          }

          // 伪元素 ::before
          const bgBefore = getComputedStyle(el, '::before').backgroundImage;
          if (bgBefore && bgBefore !== 'none') {
            const urls = extractBgUrls(bgBefore);
            for (const url of urls) {
              results.push(makeResource(resolveUrl(url)));
            }
          }

          // 伪元素 ::after
          const bgAfter = getComputedStyle(el, '::after').backgroundImage;
          if (bgAfter && bgAfter !== 'none') {
            const urls = extractBgUrls(bgAfter);
            for (const url of urls) {
              results.push(makeResource(resolveUrl(url)));
            }
          }
        } catch {
          // 单个元素出错跳过
        }
        const domIndex = getElementDomIndex(el);
        for (let index = resultStart; index < results.length; index++) {
          results[index].domIndex = domIndex;
        }
      }
    } catch {
      // 整体扫描出错不报错
    }

    return results;
  }

  /**
   * 将相对 URL 解析为绝对 URL
   * @param {string} url
   * @returns {string}
   */
  function resolveUrl(url) {
    try {
      return new URL(url, location.href).href;
    } catch {
      return url;
    }
  }

  /**
   * 全量扫描文档
   * @param {boolean} [includeComputedBg=true] 是否扫描计算样式的背景图（性能开销大）
   * @returns {Array}
   */
  function scanDocument(includeComputedBg = true) {
    const allResources = [];

    // ── 媒体元素 ──
    const mediaEls = document.querySelectorAll(MEDIA_SELECTOR);
    for (const el of mediaEls) {
      allResources.push(...scanElement(el));
    }

    // ── 懒加载元素（非 img/source） ──
    const lazyEls = document.querySelectorAll(LAZY_SELECTOR);
    for (const el of lazyEls) {
      if (el.tagName.toLowerCase() !== 'img' && el.tagName.toLowerCase() !== 'source') {
        allResources.push(...scanElement(el));
      }
    }

    // ── CSS 计算样式背景图（含伪元素） ──
    if (includeComputedBg) {
      allResources.push(...scanComputedBackgrounds());
    }

    return allResources;
  }

  /**
   * 从当前文档仍保留的 PerformanceResourceTiming 中恢复历史媒体请求。
   * 扩展安装/重载后的补注入无法重放已经完成的 fetch/XHR，但浏览器通常仍保存
   * 这些请求的轻量 URL 记录；这里仅恢复已知媒体扩展名，避免把脚本/接口混入列表。
   * @returns {Array}
   */
  function scanPerformanceResources() {
    const resources = [];
    let entries = [];
    try {
      entries = performance?.getEntriesByType?.('resource') || [];
    } catch {
      return resources;
    }

    for (const entry of entries) {
      const url = typeof entry?.name === 'string' ? entry.name : '';
      if (!/^https?:/i.test(url)) continue;
      const ext = extractExt(url);
      if (!IMAGE_EXTS.has(ext) && !VIDEO_EXTS.has(ext) && !AUDIO_EXTS.has(ext)) continue;
      const size = Number(entry.decodedBodySize || entry.transferSize || -1);
      resources.push(makeResource(url, '', Number.isFinite(size) && size > 0 ? size : -1));
    }
    return resources;
  }

  // ─── 初始扫描 ────────────────────────────────────────────

  /**
   * 执行扫描并上报
   * @param {boolean} [includeComputedBg]
   */
  function doScan(includeComputedBg, includePerformanceHistory = false) {
    const resources = scanDocument(includeComputedBg);
    if (includePerformanceHistory) resources.push(...scanPerformanceResources());
    reportResources(resources);
  }

  // 等待 DOM 就绪后首次扫描
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => doScan(true, true));
  } else {
    doScan(true, true);
  }

  // ─── MutationObserver（debounce 200ms） ───────────────────

  let scanTimer = null;
  const pendingAddedRoots = new Set();
  const pendingAttributeTargets = new Set();

  /**
   * 对一个新增元素及其子树做增量扫描。只查询这棵新子树，不查询 document。
   * @param {Element} root
   * @param {WeakSet<Element>} scannedElements
   * @param {Array} resources
   */
  function scanAddedSubtree(root, scannedElements, resources) {
    if (!root || root.nodeType !== Node.ELEMENT_NODE) return;

    if (root.matches?.(INCREMENTAL_SELECTOR) && !scannedElements.has(root)) {
      scannedElements.add(root);
      resources.push(...scanElement(root));
    }
    for (const element of root.querySelectorAll?.(INCREMENTAL_SELECTOR) || []) {
      if (scannedElements.has(element)) continue;
      scannedElements.add(element);
      resources.push(...scanElement(element));
    }
  }

  function flushIncrementalScan() {
    const addedRoots = Array.from(pendingAddedRoots);
    const attributeTargets = Array.from(pendingAttributeTargets);
    pendingAddedRoots.clear();
    pendingAttributeTargets.clear();
    scanTimer = null;

    const resources = [];
    const scannedElements = new WeakSet();
    for (const root of addedRoots) {
      scanAddedSubtree(root, scannedElements, resources);
    }
    for (const target of attributeTargets) {
      if (!target || target.nodeType !== Node.ELEMENT_NODE || scannedElements.has(target)) continue;
      scannedElements.add(target);
      resources.push(...scanElement(target));
    }
    reportResources(resources);
  }

  function scheduleIncrementalScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(flushIncrementalScan, 200);
  }

  const observer = new MutationObserver((mutations) => {
    let queued = false;

    for (const mutation of mutations) {
      if (mutation.type === 'childList' && mutation.addedNodes.length > 0) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType === Node.ELEMENT_NODE) {
            pendingAddedRoots.add(node);
            queued = true;
          }
        }
      }
      if (mutation.type === 'attributes' && mutation.target?.nodeType === Node.ELEMENT_NODE) {
        pendingAttributeTargets.add(mutation.target);
        queued = true;
      }
    }

    if (queued) scheduleIncrementalScan();
  });

  // 开始观察
  if (document.body) {
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'srcset', ...LAZY_ATTRS, 'style', 'poster'],
    });
  } else {
    // body 尚未就绪，等 DOMContentLoaded
    document.addEventListener('DOMContentLoaded', () => {
      observer.observe(document.body, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['src', 'srcset', ...LAZY_ATTRS, 'style', 'poster'],
      });
    });
  }

  // ─── 滚动监听（懒加载触发） ────────────────────────────────
  let scrollTimer = null;
  window.addEventListener(
    'scroll',
    () => {
      if (scrollTimer) clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        doScan(false);
        scrollTimer = null;
      }, 300);
    },
    { passive: true, capture: true }
  );

  // ─── 延迟二次扫描（捕获动态加载） ──────────────────────────
  // 页面加载后 2 秒再扫描一次，捕获 JS 动态插入的内容
  setTimeout(() => doScan(true, true), 2000);
  setTimeout(() => doScan(false, true), 5000);
})();
