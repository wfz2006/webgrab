/**
 * 分片调度下载器 —— Offscreen Document 中使用
 *
 * 功能：
 *   - 并发下载分片（默认 6 并发，上限 8）
 *   - 滑动窗口保序输出：并发下载可以乱序完成，但通过 onSegment 回调
 *     严格按序号顺序交给下游（remuxer / writer），避免重蹈"全部下完再处理"的覆辙
 *   - 单片失败重试 3 次，仍失败则整个任务失败并报告第几片
 *   - 支持 AES-128 解密（EXT-X-KEY），用 WebCrypto 的 AES-CBC
 *   - 支持 byteRange
 *   - 实时进度：已完成片数 / 总片数 + 字节进度
 *   - 支持 AbortController 取消
 *
 * 内存约束：每个分片下载完成后立即交给 onSegment 回调，不累积所有分片。
 *   滑动窗口缓冲只保存"已完成但还未轮到输出"的分片，窗口大小 ≤ 并发数。
 */

import { buildAesIv } from './hls-parser.js';

/** 默认并发数 */
const DEFAULT_CONCURRENCY = 6;
/** 最大并发数 */
const MAX_CONCURRENCY = 8;
/** 单片最大重试次数 */
const MAX_RETRIES = 3;
/** 重试基础延迟（毫秒） */
const RETRY_BASE_DELAY = 1000;
/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 30_000;

/**
 * @typedef {Object} SegmentInfo
 * @property {number}   index        - 分片在列表中的索引（0-based）
 * @property {Uint8Array} data       - 分片数据（已解密）
 * @property {number}   byteLength   - 数据字节长度
 */

/**
 * @typedef {Object} SegmentProgress
 * @property {number} completed   - 已完成片数
 * @property {number} total       - 总片数
 * @property {number} bytesDownloaded - 已下载字节
 * @property {number} speed       - 速度（字节/秒）
 */

/**
 * 分片下载器
 *
 * 用法：
 *   const fetcher = new SegmentFetcher(segments, options);
 *   await fetcher.fetch(onProgress, onSegment);
 *
 * onSegment 会被严格按 index 升序调用，即使分片乱序完成。
 * 调用方应在 onSegment 中立即处理数据（交给 remuxer 或写盘）并释放引用。
 */
export class SegmentFetcher {
  /**
   * @param {Array} segments - 分片列表（来自 hls-parser 或 dash-parser）
   *   每个分片应有：{ uri, byteRange?, key?, sequence? }
   * @param {Object} [options]
   * @param {number} [options.concurrency] - 并发数
   * @param {AbortSignal} [options.signal] - 取消信号
   * @param {Object} [options.headers] - 额外请求头
   */
  constructor(segments, options = {}) {
    this.segments = segments;
    this.concurrency = Math.min(Math.max(options.concurrency || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENCY);
    this.signal = options.signal;
    this.headers = options.headers || {};

    /** @type {Map<number, SegmentInfo>} 已完成的分片缓冲（index → data），等待按序输出 */
    this._buffer = new Map();
    /** 下一个要输出的分片索引 */
    this._nextOutputIndex = 0;
    /** @type {Map<string, ArrayBuffer>} key 缓存（keyUri → rawKeyBytes） */
    this._keyCache = new Map();
    /** @type {Map<string, CryptoKey>} CryptoKey 缓存（keyUri → CryptoKey） */
    this._cryptoKeyCache = new Map();

    /** 进度统计 */
    this._completedCount = 0;
    this._bytesDownloaded = 0;
    this._speedStartTime = 0;
    this._speedLastUpdate = 0;
    this._speedLastBytes = 0;
    this._currentSpeed = 0;
  }

  /**
   * 启动下载
   * @param {(progress: SegmentProgress) => void} [onProgress]
   * @param {(segment: SegmentInfo) => void|Promise<void>} [onSegment] - 按序输出的分片回调
   * @returns {Promise<void>}
   */
  async fetch(onProgress, onSegment) {
    this.onProgress = onProgress || null;
    this.onSegment = onSegment || null;
    this._speedStartTime = Date.now();
    this._speedLastUpdate = this._speedStartTime;
    this._speedLastBytes = 0;

    const total = this.segments.length;
    if (total === 0) return;

    // 并发执行
    await this._runConcurrent(total, (index) => this._downloadSegment(index));

    // 刷新剩余缓冲（理论上下载完成时缓冲应该已空）
    await this._flushBuffer();
  }

  /**
   * 下载单个分片（含重试）
   */
  async _downloadSegment(index) {
    const segment = this.segments[index];
    let lastError = null;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      if (this.signal?.aborted) {
        throw new DOMException('下载已取消', 'AbortError');
      }

      try {
        const response = await this._fetchWithTimeout(segment.uri, {
          method: 'GET',
          headers: this._buildHeaders(segment),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        let buffer = await response.arrayBuffer();
        let data = new Uint8Array(buffer);

        // 注意：byteRange 已通过 Range 请求头让服务器返回正确的切片，
        // 响应体就是我们需要的那部分数据，不要再做二次切片。
        // （之前的 _extractByteRange 用绝对偏移量在已截断的响应体上再切一刀，会损坏数据）

        // 处理 AES-128 解密
        if (segment.key && segment.key.method === 'AES-128' && segment.key.uri) {
          data = await this._decryptAes128(data, segment.key, segment.sequence ?? index);
        }

        // 放入缓冲并尝试按序输出
        await this._pushAndFlush(index, data);

        // 更新进度
        this._completedCount++;
        this._bytesDownloaded += data.byteLength;
        this._updateSpeed();
        this._reportProgress();

        return;
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;

        if (attempt < MAX_RETRIES) {
          const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
          console.warn(`[WebGrab] 分片 ${index} 第 ${attempt + 1} 次重试 (${delay}ms后): ${err.message}`);
          await this._sleep(delay);
        }
      }
    }

    throw new Error(`分片 ${index} 下载失败（重试 ${MAX_RETRIES} 次后仍失败）: ${lastError?.message}`);
  }

  /**
   * 将分片放入缓冲，然后按序输出所有连续的分片
   *
   * 这是保序输出的核心：分片可能乱序完成，但只有 index === nextOutputIndex
   * 的分片才会被立即输出，之后的连续分片也会一起输出。
   * 之前因等待而滞留在缓冲中的分片会在轮到它们时被一起冲刷出去。
   *
   * @param {number} index
   * @param {Uint8Array} data
   */
  async _pushAndFlush(index, data) {
    this._buffer.set(index, {
      index,
      data,
      byteLength: data.byteLength,
    });

    // 按序输出所有连续的分片
    while (this._buffer.has(this._nextOutputIndex)) {
      const seg = this._buffer.get(this._nextOutputIndex);
      this._buffer.delete(this._nextOutputIndex);

      if (this.onSegment) {
        // onSegment 可能返回 Promise（如写盘），await 它确保处理完成
        await this.onSegment(seg);
      }

      this._nextOutputIndex++;
    }
  }

  /**
   * 冲刷剩余缓冲（下载结束后调用，理论上应该为空）
   */
  async _flushBuffer() {
    while (this._buffer.size > 0) {
      const seg = this._buffer.get(this._nextOutputIndex);
      if (!seg) {
        // 有缺口，说明有分片下载失败，跳出
        console.warn(`[WebGrab] 分片缓冲有缺口，缺失索引: ${this._nextOutputIndex}`);
        break;
      }
      this._buffer.delete(this._nextOutputIndex);
      if (this.onSegment) {
        await this.onSegment(seg);
      }
      this._nextOutputIndex++;
    }
  }

  /**
   * AES-128 解密
   * @param {Uint8Array} encrypted - 加密数据
   * @param {Object} keyInfo - { method, uri, iv }
   * @param {number} sequence - 分片序号（IV 缺省时用）
   * @returns {Promise<Uint8Array>} 解密后的数据
   */
  async _decryptAes128(encrypted, keyInfo, sequence) {
    // 获取或下载 key
    let keyBytes = this._keyCache.get(keyInfo.uri);
    if (!keyBytes) {
      keyBytes = await this._fetchKey(keyInfo.uri);
      this._keyCache.set(keyInfo.uri, keyBytes);
    }

    // 获取或创建 CryptoKey
    let cryptoKey = this._cryptoKeyCache.get(keyInfo.uri);
    if (!cryptoKey) {
      cryptoKey = await crypto.subtle.importKey(
        'raw',
        keyBytes,
        { name: 'AES-CBC' },
        false,
        ['decrypt']
      );
      this._cryptoKeyCache.set(keyInfo.uri, cryptoKey);
    }

    // 构造 IV
    const iv = buildAesIv(keyInfo.iv, sequence);

    // AES-CBC 解密（PKCS7 padding 由 WebCrypto 自动处理）
    // 注意：加密数据长度必须是 16 字节的倍数
    const alignedLength = Math.floor(encrypted.length / 16) * 16;
    if (alignedLength !== encrypted.length) {
      // 非对齐，截取对齐部分（HLS 规范要求对齐，但有些实现不规范）
      console.warn(`[WebGrab] AES-128 数据长度 ${encrypted.length} 不是 16 的倍数，截取到 ${alignedLength}`);
    }

    const decrypted = await crypto.subtle.decrypt(
      { name: 'AES-CBC', iv },
      cryptoKey,
      encrypted.buffer.slice(0, alignedLength)
    );

    return new Uint8Array(decrypted);
  }

  /**
   * 下载 key
   * @param {string} uri
   * @returns {Promise<ArrayBuffer>}
   */
  async _fetchKey(uri) {
    const response = await this._fetchWithTimeout(uri, { method: 'GET' });
    if (!response.ok) {
      throw new Error(`获取 key 失败: HTTP ${response.status}`);
    }
    return response.arrayBuffer();
  }

  /**
   * 构建请求头（含 byteRange）
   */
  _buildHeaders(segment) {
    const headers = { ...this.headers };
    if (segment.byteRange) {
      headers['Range'] = `bytes=${segment.byteRange}`;
    }
    return headers;
  }

  /**
   * 带超时的 fetch
   */
  async _fetchWithTimeout(url, options = {}) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);

    // 合并外部 signal
    if (this.signal) {
      if (this.signal.aborted) {
        controller.abort();
      } else {
        this.signal.addEventListener('abort', () => controller.abort(), { once: true });
      }
    }

    try {
      const response = await fetch(url, {
        ...options,
        signal: controller.signal,
      });
      return response;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * 并发执行器
   * @param {number} total - 总任务数
   * @param {(index: number) => Promise<void>} taskFn
   */
  async _runConcurrent(total, taskFn) {
    let nextIndex = 0;
    const workers = [];

    const worker = async () => {
      while (true) {
        const index = nextIndex++;
        if (index >= total) break;
        if (this.signal?.aborted) {
          throw new DOMException('下载已取消', 'AbortError');
        }
        await taskFn(index);
      }
    };

    for (let i = 0; i < this.concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);
  }

  /**
   * 更新速度计算
   */
  _updateSpeed() {
    const now = Date.now();
    const elapsed = now - this._speedLastUpdate;
    if (elapsed < 500) return; // 500ms 更新一次

    const bytesDiff = this._bytesDownloaded - this._speedLastBytes;
    this._currentSpeed = Math.round((bytesDiff / elapsed) * 1000);

    this._speedLastUpdate = now;
    this._speedLastBytes = this._bytesDownloaded;
  }

  /**
   * 上报进度
   */
  _reportProgress() {
    if (!this.onProgress) return;
    this.onProgress({
      completed: this._completedCount,
      total: this.segments.length,
      bytesDownloaded: this._bytesDownloaded,
      speed: this._currentSpeed,
    });
  }

  /**
   * sleep
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
