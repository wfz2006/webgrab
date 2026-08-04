/**
 * 流式写盘 —— Offscreen Document 中的文件写入器
 *
 * 三种模式：
 *   1. FileSystemWritableStream（首选）：从 popup 传来的 fileHandle，边下边写，内存恒定
 *   2. Blob 内存积累（降级）：小文件（<50MB）按 offset 存储片段，close 时排序合并
 *   3. 无文件句柄时，通知 SW 回退到 chrome.downloads.download()
 *
 * 内存约束：
 *   - FileSystemWritableStream 模式：每个分块写完即可被 GC，内存占用恒定
 *   - Blob 模式：仅在无 fileHandle 的降级场景使用，有 50MB 上限
 *   - 内部 _writeQueue 串行化所有写入操作，避免并发写入冲突
 */

/** Blob 模式的最大文件大小（50MB） */
const BLOB_MAX_SIZE = 50 * 1024 * 1024;

/**
 * 文件写入器
 * 根据是否有 fileHandle 自动选择写入模式。
 */
export class FileWriter {
  /**
   * @param {FileSystemFileHandle|null} fileHandle - 来自 showSaveFilePicker 的句柄
   * @param {string} fileName - 建议文件名（Blob 模式使用）
   */
  constructor(fileHandle, fileName) {
    this.fileHandle = fileHandle;
    this.fileName = fileName;
    /** @type {FileSystemWritableStream|null} */
    this.writable = null;
    /** @type {{offset: number, data: Uint8Array}[]} Blob 模式的片段数组（按 offset 排序合并） */
    this.blobPieces = [];
    /** @type {number} Blob 模式已积累的字节数 */
    this.blobSize = 0;
    /** @type {boolean} 是否使用 Blob 模式 */
    this.useBlob = !fileHandle;
    /** @type {boolean} 是否已关闭 */
    this.closed = false;
    /** @type {Promise<void>} 内部写入队列，串行化所有写入操作避免并发冲突 */
    this._writeQueue = Promise.resolve();
    /** @type {number} Blob 模式上限 */
    this._blobMaxSize = BLOB_MAX_SIZE;
  }

  /**
   * 打开写入流
   * 必须在写入第一个 chunk 之前调用
   *
   * 防御性校验：
   *   1. createWritable 是否为 function —— FileSystemFileHandle 经 JSON 序列化后会变成
   *      空对象 {}（truthy 但原型方法丢失），这种情况必须明确报错而不是让 TypeError 裸奔。
   *      这类错误未来可能以别的形式复现（跨上下文传递、SW 重启等），得让它自己报出病因。
   *   2. queryPermission({ mode: 'readwrite' }) —— offscreen 没有用户手势，
   *      不能调 requestPermission()，这里只能查不能求。非 'granted' 说明权限已失效
   *      （例如用户在站点权限设置中撤销了写入权限），需要让用户重新选择保存位置。
   */
  async open() {
    if (this.useBlob) {
      // Blob 模式：无需预打开
      return;
    }

    // 防御性校验：句柄非空但 createWritable 不是 function → 句柄已失效
    if (typeof this.fileHandle.createWritable !== 'function') {
      throw new Error(
        '文件句柄已失效，可能是跨上下文传递方式错误' +
        '（FileSystemFileHandle 不能过 chrome.runtime.sendMessage 的 JSON 序列化，需走 IndexedDB）'
      );
    }

    // 权限检查：offscreen 无用户手势，只能 query 不能 request
    if (typeof this.fileHandle.queryPermission === 'function') {
      const permission = await this.fileHandle.queryPermission({ mode: 'readwrite' });
      if (permission !== 'granted') {
        throw new Error(
          `文件写入权限不足（当前: ${permission}），请在弹窗中重新选择保存位置`
        );
      }
    }

    // FileSystemWritableStream 模式
    this.writable = await this.fileHandle.createWritable();
  }

  /**
   * 写入数据块
   *
   * 内部通过 _writeQueue 串行化，即使并发调用也不会冲突。
   * 分块下载时分块可能乱序完成，通过 offset 参数保证写入位置正确。
   *
   * @param {Uint8Array|ArrayBuffer} data - 数据块
   * @param {number} [offset] - 写入偏移量（分块下载时指定），不指定则追加写入
   * @returns {Promise<void>}
   */
  async write(data, offset) {
    if (this.closed) throw new Error('FileWriter 已关闭');

    // 串行化写入：把这次写入追加到队列末尾，等前面所有写入完成后再执行
    this._writeQueue = this._writeQueue.then(() => this._writeInternal(data, offset));
    return this._writeQueue;
  }

  /**
   * 实际写入逻辑（内部方法，由 write 通过队列串行调用）
   * @param {Uint8Array|ArrayBuffer} data
   * @param {number} [offset]
   * @returns {Promise<void>}
   */
  async _writeInternal(data, offset) {
    const chunk = data instanceof Uint8Array ? data : new Uint8Array(data);

    if (this.useBlob) {
      // Blob 模式：按 offset 存储，close 时按位置组装。
      // blobSize 记录的是"文件末端位置"而不是写入字节数的累加——重试重发同一段
      // 数据时（例如流式下载检测到响应被截断后绕开缓存重取），两次写入落在同一个
      // offset 上，后者覆盖前者，文件大小不该因此翻倍。
      const position = offset ?? this.blobSize;
      this.blobPieces.push({ offset: position, data: chunk });
      this.blobSize = Math.max(this.blobSize, position + chunk.byteLength);
      if (this.blobSize > this._blobMaxSize) {
        throw new Error(`Blob 模式超过 ${this._blobMaxSize / 1024 / 1024}MB 限制，需要文件句柄`);
      }
      return;
    }

    // FileSystemWritableStream 模式
    if (offset !== undefined && offset !== null) {
      // 定位写入（分块下载，可能乱序）
      await this.writable.write({ type: 'write', position: offset, data: chunk });
    } else {
      // 追加写入（流式下载）
      await this.writable.write(chunk);
    }
  }

  /**
   * 关闭写入流并完成文件保存
   *
   * 会先等待所有排队中的写入操作完成，然后：
   *   - FileSystemWritableStream 模式：close 流
   *   - Blob 模式：按 offset 排序合并片段，创建 Blob URL
   *
   * @returns {Promise<{method: 'file'|'blob', url?: string}>}
   */
  async close() {
    if (this.closed) return { method: 'file' };
    this.closed = true;

    // 等待所有 pending 写入完成
    await this._writeQueue;

    if (this.useBlob) {
      // Blob 模式：按 offset 定位组装，语义与文件句柄模式的定位写入保持一致——
      // 后写入的片段覆盖同一位置上先写入的内容。单纯按顺序拼接的话，重试重发的
      // 那一段会被当成新内容追加进去，拼出一个比真实文件更长的坏文件。
      const merged = new Uint8Array(this.blobSize);
      for (const piece of this.blobPieces) {
        merged.set(piece.data, piece.offset);
      }
      const blob = new Blob([merged], { type: 'application/octet-stream' });
      const url = URL.createObjectURL(blob);
      this.blobPieces = []; // 释放内存
      this.blobSize = 0;
      return { method: 'blob', url };
    }

    // FileSystemWritableStream 模式
    if (this.writable) {
      await this.writable.close();
      this.writable = null;
    }
    return { method: 'file' };
  }

  /**
   * 取消写入，丢弃已写入的数据
   */
  async abort() {
    this.closed = true;

    // 等待 pending 写入完成（忽略错误）
    try {
      await this._writeQueue;
    } catch {
      // 忽略排队中的写入错误
    }

    if (this.useBlob) {
      this.blobPieces = [];
      this.blobSize = 0;
      return;
    }

    if (this.writable) {
      try {
        await this.writable.abort();
      } catch {
        // abort 失败不影响后续逻辑
      }
      this.writable = null;
    }
  }

  /**
   * 是否使用 Blob 模式
   * @returns {boolean}
   */
  isBlobMode() {
    return this.useBlob;
  }
}
