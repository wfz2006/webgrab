function getFflate() {
  const api = globalThis.fflate;
  if (!api?.Zip || !api?.ZipPassThrough || !api?.ZipDeflate) {
    throw new Error('fflate 未加载，无法创建压缩包');
  }
  return api;
}

function toBytes(data) {
  if (data instanceof Uint8Array) return data;
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) {
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  }
  return new TextEncoder().encode(String(data ?? ''));
}

export class StreamingZipWriter {
  constructor(fileHandle) {
    this.fileHandle = fileHandle;
    this.writable = null;
    this.zip = null;
    this.writeChain = Promise.resolve();
    this.outputError = null;
    this.closed = false;
  }

  async open() {
    if (!this.fileHandle?.createWritable) {
      throw new Error('流式打包需要有效的文件句柄，请重新选择保存位置');
    }
    this.writable = await this.fileHandle.createWritable();
    const { Zip } = getFflate();
    this.zip = new Zip((error, chunk) => {
      if (error) {
        this.outputError = error;
        return;
      }
      if (!chunk?.length) return;
      this.writeChain = this.writeChain.then(() => this.writable.write(chunk));
      this.writeChain.catch((writeError) => { this.outputError = writeError; });
    });
  }

  async _add(name, data, compress) {
    if (!this.zip || !this.writable || this.closed) throw new Error('压缩包尚未打开或已经关闭');
    if (this.outputError) throw this.outputError;
    const { ZipPassThrough, ZipDeflate } = getFflate();
    const entry = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name);
    this.zip.add(entry);
    entry.push(toBytes(data), true);
    await this.writeChain;
    if (this.outputError) throw this.outputError;
  }

  addStored(name, data) {
    return this._add(name, data, false);
  }

  addDeflated(name, data) {
    return this._add(name, data, true);
  }

  async close() {
    if (this.closed) return;
    this.closed = true;
    this.zip.end();
    await this.writeChain;
    if (this.outputError) throw this.outputError;
    await this.writable.close();
    this.zip = null;
    this.writable = null;
  }

  async abort(reason) {
    if (this.closed && !this.writable) return;
    this.closed = true;
    try {
      if (this.zip) this.zip.terminate();
    } catch {}
    try {
      await this.writable?.abort?.(reason);
    } finally {
      this.zip = null;
      this.writable = null;
    }
  }
}
