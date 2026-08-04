/**
 * ffmpeg.wasm 兜底路径 —— Offscreen Document 中使用
 *
 * 适用场景：
 *   - TS 分片转 MP4
 *   - AV1/Dolby Vision 等需要转码的编码
 *   - 快路径（mp4box）失败的异常情况
 *
 * 关键约束：
 *   - 核心文件本地打包（lib/ffmpeg/），不从 CDN 加载
 *     （MV3 禁止运行时从远程服务器拉取并执行代码，CSP 也不允许）
 *   - 需要 SharedArrayBuffer，在 manifest.json 中声明 COOP/COEP
 *   - 命令优先用 -c copy（仅重封装），只有编码不兼容时才真转码
 *   - 转码进度要能上报到 UI（ffmpeg.wasm 的 progress 回调）
 *
 * 加载策略：
 *   1. 首次使用时从扩展本地加载 ffmpeg.wasm 核心文件（已打包在 lib/ffmpeg/）
 *   2. 加载后缓存在内存中，后续复用
 *   3. 加载失败时抛出明确错误
 */

/**
 * ffmpeg.wasm 本地资源 URL
 *
 * 核心文件已打包在 lib/ffmpeg/ 目录，通过 chrome.runtime.getURL
 * 获取扩展内绝对路径，避免任何对外网络请求（MV3 远程代码政策要求）。
 */
const FFMPEG_MODULE_URL = chrome.runtime.getURL('lib/ffmpeg/index.js');
const FFMPEG_CORE_JS_URL = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.js');
const FFMPEG_CORE_WASM_URL = chrome.runtime.getURL('lib/ffmpeg/ffmpeg-core.wasm');

/** @type {Object|null} ffmpeg 实例缓存 */
let ffmpegInstance = null;
/** @type {Promise|null} 加载中的 Promise（避免重复加载） */
let loadingPromise = null;

/**
 * @typedef {Object} TranscodeParams
 * @property {Array<{name: string, data: Uint8Array}>} inputs - 输入文件列表
 * @property {string} outputName - 输出文件名（如 "output.mp4"）
 * @property {string} outputFormat - 输出格式（如 "mp4"）
 * @property {boolean} [copyOnly] - 是否仅重封装（-c copy），true 时编码不兼容会失败
 * @property {AbortSignal} [signal] - 取消信号
 */

/**
 * @typedef {Object} TranscodeResult
 * @property {Uint8Array} data - 输出文件数据
 * @property {string} method - "ffmpeg"
 * @property {number} duration - 输出时长（秒，可能为 0）
 */

/**
 * 动态加载 ffmpeg.wasm
 *
 * ffmpeg.wasm 是 ESM 模块，需要用动态 import 加载。
 * 核心文件（ffmpeg-core.js + ffmpeg-core.wasm）较大（~25MB），
 * 首次加载需要几秒到几十秒，加载后会缓存。
 *
 * @returns {Promise<Object>} ffmpeg 实例
 */
async function loadFfmpeg() {
  if (ffmpegInstance) return ffmpegInstance;
  if (loadingPromise) return loadingPromise;

  loadingPromise = (async () => {
    console.log('[WebGrab] 开始加载 ffmpeg.wasm（本地）...');

    // 检查 SharedArrayBuffer 是否可用（COOP/COEP 要求）
    if (typeof SharedArrayBuffer === 'undefined') {
      throw new Error(
        'SharedArrayBuffer 不可用。请在 manifest.json 中配置 cross_origin_embedder_policy 和 cross_origin_opener_policy。'
      );
    }

    // 从扩展本地加载 ffmpeg.wasm ESM 模块（MV3 禁止远程代码）
    const { FFmpeg } = await import(/* webpackIgnore: true */ FFMPEG_MODULE_URL);

    const ffmpeg = new FFmpeg();

    // 监听日志（调试用）
    ffmpeg.on('log', ({ message }) => {
      console.log('[ffmpeg]', message);
    });

    // 加载核心（本地打包，无网络请求）
    console.log('[WebGrab] 加载 ffmpeg-core.wasm (~25MB, 本地)...');
    await ffmpeg.load({
      coreURL: FFMPEG_CORE_JS_URL,
      wasmURL: FFMPEG_CORE_WASM_URL,
    });

    console.log('[WebGrab] ffmpeg.wasm 加载完成');
    ffmpegInstance = ffmpeg;
    return ffmpeg;
  })();

  try {
    return await loadingPromise;
  } catch (err) {
    // 加载失败，清除 promise 允许重试
    loadingPromise = null;
    throw err;
  }
}

/**
 * 使用 ffmpeg.wasm 转码/重封装
 *
 * 命令优先用 -c copy（仅重封装，秒级完成），
 * 只有编码不兼容时才真转码（耗时较长）。
 *
 * @param {TranscodeParams} params
 * @param {(progress: number) => void} [onProgress] - 进度回调（0-1）
 * @returns {Promise<TranscodeResult>}
 */
export async function transcodeWithFfmpeg(params, onProgress) {
  const ffmpeg = await loadFfmpeg();

  // 写入输入文件
  for (const input of params.inputs) {
    await ffmpeg.writeFile(input.name, input.data);
  }

  // 构建命令参数
  const args = [];

  // 输入文件
  for (const input of params.inputs) {
    args.push('-i', input.name);
  }

  // 输出编码：优先 -c copy
  if (params.copyOnly !== false) {
    args.push('-c', 'copy');
  }

  // 处理多个输入（如 video + audio 合并）
  if (params.inputs.length > 1) {
    args.push('-map', '0:v', '-map', '1:a');
  }

  // 输出格式
  args.push('-f', params.outputFormat);

  // 进度回调
  const progressHandler = ({ progress }) => {
    if (onProgress && progress >= 0 && progress <= 1) {
      onProgress(progress);
    }
  };
  ffmpeg.on('progress', progressHandler);

  try {
    // 执行转码
    args.push(params.outputName);
    await ffmpeg.exec(args);

    // 读取输出文件
    const data = await ffmpeg.readFile(params.outputName);

    // 清理临时文件
    for (const input of params.inputs) {
      try {
        await ffmpeg.deleteFile(input.name);
      } catch {}
    }
    try {
      await ffmpeg.deleteFile(params.outputName);
    } catch {}

    return {
      data: new Uint8Array(data),
      method: 'ffmpeg',
      duration: 0, // ffmpeg 不直接返回时长，由调用方估算
    };
  } finally {
    ffmpeg.off('progress', progressHandler);
  }
}

/**
 * 预加载 ffmpeg.wasm（可选，用于提前加载减少首次等待）
 */
export async function preloadFfmpeg() {
  try {
    await loadFfmpeg();
  } catch (err) {
    console.warn('[WebGrab] ffmpeg 预加载失败:', err);
  }
}

/**
 * 检查 ffmpeg.wasm 是否可用（SharedArrayBuffer 是否存在）
 * @returns {boolean}
 */
export function isFfmpegAvailable() {
  return typeof SharedArrayBuffer !== 'undefined';
}

/**
 * 检查 ffmpeg.wasm 是否已加载
 * @returns {boolean}
 */
export function isFfmpegLoaded() {
  return ffmpegInstance !== null;
}

/**
 * 合并 TS 分片为 MP4（ffmpeg 兜底路径的典型用法）
 *
 * TS 分片无法用 mp4box 快路径处理，必须用 ffmpeg 重封装。
 * 这里的策略是：
 *   1. 把所有 TS 分片拼接成一个大文件
 *   2. 用 ffmpeg -c copy 重封装为 MP4
 *
 * @param {Uint8Array[]} segments - TS 分片数组
 * @param {Object} writer - FileWriter 实例
 * @param {(progress: number) => void} [onProgress]
 * @returns {Promise<TranscodeResult>}
 */
export async function mergeTsToMp4(segments, writer, onProgress) {
  // 拼接所有分片为一个 TS 文件
  const totalLength = segments.reduce((sum, seg) => sum + seg.length, 0);
  const tsData = new Uint8Array(totalLength);
  let offset = 0;
  for (const seg of segments) {
    tsData.set(seg, offset);
    offset += seg.length;
  }

  // 用 ffmpeg 重封装
  const result = await transcodeWithFfmpeg({
    inputs: [{ name: 'input.ts', data: tsData }],
    outputName: 'output.mp4',
    outputFormat: 'mp4',
    copyOnly: true,
  });

  // 流式写入 writer
  const CHUNK_SIZE = 1024 * 1024;
  const data = result.data;
  offset = 0;
  while (offset < data.length) {
    const end = Math.min(offset + CHUNK_SIZE, data.length);
    const chunk = data.slice(offset, end);
    await writer.write(chunk, offset);
    offset = end;
  }

  return result;
}
