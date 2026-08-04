/**
 * HTTP 下载器 —— Offscreen Document 中的分块下载引擎
 *
 * 功能：
 *   - 多源 fallback：传入 urls 数组（主 URL + backup URLs），当前源失败自动切下一个
 *   - Range 分块并发下载：先探测 Content-Length 和 Accept-Ranges，支持则分块并发
 *   - 不支持 Range 时退回单线程流式下载
 *   - 每块独立重试 3 次，指数退避
 *   - 通过 onProgress 回调上报进度（已下载字节 / 总字节 / 速度 / 剩余时间）
 *   - 通过 onChunk 回调实时上报分块（流水线写盘，不累积所有数据在内存中）
 *   - 支持 AbortController 取消
 *
 * 内存约束：onChunk 回调会在每个分块/流片段完成时立即触发，
 * 调用方应在回调中立即写盘并释放引用，使内存占用恒定在 concurrency 个分块以内。
 */

/** 默认分块并发数 */
const DEFAULT_CONCURRENCY = 4;
/** 最大分块并发数 */
const MAX_CONCURRENCY = 8;
/** 单块最小大小（1MB，太小不值得分块） */
const MIN_CHUNK_SIZE = 1024 * 1024;
/** 单块最大大小（50MB，太大内存占用高） */
const MAX_CHUNK_SIZE = 50 * 1024 * 1024;
/** 每块重试次数 */
const MAX_RETRIES = 3;
/** 重试基础退避（毫秒） */
const RETRY_BASE_DELAY = 1000;
/** 请求超时（毫秒） */
const REQUEST_TIMEOUT = 30_000;

/**
 * @typedef {Object} ProgressInfo
 * @property {number} downloaded - 已下载字节
 * @property {number} total     - 总字节（-1 表示未知）
 * @property {number} speed     - 当前速度（字节/秒）
 * @property {number} eta       - 预计剩余秒数（-1 表示未知）
 */

/**
 * @typedef {Object} ChunkInfo
 * @property {number} index   - 分块索引（分块模式从 0 开始；流式模式恒为 0）
 * @property {Uint8Array} data - 分块数据（回调返回后调用方应立即写盘并释放引用）
 * @property {number} offset   - 该分块在完整文件中的字节偏移
 * @property {number} length   - 该分块的字节长度
 */

/**
 * @typedef {Object} FetchOptions
 * @property {number} [concurrency]  - 分块并发数
 * @property {number} [chunkSize]    - 指定分块大小（字节），不指定则自动计算
 *                                      B 站流式合并场景需指定（如 2MB），配合 concurrency=1 顺序下载
 * @property {Object} [headers]      - 额外请求头（DNR 已注入 Referer 等，这里用于非 DNR 场景）
 * @property {AbortSignal} [signal]  - 取消信号
 */

/**
 * HTTP 下载器
 */
export class HttpFetcher {
  /**
   * @param {string[]} urls - 主 URL + backup URLs
   * @param {FetchOptions} [options]
   */
  constructor(urls, options = {}) {
    this.urls = urls.filter(Boolean);
    if (this.urls.length === 0) throw new Error('HttpFetcher 需要至少一个 URL');
    this.concurrency = Math.min(Math.max(options.concurrency || DEFAULT_CONCURRENCY, 1), MAX_CONCURRENCY);
    this.chunkSize = options.chunkSize || 0; // 0 = 自动计算
    this.extraHeaders = options.headers || {};
    this.signal = options.signal;

    /** 当前使用的 URL 索引 */
    this.urlIndex = 0;
    /** @type {ProgressInfo} */
    this.progress = { downloaded: 0, total: -1, speed: 0, eta: -1 };
    /** 进度回调 */
    this.onProgress = null;
    /** 分块完成回调（流水线写盘用，签名 (chunk: ChunkInfo) => void|Promise<void>） */
    this.onChunk = null;
    /** 完成回调 */
    this.onComplete = null;
    /** 错误回调 */
    this.onError = null;

    /** 速度计算用 */
    this._speedStartTime = 0;
    this._speedStartBytes = 0;
    this._speedLastUpdate = 0;
  }

  /**
   * 获取当前 URL
   * @returns {string}
   */
  get currentUrl() {
    return this.urls[this.urlIndex];
  }

  /**
   * 切换到下一个 backup URL
   * @returns {boolean} 是否切换成功
   */
  switchToNextUrl() {
    if (this.urlIndex < this.urls.length - 1) {
      this.urlIndex++;
      console.log(`[WebGrab] 切换到 backup URL: ${this.currentUrl}`);
      return true;
    }
    return false;
  }

  /**
   * 带超时的 fetch
   * @param {string} url
   * @param {RequestInit} init
   * @param {number} [timeout]
   * @returns {Promise<Response>}
   */
  async _fetchWithTimeout(url, init, timeout = REQUEST_TIMEOUT) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);

    // 合并 signal（外部 signal 和超时 signal）
    if (this.signal) {
      this.signal.addEventListener('abort', () => controller.abort());
    }

    try {
      // 注入额外请求头
      const headers = new Headers(init.headers || {});
      for (const [key, value] of Object.entries(this.extraHeaders)) {
        headers.set(key, value);
      }
      const response = await fetch(url, { ...init, headers, signal: controller.signal });
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 探测：发送 HEAD 或 Range 请求，获取 Content-Length 和 Accept-Ranges
   * @returns {Promise<{totalSize: number, acceptRanges: boolean}>}
   */
  async probe() {
    // 尝试 Range: bytes=0-0 请求
    let lastError = null;
    for (let i = 0; i < this.urls.length; i++) {
      let host = '';
      try { host = new URL(this.urls[i]).hostname; } catch {}
      try {
        // cache: 'no-store' 是必须的：这个探测只要 1 个字节，若让它进 HTTP 缓存，
        // Chrome 之后会把这条 1 字节的分片条目当成该 URL 的缓存内容，
        // 随后不带 Range 的完整 GET 会拿回 "200 + 完整 Content-Length，但 body 只有
        // 1 字节" 的响应——真机上就是这样把小文件静默下成 1 字节残file的。
        const response = await this._fetchWithTimeout(this.urls[i], {
          method: 'GET',
          headers: { Range: 'bytes=0-0' },
          cache: 'no-store',
        });

        if (!response.ok && response.status !== 206) {
          // ── P3 诊断插桩 ──
          console.error('[WebGrab/FETCH-DEBUG] probe 失败', {
            status: response.status,
            host,
            urlIndex: i,
            attempt: i + 1,
            rangeHeader: 'bytes=0-0',
            url: this.urls[i].slice(0, 120),
          });
          throw new Error(`HTTP ${response.status}`);
        }

        const contentRange = response.headers.get('content-range');
        const acceptRanges = response.headers.get('accept-ranges');
        const contentLength = response.headers.get('content-length');

        let totalSize = -1;
        // Content-Range: bytes 0-0/1234567
        if (contentRange) {
          const match = contentRange.match(/\/(\d+)/);
          if (match) totalSize = parseInt(match[1], 10);
        }

        const supportsRange = response.status === 206 && (acceptRanges === 'bytes' || !!contentRange);

        this.urlIndex = i;
        return { totalSize, acceptRanges: supportsRange };
      } catch (err) {
        // ── P3 诊断插桩 ── 网络错误/abort 也记一次
        if (!err.message || !err.message.startsWith('HTTP ')) {
          console.error('[WebGrab/FETCH-DEBUG] probe 异常', {
            errName: err.name,
            errMsg: err.message,
            host,
            urlIndex: i,
            attempt: i + 1,
          });
        }
        lastError = err;
        // 尝试下一个 URL
        if (i < this.urls.length - 1) continue;
      }
    }
    throw lastError || new Error('探测失败');
  }

  /**
   * 启动下载
   *
   * 流水线模式：每下完一块/一段立即通过 onChunk 回调交给调用方写盘，
   * 调用方在回调中应立即写盘并释放对 data 的引用，保证内存占用恒定。
   *
   * @param {(info: ProgressInfo) => void} [onProgress]
   * @param {(chunk: ChunkInfo) => void|Promise<void>} [onChunk] - 分块完成回调
   * @returns {Promise<{totalSize: number}>} 不含数据，数据已通过 onChunk 流式交出
   */
  async download(onProgress, onChunk) {
    this.onProgress = onProgress || null;
    this.onChunk = onChunk || null;
    this._speedStartTime = Date.now();
    this._speedStartBytes = 0;
    this._speedLastUpdate = this._speedStartTime;

    // 探测
    const probeResult = await this.probe();
    this.progress.total = probeResult.totalSize;

    if (probeResult.acceptRanges && probeResult.totalSize > 0 && probeResult.totalSize > MIN_CHUNK_SIZE) {
      // 分块并发下载
      return this._downloadChunked(probeResult.totalSize);
    }

    // 单线程流式下载
    return this._downloadStream();
  }

  /**
   * 分块并发下载
   *
   * 每个分块下载完成后立即通过 onChunk 回调交给调用方写盘，
   * 不在内存中累积所有分块。分块可能乱序完成，但 offset 字段保证写盘正确。
   *
   * @param {number} totalSize
   * @returns {Promise<{totalSize: number}>}
   */
  async _downloadChunked(totalSize) {
    // 计算分块大小：优先使用调用方指定的 chunkSize，否则自动计算
    let chunkSize;
    if (this.chunkSize > 0) {
      chunkSize = Math.min(Math.max(this.chunkSize, MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
    } else {
      chunkSize = Math.ceil(totalSize / this.concurrency);
      chunkSize = Math.min(Math.max(chunkSize, MIN_CHUNK_SIZE), MAX_CHUNK_SIZE);
    }

    const chunkCount = Math.ceil(totalSize / chunkSize);

    console.log(`[WebGrab] 分块下载: total=${totalSize} chunks=${chunkCount} chunkSize=${chunkSize} concurrency=${this.concurrency}`);

    const downloadChunk = async (chunkIndex) => {
      const start = chunkIndex * chunkSize;
      const end = Math.min(start + chunkSize - 1, totalSize - 1);

      let lastError = null;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (this.signal?.aborted) throw new DOMException('下载已取消', 'AbortError');

        let host = '';
        try { host = new URL(this.currentUrl).hostname; } catch {}
        const rangeHeader = `bytes=${start}-${end}`;

        try {
          const response = await this._fetchWithTimeout(this.currentUrl, {
            method: 'GET',
            headers: { Range: rangeHeader },
          });

          if (response.status !== 206) {
            // ── P3 诊断插桩 ──
            console.error('[WebGrab/FETCH-DEBUG] _downloadChunked 失败', {
              status: response.status,
              host,
              rangeHeader,
              attempt: attempt + 1,
              chunkIndex,
              urlIndex: this.urlIndex,
              url: this.currentUrl.slice(0, 120),
            });
            throw new Error(`Range 请求必须返回 206，实际为 HTTP ${response.status}`);
          }

          const contentRange = response.headers.get('content-range') || '';
          const rangeMatch = contentRange.match(/^bytes\s+(\d+)-(\d+)\/(\d+|\*)$/i);
          if (!rangeMatch) {
            throw new Error(`Content-Range 缺失或无效: ${contentRange || '(empty)'}`);
          }
          const actualStart = Number.parseInt(rangeMatch[1], 10);
          const actualEnd = Number.parseInt(rangeMatch[2], 10);
          const actualTotal = rangeMatch[3] === '*' ? -1 : Number.parseInt(rangeMatch[3], 10);
          if (actualStart !== start || actualEnd !== end || (actualTotal >= 0 && actualTotal !== totalSize)) {
            throw new Error(`Content-Range 与请求不符: expected=${start}-${end}/${totalSize} actual=${contentRange}`);
          }

          const buffer = await response.arrayBuffer();
          const expectedLength = end - start + 1;
          if (buffer.byteLength !== expectedLength) {
            throw new Error(`Range 响应字节数不符: expected=${expectedLength} actual=${buffer.byteLength}`);
          }
          const chunk = new Uint8Array(buffer);

          // 立即通过回调交给调用方写盘，不保留引用
          // 回调可能返回 Promise，await 它确保写盘完成后再释放 chunk
          if (this.onChunk) {
            await this.onChunk({
              index: chunkIndex,
              data: chunk,
              offset: start,
              length: buffer.byteLength,
            });
          }

          this.progress.downloaded += buffer.byteLength;
          this._updateSpeed();

          if (this.onProgress) {
            this.onProgress({ ...this.progress });
          }

          return;
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          lastError = err;

          // 尝试切换到 backup URL
          if (attempt === Math.floor(MAX_RETRIES / 2)) {
            this.switchToNextUrl();
          }

          if (attempt < MAX_RETRIES) {
            const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
            console.warn(`[WebGrab] 分块 ${chunkIndex} 第 ${attempt + 1} 次重试 (${delay}ms后): ${err.message}`);
            await this._sleep(delay);
          }
        }
      }
      throw new Error(`分块 ${chunkIndex} 下载失败: ${lastError?.message}`);
    };

    // 并发控制
    await this._runConcurrent(chunkCount, downloadChunk);

    return { totalSize };
  }

  /**
   * 单线程流式下载
   *
   * 每读到一段数据立即通过 onChunk 回调交给调用方写盘，不累积在内存中。
   *
   * @returns {Promise<{totalSize: number}>}
   */
  async _downloadStream() {
    let lastError = null;
    // 被截断过一次后就绕开缓存重取：截断的头号成因是缓存里存着不完整的条目，
    // 用同样的缓存策略重试只会拿回同一份坏响应。
    let bypassCache = false;

    // 每个 URL 给两次机会：第一次正常走缓存，命中截断后原地用 no-store 重取一次。
    const maxAttempts = this.urls.length * 2;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (this.signal?.aborted) throw new DOMException('下载已取消', 'AbortError');

      // 每次尝试都从头写起，进度也必须归零，否则重试会把字节数累加成假的完整长度。
      this.progress.downloaded = 0;
      this._speedStartBytes = 0;

      try {
        const response = await this._fetchWithTimeout(this.currentUrl, {
          method: 'GET',
          ...(bypassCache ? { cache: 'no-store' } : {}),
        });

        if (!response.ok) {
          throw new Error(`HTTP ${response.status}`);
        }

        // 更新总大小（如果之前探测没拿到）
        const declaredLength = Number.parseInt(response.headers.get('content-length') || '', 10);
        if (this.progress.total < 0 && Number.isFinite(declaredLength)) {
          this.progress.total = declaredLength;
        }
        // 期望长度取探测值和本次响应声明值中已知的那个；两者都知道时以本次响应为准。
        const expectedLength = Number.isFinite(declaredLength) && declaredLength >= 0
          ? declaredLength
          : this.progress.total;

        const reader = response.body.getReader();
        let offset = 0;

        while (true) {
          if (this.signal?.aborted) {
            reader.cancel();
            throw new DOMException('下载已取消', 'AbortError');
          }

          const { done, value } = await reader.read();
          if (done) break;

          if (value && value.byteLength > 0) {
            // 立即通过回调交给调用方写盘
            if (this.onChunk) {
              await this.onChunk({
                index: 0,
                data: value,
                offset: offset,
                length: value.byteLength,
              });
            }

            offset += value.byteLength;
            this.progress.downloaded += value.byteLength;
            this._updateSpeed();

            if (this.onProgress) {
              this.onProgress({ ...this.progress });
            }
          }
        }

        // 完整性校验：知道期望长度就必须对得上。
        // 读到流结束不等于文件完整——缓存或中间代理都可能给出声明了完整
        // Content-Length、body 却被截断的响应，静默接受就是把残file当成品交付。
        if (expectedLength > 0 && this.progress.downloaded !== expectedLength) {
          throw new Error(
            `响应被截断：期望 ${expectedLength} 字节，实际收到 ${this.progress.downloaded} 字节`
          );
        }

        return { totalSize: this.progress.total };
      } catch (err) {
        if (err.name === 'AbortError') throw err;
        lastError = err;

        if (attempt >= maxAttempts - 1) break;

        if (!bypassCache) {
          // 同一个 URL 再试一次，这次绕开缓存。
          bypassCache = true;
          console.warn(`[WebGrab] 流式下载重取（绕开缓存）: ${err.message}`);
        } else if (this.switchToNextUrl()) {
          // 绕开缓存也不行，换 backup URL，并恢复默认缓存策略重新来过。
          bypassCache = false;
        } else {
          break;
        }
      }
    }

    throw lastError || new Error('流式下载失败');
  }

  /**
   * 并发执行器
   * @param {number} total - 总任务数
   * @param {(index: number) => Promise<void>} task
   */
  async _runConcurrent(total, task) {
    let nextIndex = 0;
    const errors = [];

    const worker = async () => {
      while (nextIndex < total) {
        const index = nextIndex++;
        try {
          await task(index);
        } catch (err) {
          if (err.name === 'AbortError') throw err;
          errors.push({ index, error: err });
          // 单个分块失败，如果还有其他 URL，其他分块可以继续
        }
      }
    };

    // 启动 concurrency 个 worker
    const workers = [];
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(worker());
    }

    await Promise.all(workers);

    if (errors.length > 0) {
      throw new Error(`${errors.length} 个分块下载失败: ${errors[0].error.message}`);
    }
  }

  /**
   * 更新速度计算
   */
  _updateSpeed() {
    const now = Date.now();
    const elapsed = (now - this._speedStartTime) / 1000;
    if (elapsed > 0) {
      this.progress.speed = Math.round(this.progress.downloaded / elapsed);
    }

    if (this.progress.total > 0 && this.progress.speed > 0) {
      const remaining = this.progress.total - this.progress.downloaded;
      this.progress.eta = Math.ceil(remaining / this.progress.speed);
    }

    this._speedLastUpdate = now;
  }

  /**
   * 延时
   * @param {number} ms
   */
  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
