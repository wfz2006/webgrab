/**
 * 任务队列 —— Offscreen Document 中的下载任务管理
 *
 * 状态机：pending → downloading → writing → done / failed / canceled
 * 全局同时下载任务数默认 2
 * 任务状态变化实时同步到 SW
 * 通过 chrome.runtime.sendMessage 与 SW 通信
 *
 * 支持两种任务类型：
 *   1. 直接下载（普通文件）：HttpFetcher 分块下载 → FileWriter 写盘
 *   2. 流媒体下载（HLS/DASH）：parser 解析 → SegmentFetcher 分片下载 → Remuxer/ffmpeg 合并 → FileWriter 写盘
 */

import { HttpFetcher } from './http-fetcher.js';
import { FileWriter } from './writer.js';
import { parseMasterPlaylist, parseMediaPlaylist } from './hls-parser.js';
import { parseMpd } from './dash-parser.js';
import { SegmentFetcher } from './segment-fetcher.js';
import { concatFmp4Stream, remuxMultiTrackMp4, canFastPath, createInputProcessor, createBatchedSampleWriter, loadMp4box, finalizeMp4Metadata } from './remuxer.js';
import { transcodeWithFfmpeg, mergeTsToMp4, isFfmpegAvailable } from './ffmpeg-fallback.js';
import { parseSegmentBaseInitSize, buildFileName } from '../lib/filename.js';
import { getHandle, deleteHandle } from '../lib/handle-store.js';
import { resolveFilePath } from '../lib/file-system-path.js';
import { DEFAULT_DOWNLOAD_SETTINGS, loadDownloadSettings, watchDownloadSettings } from '../lib/download-settings.js';
import { runBoundedConcurrent } from '../lib/bounded-concurrency.js';
import { isAdaptiveStreamResource } from '../lib/media-output.js';
import { verifyAndLog as verifyRemux } from './verify-remux.js';
import { packageComic } from './comic-packager.js';
import { packageEpub } from './epub-packager.js';
import {
  discardPreparedNovel,
  executeNovelTask,
  getNovelBook,
  markNovelTaskCanceled,
  prepareNovelExtraction,
} from './novel-worker.js';

/** 最大同时下载任务数 */
const MAX_CONCURRENT_TASKS = 2;

// 分片/分块并发数、单文件重试次数：可在设置页配置，默认值与改造前硬编码行为一致。
let downloadSettings = DEFAULT_DOWNLOAD_SETTINGS;
loadDownloadSettings().then((settings) => { downloadSettings = settings; }).catch(() => {});
watchDownloadSettings((settings) => { downloadSettings = settings; });

/** 任务状态枚举 */
const TaskStatus = {
  PENDING: 'pending',
  DOWNLOADING: 'downloading',
  WRITING: 'writing',
  DONE: 'done',
  FAILED: 'failed',
  CANCELED: 'canceled',
  PACKING: 'packing',
};

/**
 * @typedef {Object} DownloadTask
 * @property {string} id
 * @property {string} url
 * @property {string[]} [backupUrls]
 * @property {string} fileName
 * @property {string} kind
 * @property {number} size
 * @property {string|null} fileHandleKey - IndexedDB 中的句柄 key（跨上下文传递用）
 * @property {Object} [headers] - DNR 已注入的请求头（非 DNR 场景的额外头）
 * @property {string} status
 * @property {number} downloaded
 * @property {number} total
 * @property {number} speed
 * @property {number} eta
 * @property {string|null} error
 * @property {number} createdAt
 * @property {number} completedAt
 * @property {Array<Object>} [diagnostics] - 批量下载失败诊断（最多 20 条）
 * @property {AbortController|null} _abortController - 内部使用
 *
 * 流媒体专用字段：
 * @property {string} [streamType] - "hls" | "dash" | null（普通下载为 null）
 * @property {Object} [streamMeta] - 流媒体元数据（variant 信息等）
 * @property {number} [segmentTotal] - 总分片数
 * @property {number} [segmentCompleted] - 已完成分片数
 */

/** @type {Map<string, DownloadTask>} */
const tasks = new Map();

/** @type {string[]} 待执行的任务队列 */
const pendingQueue = [];

/** 当前正在执行的任务数 */
let activeCount = 0;

// ─── 消息监听 ──────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 只处理明确发给 offscreen 的消息。不能抢答没有 target 的 popup → SW
  // 消息，否则多个监听器竞态时 popup 可能先收到 {data:null}。
  if (message.target !== 'offscreen') return;

  handleMessage(message)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => {
      console.error('[WebGrab/Offscreen] 消息处理错误:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // 异步响应
});

/**
 * 处理来自 SW 的消息
 * @param {any} message
 */
async function handleMessage(message) {
  switch (message.type) {
    case 'EXECUTE_TASK': {
      const task = createTask(message.task);
      pendingQueue.push(task.id);
      tasks.set(task.id, task);
      processQueue();
      return { taskId: task.id };
    }

    case 'CANCEL_TASK': {
      const task = tasks.get(message.taskId);
      if (task) {
        await cancelTask(task);
      }
      return { ok: true };
    }

    case 'GET_OFFSCREEN_TASKS': {
      const result = [];
      for (const task of tasks.values()) {
        result.push(stripInternal(task));
      }
      return { tasks: result };
    }

    case 'NOVEL_PREPARE':
      return prepareNovelExtraction(message.input || {});

    case 'NOVEL_DISCARD_PREPARED':
      return discardPreparedNovel(message.bookId);

    case 'NOVEL_GET_BOOK':
      return getNovelBook(message.bookId, Boolean(message.includeChapters));

    case 'PING': {
      return { ok: true, pong: true };
    }

    default:
      return null;
  }
}

/**
 * 创建任务对象
 * @param {any} data
 * @returns {DownloadTask}
 */
function createTask(data) {
  return {
    id: data.id,
    url: data.url,
    backupUrls: data.backupUrls || [],
    fileName: data.fileName || 'download',
    kind: data.kind || 'video',
    size: data.size || -1,
    fileHandleKey: data.fileHandleKey || null,
    headers: data.headers || {},
    status: TaskStatus.PENDING,
    downloaded: 0,
    total: data.size || -1,
    speed: 0,
    eta: -1,
    error: null,
    successCount: data.successCount || 0,
    failureCount: data.failureCount || 0,
    diagnostics: data.diagnostics || [],
    createdAt: Date.now(),
    completedAt: null,
    _abortController: null,
    // 流媒体专用字段
    streamType: data.streamType || null,
    streamMeta: data.streamMeta || null,
    conflictStrategy: data.conflictStrategy || 'uniquify',
    segmentTotal: 0,
    segmentCompleted: 0,
  };
}

// ─── 队列处理 ──────────────────────────────────────────────

/**
 * 处理待执行队列
 */
function processQueue() {
  while (activeCount < MAX_CONCURRENT_TASKS && pendingQueue.length > 0) {
    const taskId = pendingQueue.shift();
    const task = tasks.get(taskId);
    if (task && task.status === TaskStatus.PENDING) {
      activeCount++;
      executeTask(task).catch((err) => {
        console.error(`[WebGrab/Offscreen] 任务执行异常: ${taskId}`, err);
      });
    }
  }
}

/**
 * 执行单个下载任务
 *
 * 根据 task.streamType / task.streamMeta.kind 分派到不同的执行路径：
 *   - streamMeta.kind === 'bilibili'：B 站 DASH 单 URL 流式合并（HttpFetcher + mp4box）
 *   - "hls"：HLS 流媒体（hls-parser + SegmentFetcher + Remuxer + FileWriter）
 *   - "dash"：DASH 流媒体（dash-parser + SegmentFetcher + Remuxer + FileWriter）
 *   - null/undefined：普通文件下载（HttpFetcher + FileWriter）
 *
 * @param {DownloadTask} task
 */
async function executeTask(task) {
  if (task.streamMeta && (task.streamMeta.kind === 'comic-package' || task.streamMeta.kind === 'epub-package')) {
    return executePackageTask(task);
  }
  if (task.streamMeta && task.streamMeta.kind === 'novel') {
    return executeNovelQueueTask(task);
  }
  if (task.streamMeta && task.streamMeta.kind === 'batch') {
    return executeBatchTask(task);
  }
  if (task.streamMeta && task.streamMeta.kind === 'bilibili') {
    return executeBilibiliTask(task);
  }
  if (task.streamType === 'hls' || task.streamType === 'dash') {
    return executeStreamTask(task);
  }
  return executeDirectTask(task);
}

/**
 * P4-2 可阅读成品打包。正文和图片大对象只在 offscreen 内部流动，SW 只收到
 * 轻量计数。取消时若已有有效条目，packager 会先封口生成可打开的部分成品。
 * @param {DownloadTask} task
 */
async function executePackageTask(task) {
  task.status = TaskStatus.PACKING;
  task._abortController = new AbortController();
  reportStatus(task);
  const meta = task.streamMeta || {};
  let handleKey = task.fileHandleKey || meta.dirHandleKey || null;

  const onProgress = (progress) => {
    task.downloaded = progress.completed || 0;
    task.total = progress.total || task.total;
    task.successCount = progress.successCount || 0;
    task.failureCount = progress.failureCount || 0;
    task.currentTitle = progress.currentTitle || '';
    reportStatus(task);
  };

  try {
    const handle = handleKey ? await getHandle(handleKey) : null;
    let result;
    if (meta.kind === 'comic-package') {
      result = await packageComic({
        resources: meta.resources || [],
        mode: meta.mode,
        directoryHandle: handle,
        title: meta.title,
        source: meta.source,
        organizedPath: meta.organizedPath,
        conflictStrategy: meta.conflictStrategy,
        concurrency: downloadSettings.segmentConcurrency,
        signal: task._abortController.signal,
        onProgress,
      });
    } else {
      result = await packageEpub({
        bookId: meta.bookId,
        fileHandle: handle,
        signal: task._abortController.signal,
        onProgress,
      });
    }

    task.successCount = result.successCount;
    task.failureCount = result.failureCount;
    task.downloaded = result.successCount + result.failureCount;
    task.total = result.total;
    task.diagnostics = result.failures || [];
    task.status = result.canceled || task._abortController.signal.aborted
      ? TaskStatus.CANCELED
      : TaskStatus.DONE;
    task.error = result.failureCount > 0
      ? `${result.failureCount} 个${meta.kind === 'epub-package' ? '章节' : '文件'}缺失，成品已保留其余内容`
      : null;
    task.completedAt = Date.now();
    reportStatus(task);
  } catch (error) {
    task.status = error?.name === 'AbortError' || task._abortController.signal.aborted
      ? TaskStatus.CANCELED
      : TaskStatus.FAILED;
    task.error = error?.message || String(error);
    task.completedAt = Date.now();
    reportStatus(task);
  } finally {
    task._abortController = null;
    activeCount--;
    if (handleKey) deleteHandle(handleKey).catch(() => {});
    task.fileHandleKey = null;
    processQueue();
  }
}

/**
 * 小说任务复用队列生命周期，但内部并发固定为 1，且不经过媒体写盘逻辑。
 * 全局只允许一个小说任务由 SW 侧锁保证。
 * @param {DownloadTask} task
 */
async function executeNovelQueueTask(task) {
  try {
    await executeNovelTask(task, { report: reportStatus });
  } catch (err) {
    task.status = 'failed';
    task.error = err?.message || String(err);
    task.completedAt = Date.now();
    reportStatus(task);
  } finally {
    task._abortController = null;
    activeCount--;
    processQueue();
  }
}

/**
 * 执行普通文件下载任务
 *
 * 流水线化：每下完一块/一段立即通过 onChunk 回调交给 FileWriter 写盘，
 * 不在内存中累积所有数据。WRITING 状态仅表示等待 writer.close() 刷盘完成。
 *
 * @param {DownloadTask} task
 */
async function executeDirectTask(task) {
  task.status = TaskStatus.DOWNLOADING;
  task._abortController = new AbortController();
  reportStatus(task);

  /** @type {FileWriter|null} */
  let writer = null;

  try {
    // 构建 URL 列表（主 URL + backup）
    const urls = [task.url, ...task.backupUrls].filter(Boolean);

    // 创建 HTTP 下载器
    const fetcher = new HttpFetcher(urls, {
      concurrency: downloadSettings.segmentConcurrency,
      headers: task.headers,
      signal: task._abortController.signal,
    });

    // 创建文件写入器（提前打开，确保第一个 chunk 到达时就能写）
    // 从 IndexedDB 取出 FileSystemFileHandle（不能过 JSON 序列化，必须走 IDB）
    const fileHandle = task.fileHandleKey ? await getHandle(task.fileHandleKey) : null;
    writer = new FileWriter(fileHandle, task.fileName);
    await writer.open();

    // 进度回调
    const onProgress = (info) => {
      task.downloaded = info.downloaded;
      task.total = info.total;
      task.speed = info.speed;
      task.eta = info.eta;
      reportStatus(task);
    };

    // 分块回调：每下完一块立即写盘（流水线核心）
    // writer.write 内部通过 _writeQueue 串行化，即使并发分块同时完成也不会冲突
    const onChunk = async (chunkInfo) => {
      await writer.write(chunkInfo.data, chunkInfo.offset);
      // 写完后 chunk 引用自然释放，不保留在内存中
    };

    // 开始下载（边下边写）
    await fetcher.download(onProgress, onChunk);

    // 写盘收尾：等待所有排队写入完成并关闭文件
    task.status = TaskStatus.WRITING;
    reportStatus(task);

    const closeResult = await writer.close();
    writer = null; // 防止 finally 中重复 abort

    // Blob 模式：通知 SW 下载 blob。
    // 这是降级路径唯一的落盘动作，SW 那边失败了就必须把任务判失败——
    // 否则用户看到"已完成"，磁盘上却什么都没有。
    if (closeResult.method === 'blob' && closeResult.url) {
      const blobResponse = await chrome.runtime.sendMessage({
        type: 'BLOB_DOWNLOAD',
        target: 'sw',
        taskId: task.id,
        url: closeResult.url,
        fileName: task.fileName,
        conflictStrategy: task.conflictStrategy,
      });
      if (!blobResponse?.ok) {
        throw new Error(blobResponse?.error || 'Blob 保存失败');
      }
    }

    // 完成
    task.status = TaskStatus.DONE;
    task.downloaded = task.total > 0 ? task.total : task.downloaded;
    task.speed = 0;
    task.eta = 0;
    task.completedAt = Date.now();
    reportStatus(task);

  } catch (err) {
    if (err.name === 'AbortError' || task.status === TaskStatus.CANCELED) {
      task.status = TaskStatus.CANCELED;
    } else {
      task.status = TaskStatus.FAILED;
      task.error = err.message || String(err);
      console.error(`[WebGrab/Offscreen] 任务失败: ${task.id}`, err);
    }
    task.completedAt = Date.now();
    reportStatus(task);

    // 清理未完成的写入
    if (writer) {
      try {
        await writer.abort();
      } catch {
        // 忽略 abort 错误
      }
    }
  } finally {
    task._abortController = null;
    activeCount--;
    // 任务进入终态（done/failed/canceled），清理 IndexedDB 中的句柄
    if (task.fileHandleKey) {
      deleteHandle(task.fileHandleKey).catch(() => {});
      task.fileHandleKey = null;
    }
    processQueue();
  }
}

/** 批量任务最多持久化的失败诊断数，避免 chrome.storage.local 膨胀 */
const MAX_BATCH_DIAGNOSTICS = 20;

/**
 * 追加一条批量下载诊断。
 * @param {DownloadTask} task
 * @param {{url: string, fileName: string, stage: 'fetch'|'write'|'fallback', error: any, httpStatus?: number|null}} detail
 */
function recordBatchDiagnostic(task, detail) {
  task.diagnostics = task.diagnostics || [];
  if (task.diagnostics.length >= MAX_BATCH_DIAGNOSTICS) return;

  const err = detail.error;
  task.diagnostics.push({
    url: detail.url,
    fileName: detail.fileName,
    stage: detail.stage,
    errName: err?.name || 'Error',
    errMessage: err?.message || String(err),
    httpStatus: Number.isFinite(detail.httpStatus) ? detail.httpStatus : null,
  });
}

/**
 * 执行批量下载任务
 *
 * 用户在资源列表中多选资源后一次性下载到指定目录。
 * 目录句柄（FileSystemDirectoryHandle）通过 IndexedDB 传入，
 * 每个文件用 dirHandle.getFileHandle(name, {create:true}) + createWritable() 写入。
 *
 * 并发策略：复用设置中的 segmentConcurrency，通过共享游标执行有界并发。
 * 文件名的“查重 + 创建句柄”单独串行，避免同名资源并发覆盖。
 * 单个文件失败不影响其他文件，最终汇总报告失败数。
 *
 * @param {DownloadTask} task
 */
async function executeBatchTask(task) {
  task.status = TaskStatus.DOWNLOADING;
  task._abortController = new AbortController();
  reportStatus(task);

  const signal = task._abortController.signal;
  /** @type {Array<Object>} */
  const resources = (task.streamMeta && task.streamMeta.resources) || [];
  const dirHandleKey = task.streamMeta && task.streamMeta.dirHandleKey;

  let dirHandle = null;
  let successCount = 0;
  let failCount = 0;
  /** 通过 chrome.downloads.download() 备用路径下载的文件数（不进选定目录） */
  let fallbackCount = 0;
  /** @type {Array<{url: string, filename: string, error: string}>} 失败详情 */
  const failures = [];
  // resolveFilePath 内部会先检查再 create:true；这段必须保持串行，网络和写盘无需等待。
  let filePathGate = Promise.resolve();
  const resolveBatchFilePath = (fileName, conflictStrategy) => {
    const operation = filePathGate.then(() => resolveFilePath(dirHandle, fileName, conflictStrategy));
    filePathGate = operation.catch(() => {});
    return operation;
  };

  try {
    if (!dirHandleKey) {
      throw new Error('批量下载缺少目录句柄');
    }
    dirHandle = await getHandle(dirHandleKey);
    if (!dirHandle) {
      throw new Error('目录句柄已失效，请重新选择目录');
    }

    task.total = resources.length;
    task.downloaded = 0;
    reportStatus(task);

    const processResource = async (i) => {
      if (signal.aborted) return;
      const res = resources[i];
      let fileName = res.organizedPath || buildFileName(res.url, res.title, res.ext);
      const conflictStrategy = res.conflictStrategy || task.conflictStrategy || 'uniquify';

      // An HLS/DASH manifest is only a playlist. Writing its response bytes to an
      // .mp4 file produces a tiny, corrupt-looking file beginning with #EXTM3U.
      // The popup normally partitions these into dedicated stream tasks; retain
      // this guard so future callers cannot silently create a false-success file.
      if (isAdaptiveStreamResource(res)) {
        const error = new Error('Adaptive manifest must be dispatched through the stream merger');
        recordBatchDiagnostic(task, {
          url: res.url,
          fileName,
          stage: 'dispatch',
          error,
          httpStatus: null,
        });
        failCount++;
        failures.push({ url: res.url, filename: fileName, error: error.message });
        task.downloaded = successCount + fallbackCount;
        reportStatus(task);
        return;
      }

      let response = null;
      let data = null;
      let primaryError = null;

      // fetch 与写盘分开捕获，确保 diagnostics 能准确区分网络层和文件系统错误。
      // 瞬时网络错误按设置的次数重试；只在最终仍失败时记一条诊断，避免刷屏。
      for (let attempt = 0; attempt <= downloadSettings.retryCount; attempt++) {
        try {
          response = await fetch(res.url, { signal });
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          data = new Uint8Array(await response.arrayBuffer());
          primaryError = null;
          break;
        } catch (err) {
          if (err.name === 'AbortError') { primaryError = err; break; }
          primaryError = err;
        }
      }
      if (primaryError) {
        if (primaryError.name === 'AbortError' || signal.aborted) return;
        recordBatchDiagnostic(task, {
          url: res.url,
          fileName,
          stage: 'fetch',
          error: primaryError,
          httpStatus: response?.status ?? null,
        });
      }

      if (!primaryError) {
        try {
          const resolved = await resolveBatchFilePath(fileName, conflictStrategy);
          if (resolved.skipped) {
            successCount++;
            task.skippedCount = (task.skippedCount || 0) + 1;
            task.downloaded = successCount + fallbackCount;
            reportStatus(task);
            return;
          }
          const fileHandle = resolved.fileHandle;
          fileName = resolved.relativePath;
          const writable = await fileHandle.createWritable();
          await writable.write(data);
          await writable.close();

          // resolveBatchFilePath 已在互斥区内完成查重并创建句柄；实际字节写入可并发。
          successCount++;
        } catch (err) {
          if (err.name === 'AbortError') return;
          primaryError = err;
          recordBatchDiagnostic(task, {
            url: res.url,
            fileName,
            stage: 'write',
            error: err,
            httpStatus: response?.status ?? null,
          });
        }
      }

      if (primaryError) {
        if (signal.aborted) return;
        // 主路径失败 → 保持现有行为，回退到 chrome.downloads.download()
        // chrome.downloads.download() 是浏览器原生 API，不受 COEP 限制
        // 回退文件不进选定目录，存到默认下载目录的 WebGrab_Batch/ 子文件夹
        console.warn(`[WebGrab/Offscreen] 主路径失败，尝试备用下载: ${res.url}`, primaryError);
        try {
          const fallbackResult = await chrome.runtime.sendMessage({
            type: 'BATCH_FALLBACK_DOWNLOAD',
            url: res.url,
            filename: fileName,
            organizedPath: res.organizedPath || fileName,
            conflictStrategy,
          });
          if (fallbackResult && fallbackResult.ok) {
            fallbackCount++;
          } else {
            throw new Error(fallbackResult?.error || '备用下载失败');
          }
        } catch (fallbackErr) {
          if (fallbackErr.name === 'AbortError') return;
          recordBatchDiagnostic(task, {
            url: res.url,
            fileName,
            stage: 'fallback',
            error: fallbackErr,
            httpStatus: null,
          });
          console.error(`[WebGrab/Offscreen] 批量下载失败: ${res.url}`, fallbackErr);
          failCount++;
          failures.push({ url: res.url, filename: fileName, error: fallbackErr.message });
        }
      }

      // 完成数字 = 实际落盘文件数（成功写入目录 + 备用下载），不含失败
      task.downloaded = successCount + fallbackCount;
      task.speed = 0;
      reportStatus(task);
    };

    await runBoundedConcurrent(
      resources.length,
      downloadSettings.segmentConcurrency,
      processResource,
      signal
    );

    // 设置终态和错误信息
    if (signal.aborted) {
      task.status = TaskStatus.CANCELED;
    } else if (failCount === 0 && fallbackCount === 0) {
      task.status = TaskStatus.DONE;
    } else if (failCount === 0 && fallbackCount > 0) {
      // 全部成功，但部分走了备用路径
      task.status = TaskStatus.DONE;
      task.error = `${fallbackCount} 个文件通过备用下载保存到默认下载目录（WebGrab_Batch/）`;
    } else if (successCount + fallbackCount > 0) {
      // 部分成功
      task.status = TaskStatus.DONE;
      const parts = [`${failCount} 个文件下载失败`];
      if (fallbackCount > 0) {
        parts.push(`${fallbackCount} 个通过备用下载保存到默认下载目录`);
      }
      task.error = parts.join('，');
    } else {
      task.status = TaskStatus.FAILED;
      task.error = `全部 ${failCount} 个文件下载失败`;
    }
    task.completedAt = Date.now();
    reportStatus(task);

  } catch (err) {
    if (err.name === 'AbortError' || task.status === TaskStatus.CANCELED) {
      task.status = TaskStatus.CANCELED;
    } else {
      task.status = TaskStatus.FAILED;
      task.error = err.message || String(err);
      console.error('[WebGrab/Offscreen] 批量下载任务失败:', err);
    }
    task.completedAt = Date.now();
    reportStatus(task);
  } finally {
    task._abortController = null;
    activeCount--;
    // 清理目录句柄
    if (dirHandleKey) {
      deleteHandle(dirHandleKey).catch(() => {});
    }
    processQueue();
  }
}

/**
 * 执行流媒体下载任务（HLS / DASH）
 *
 * 三条路径（按内存友好程度排序）：
 *
 *   1. concat（fMP4 单轨道直接拼接，最快路径）：
 *      - 适用：HLS fMP4 单轨道、DASH 单轨道
 *      - init segment 写一次，后续每个 fragment 到达立即写盘并释放引用
 *      - 真正的流式：下载与写盘流水线化，内存占用恒定在单个 fragment 大小
 *
 *   2. mp4box（fMP4 多轨道合并）：
 *      - 适用：DASH video+audio 分离的 fMP4
 *      - 需要用 mp4box 把两条独立轨道的 samples 交织进同一容器
 *      - mp4box.js 的 addSample/write API 非流式，需收集所有 samples 后一次性写出
 *      - 这是 mp4box.js 的固有限制，仅用于多轨道场景（单轨道走 concat 不经过 mp4box）
 *
 *   3. ffmpeg（兜底）：
 *      - 适用：TS 分片、AV1/Dolby/VP9 等不支持的 codec
 *      - ffmpeg.wasm 需要完整输入文件，必须收集所有分片
 *      - 这是 ffmpeg.wasm 的固有限制（验收标准第 5 条只针对快路径要求内存不爆）
 *
 * 内存约束（验收标准第 4、5 条）：
 *   - concat 路径：分片到达即写盘，内存恒定 ✓
 *   - mp4box 路径：收集 samples（mp4box 固有限制，可接受）
 *   - ffmpeg 路径：收集完整文件（ffmpeg 固有限制，验收标准豁免）
 *
 * @param {DownloadTask} task
 */
async function executeStreamTask(task) {
  task.status = TaskStatus.DOWNLOADING;
  task._abortController = new AbortController();
  reportStatus(task);

  /** @type {FileWriter|null} */
  let writer = null;
  /** @type {SegmentFetcher|null} */
  let fetcher = null;

  try {
    // ── 1. 解析 manifest ──
    const manifestResponse = await fetch(task.url, {
      signal: task._abortController.signal,
    });
    if (!manifestResponse.ok) {
      throw new Error(`获取 manifest 失败: HTTP ${manifestResponse.status}`);
    }
    const manifestText = await manifestResponse.text();

    /** @type {Array} 分片列表 */
    let segments = [];
    /** @type {Uint8Array|null} init segment（fMP4） */
    let initSegment = null;
    /** @type {string} codecs */
    let codecs = '';
    /** @type {string} containerType - "fmp4" | "ts" */
    let containerType = 'fmp4';
    /** @type {Array|null} 第二个轨道的分片列表（DASH audio/video 分离时） */
    let secondTrackSegments = null;
    /** @type {Uint8Array|null} */
    let secondTrackInit = null;
    let secondTrackCodecs = '';

    if (task.streamType === 'hls') {
      // HLS：可能是 master 或 media playlist
      if (manifestText.includes('#EXT-X-STREAM-INF')) {
        // master playlist：选择最高质量 variant
        const { variants } = parseMasterPlaylist(manifestText, task.url);
        if (variants.length === 0) throw new Error('master playlist 中没有 variant');
        const selected = variants[0]; // 最高质量

        // 获取 media playlist
        const mediaResp = await fetch(selected.uri, {
          signal: task._abortController.signal,
        });
        const mediaText = await mediaResp.text();
        const mediaPlaylist = parseMediaPlaylist(mediaText, selected.uri);

        segments = mediaPlaylist.segments;
        codecs = selected.codecs || '';
        containerType = mediaPlaylist.map ? 'fmp4' : 'ts';
      } else {
        // 直接是 media playlist
        const mediaPlaylist = parseMediaPlaylist(manifestText, task.url);
        segments = mediaPlaylist.segments;
        codecs = task.streamMeta?.codecs || '';
        containerType = mediaPlaylist.map ? 'fmp4' : 'ts';
      }

      // 下载 init segment（如果有）
      if (segments.length > 0 && segments[0].map) {
        const initResp = await fetch(segments[0].map.uri, {
          signal: task._abortController.signal,
        });
        initSegment = new Uint8Array(await initResp.arrayBuffer());
      }
    } else if (task.streamType === 'dash') {
      // DASH：解析 MPD
      const manifest = parseMpd(manifestText, task.url);

      // 找到 video 和 audio adaptation
      const videoAdapt = manifest.adaptations.find((a) => a.contentType === 'video');
      const audioAdapt = manifest.adaptations.find((a) => a.contentType === 'audio');

      if (videoAdapt && videoAdapt.representations.length > 0) {
        const videoRep = videoAdapt.representations[0]; // 最高质量
        segments = videoRep.segments;
        codecs = videoRep.codecs;
        if (videoRep.initSegmentUri) {
          const initResp = await fetch(videoRep.initSegmentUri, {
            signal: task._abortController.signal,
          });
          initSegment = new Uint8Array(await initResp.arrayBuffer());
        }
      }

      if (audioAdapt && audioAdapt.representations.length > 0) {
        const audioRep = audioAdapt.representations[0];
        secondTrackSegments = audioRep.segments;
        secondTrackCodecs = audioRep.codecs;
        if (audioRep.initSegmentUri) {
          const initResp = await fetch(audioRep.initSegmentUri, {
            signal: task._abortController.signal,
          });
          secondTrackInit = new Uint8Array(await initResp.arrayBuffer());
        }
      }
    }

    if (segments.length === 0) {
      throw new Error('未解析到任何分片');
    }

    task.segmentTotal = segments.length;
    task.total = segments.length;
    task.downloaded = 0;
    reportStatus(task);

    // ── 2. 选路 ──
    //    concat  - fMP4 单轨道直接拼接（流式，内存恒定）
    //    mp4box  - fMP4 多轨道合并（DASH video+audio，需收集 samples）
    //    ffmpeg  - TS 或不支持 codec 的兜底
    const isFmp4 = containerType === 'fmp4' && initSegment;
    const isMultiTrack = !!(secondTrackSegments && secondTrackSegments.length > 0 && secondTrackInit);
    const codecFastPath = canFastPath(codecs) && (secondTrackCodecs === '' || canFastPath(secondTrackCodecs));

    /** @type {'concat'|'mp4box'|'ffmpeg'} */
    let path;
    if (isFmp4 && codecFastPath) {
      path = isMultiTrack ? 'mp4box' : 'concat';
    } else {
      path = 'ffmpeg';
    }

    // ffmpeg 可用性检查（ffmpeg 路径必须）
    if (path === 'ffmpeg' && !isFfmpegAvailable()) {
      throw new Error('此视频需要 ffmpeg 转码，但 SharedArrayBuffer 不可用（COOP/COEP 未配置）');
    }

    // ── 3. 下载与合并 ──
    const onProgress = (info) => {
      task.segmentCompleted = info.completed;
      task.segmentTotal = info.total;
      task.downloaded = info.completed;
      task.total = info.total;
      task.speed = info.speed;
      task.eta = info.total > info.completed ? Math.round((info.total - info.completed) / Math.max(info.speed, 1)) : 0;
      reportStatus(task);
    };

    if (path === 'concat') {
      // ── concat 路径：fMP4 单轨道直接拼接，流式 ──
      // 提前打开 writer：concatFmp4Stream 需要立即写 init segment，
      // 之后每个 fragment 到达即 writeFragment 写盘并释放引用。
      const streamFileHandle = task.fileHandleKey ? await getHandle(task.fileHandleKey) : null;
      writer = new FileWriter(streamFileHandle, task.fileName);
      await writer.open();

      const concat = await concatFmp4Stream({
        initSegment,
        writer,
        totalSegments: segments.length,
      });

      let writeOffset = initSegment.byteLength;

      fetcher = new SegmentFetcher(segments, {
        concurrency: downloadSettings.segmentConcurrency,
        signal: task._abortController.signal,
        headers: task.headers,
      });

      const onSegment = async (segmentInfo) => {
        // fragment 到达即写盘，写完后 segmentInfo.data 引用由 GC 回收
        writeOffset = await concat.writeFragment(segmentInfo.data, writeOffset);
      };

      await fetcher.fetch(onProgress, onSegment);

    } else if (path === 'mp4box') {
      // ── mp4box 路径：多轨道合并，需收集分片 ──
      // mp4box.js 的 addSample 是非流式的，必须在所有 samples 收集后 write()。
      // 这是 mp4box.js 的固有限制，仅用于多轨道场景。

      // 提前打开 writer（同 concat 路径的修复）：showSaveFilePicker 授予的写权限
      // 只在用户手势后的短暂窗口内有效，分片下载耗时可能很长，必须在开始下载前
      // 就调用 createWritable()，权限一旦兑现，后续写入不受权限衰减影响。
      const mp4boxFileHandle = task.fileHandleKey ? await getHandle(task.fileHandleKey) : null;
      writer = new FileWriter(mp4boxFileHandle, task.fileName);
      await writer.open();

      /** @type {{data: Uint8Array}[]} */
      const videoSegments = [];
      /** @type {{data: Uint8Array}[]} */
      const audioSegments = [];

      fetcher = new SegmentFetcher(segments, {
        concurrency: downloadSettings.segmentConcurrency,
        signal: task._abortController.signal,
        headers: task.headers,
      });

      const onSegment = async (segmentInfo) => {
        videoSegments.push({ data: segmentInfo.data });
      };

      await fetcher.fetch(onProgress, onSegment);

      // 下载第二轨道（DASH audio）
      if (secondTrackSegments && secondTrackSegments.length > 0) {
        const audioFetcher = new SegmentFetcher(secondTrackSegments, {
          concurrency: downloadSettings.segmentConcurrency,
          signal: task._abortController.signal,
          headers: task.headers,
        });

        const onAudioSegment = async (segmentInfo) => {
          audioSegments.push({ data: segmentInfo.data });
        };

        // audio 进度不单独上报，合并到主进度（简化）
        await audioFetcher.fetch(null, onAudioSegment);
      }

      // 合并并写盘（writer 已在下载前打开，见上方）
      task.status = TaskStatus.WRITING;
      reportStatus(task);

      await remuxMultiTrackMp4({
        video: {
          type: 'video',
          initSegment,
          segments: videoSegments,
          codecs,
        },
        audio: {
          type: 'audio',
          initSegment: secondTrackInit,
          segments: audioSegments,
          codecs: secondTrackCodecs,
        },
        writer,
        onProgress: (progress) => {
          task.downloaded = Math.round(progress * task.total);
          reportStatus(task);
        },
      }).then(async (result) => {
        // P3 第 1 项验证：回灌 mp4box 自检解码器配置盒
        if (result && result.outputData) {
          await verifyRemux(result.outputData);
        }
      });

    } else {
      // ── ffmpeg 路径：TS 或不支持 codec，必须收集所有分片 ──
      // ffmpeg.wasm 需要完整输入文件，这是其固有限制

      // 提前打开 writer（同 concat/mp4box 路径的修复），原因同上：
      // 权限只在用户手势后短暂有效，必须在分片下载开始前就 createWritable()。
      const ffmpegFileHandle = task.fileHandleKey ? await getHandle(task.fileHandleKey) : null;
      writer = new FileWriter(ffmpegFileHandle, task.fileName);
      await writer.open();

      /** @type {Uint8Array[]} */
      const collectedSegments = [];

      fetcher = new SegmentFetcher(segments, {
        concurrency: downloadSettings.segmentConcurrency,
        signal: task._abortController.signal,
        headers: task.headers,
      });

      const onSegment = async (segmentInfo) => {
        collectedSegments.push(segmentInfo.data);
      };

      await fetcher.fetch(onProgress, onSegment);

      task.status = TaskStatus.WRITING;
      reportStatus(task);

      if (containerType === 'ts') {
        // TS 合并
        await mergeTsToMp4(collectedSegments, writer, (progress) => {
          task.downloaded = Math.round(progress * task.total);
          reportStatus(task);
        });
      } else {
        // 其他情况：用 ffmpeg 重封装
        // 拼接所有分片
        const totalLength = collectedSegments.reduce((sum, seg) => sum + seg.length, 0);
        const combinedData = new Uint8Array(totalLength);
        let offset = 0;
        for (const seg of collectedSegments) {
          combinedData.set(seg, offset);
          offset += seg.length;
        }

        const result = await transcodeWithFfmpeg({
          inputs: [{ name: 'input.mp4', data: combinedData }],
          outputName: 'output.mp4',
          outputFormat: 'mp4',
          copyOnly: true,
        }, (progress) => {
          task.downloaded = Math.round(progress * task.total);
          reportStatus(task);
        });

        // 分块写入 writer
        const CHUNK_SIZE = 1024 * 1024;
        const data = result.data;
        offset = 0;
        while (offset < data.length) {
          const end = Math.min(offset + CHUNK_SIZE, data.length);
          await writer.write(data.slice(offset, end), offset);
          offset = end;
        }
      }
    }

    // ── 4. 关闭 writer ──
    task.status = TaskStatus.WRITING;
    reportStatus(task);

    const closeResult = await writer.close();
    writer = null;

    // Blob 模式：通知 SW 下载 blob。
    // 这是降级路径唯一的落盘动作，SW 那边失败了就必须把任务判失败——
    // 否则用户看到"已完成"，磁盘上却什么都没有。
    if (closeResult.method === 'blob' && closeResult.url) {
      const blobResponse = await chrome.runtime.sendMessage({
        type: 'BLOB_DOWNLOAD',
        target: 'sw',
        taskId: task.id,
        url: closeResult.url,
        fileName: task.fileName,
        conflictStrategy: task.conflictStrategy,
      });
      if (!blobResponse?.ok) {
        throw new Error(blobResponse?.error || 'Blob 保存失败');
      }
    }

    // 完成
    task.status = TaskStatus.DONE;
    task.downloaded = task.total;
    task.speed = 0;
    task.eta = 0;
    task.completedAt = Date.now();
    reportStatus(task);

  } catch (err) {
    if (err.name === 'AbortError' || task.status === TaskStatus.CANCELED) {
      task.status = TaskStatus.CANCELED;
    } else {
      task.status = TaskStatus.FAILED;
      task.error = err.message || String(err);
      console.error(`[WebGrab/Offscreen] 流媒体任务失败: ${task.id}`, err);
    }
    task.completedAt = Date.now();
    reportStatus(task);

    // 清理
    if (writer) {
      try {
        await writer.abort();
      } catch {}
    }
  } finally {
    task._abortController = null;
    activeCount--;
    // 任务进入终态（done/failed/canceled），清理 IndexedDB 中的句柄
    if (task.fileHandleKey) {
      deleteHandle(task.fileHandleKey).catch(() => {});
      task.fileHandleKey = null;
    }
    processQueue();
  }
}

/**
 * 执行 B 站下载任务（DASH 单 URL 流式合并）
 *
 * 架构事实（来自 §5.1 实测）：
 *   - B 站每条流只有【一个 URL】（baseUrl），文件内部结构是
 *     ftyp + moov + sidx + [moof + mdat]*N
 *   - init segment 就在文件开头（字节 0~initSize-1），不需要额外请求
 *   - sidx box 可忽略（mp4box 会自己处理）
 *
 * 流式合并流程：
 *   1. HttpFetcher 顺序 Range 分块下载（concurrency=1，保证 onChunk 按序到达）
 *   2. 第一块到达时，切出 init segment → createInputProcessor → onReady → addTrack
 *      → createBatchedSampleWriter，剩余部分作为首个 fragment 喂入 appendFragment
 *   3. 后续每块用 chunk.offset 作为 fileStart 调 appendFragment
 *      mp4box 同步触发 onSamples → batchedWriter.push（攒满 240 个 sample 生成多样本 fragment）
 *   4. video 和 audio 两路并发下载（Promise.all），各自独立的输入处理器
 *   5. 全部下载完成后，batchedWriter.flush() 处理剩余 sample → output.write(DataStream) 序列化，分块写盘
 *
 * 内存约束：
 *   - 下载端：concurrency=1，每块 2MB，处理完即释放，内存恒定
 *   - 合并端：createMultiSampleMoof 会累积 samples 直到 write()，这是 mp4box.js 的固有限制
 *     对于 1 小时 1080P（约 1GB），offscreen renderer 进程可承受
 *
 * URL 时效：
 *   - HttpFetcher 内置多源 fallback（403/410 时切换 backupUrl）
 *   - 全部源失败 → 抛错，提示用户刷新页面
 *
 * @param {DownloadTask} task
 */
/**
 * B 站流式下载的分块大小
 *
 * 每块下完即通过 onChunk 喂给 mp4box 解析、随后释放，因此内存占用与文件总大小无关。
 * 2MB 是下载吞吐和 appendBuffer 调用开销之间的折中值。
 */
const BILI_CHUNK_SIZE = 2 * 1024 * 1024;

async function executeBilibiliTask(task) {
  task.status = TaskStatus.DOWNLOADING;
  task._abortController = new AbortController();
  reportStatus(task);

  /** @type {FileWriter|null} */
  let writer = null;

  try {
    const streamMeta = task.streamMeta;
    const videoVariant = streamMeta.videoVariant;
    const audioVariant = streamMeta.audioVariant || null;
    const audioOnly = streamMeta.audioOnly === true; // 仅下载音频模式

    // ── 编码兼容性检查 ──
    // 本轮 mp4box 快路径仅验证过 AVC（avc1）+ AAC（mp4a）。
    // 配了 description_boxes 之后 AV1/HEVC 理论上也能 remux，但未经验证，
    // 本轮按不支持处理——宁可明确拒绝也不要产出坏文件。
    // 用户在 B 站 UI 选了 HEVC/AV1 时，提示改选 AVC。
    if (!audioOnly && videoVariant && !canFastPath(videoVariant.codecs || '')) {
      throw new Error(
        `当前视频编码（${videoVariant.codecs}）暂不支持快路径合并，请在下载面板的"编码"下拉中改选 AVC 后重试`
      );
    }
    if (audioVariant && !canFastPath(audioVariant.codecs || '')) {
      throw new Error(
        `当前音频编码（${audioVariant.codecs}）暂不支持快路径合并`
      );
    }

    // 解析 SegmentBase.Initialization 得出 init segment 字节长度
    const videoInitSize = audioOnly ? 0 : parseSegmentBaseInitSize(videoVariant.segmentBase);
    const audioInitSize = audioVariant ? parseSegmentBaseInitSize(audioVariant.segmentBase) : 0;

    if (!audioOnly && videoInitSize === 0) {
      throw new Error('无法解析 video SegmentBase.Initialization，可能播放清单已过期');
    }
    if (audioVariant && audioInitSize === 0) {
      throw new Error('无法解析 audio SegmentBase.Initialization，可能播放清单已过期');
    }

    // ── 提前打开 writer（关键修复：文件写入权限时效问题）──
    // showSaveFilePicker() 授予的写权限只在用户手势后的短暂窗口内有效，popup 关闭
    // 后会衰减回 'prompt'。video+audio 下载耗时可能长达数分钟，若等下载完再
    // createWritable()，权限早已失效，报"文件写入权限不足"。
    // 必须在开始下载前就调用 createWritable()——一旦成功，拿到的
    // FileSystemWritableStream 后续写入不再受权限衰减影响。
    const biliFileHandle = task.fileHandleKey ? await getHandle(task.fileHandleKey) : null;
    writer = new FileWriter(biliFileHandle, task.fileName);
    await writer.open();

    // 加载 mp4box
    await loadMp4box();
    const MP4Box = window.MP4Box;
    if (!MP4Box) throw new Error('mp4box 未加载');

    // 创建输出 ISOFile
    const output = MP4Box.createFile();
    let outputVideoTrackId = null;
    let outputAudioTrackId = null;

    // 进度跟踪
    let videoDownloaded = 0;
    let audioDownloaded = 0;
    let videoTotal = -1;
    let audioTotal = -1;

    const updateProgress = () => {
      task.downloaded = videoDownloaded + audioDownloaded;
      task.total = (videoTotal > 0 ? videoTotal : 0) + (audioTotal > 0 ? audioTotal : 0);
      reportStatus(task);
    };

    // ── video 下载+处理流（仅 audioOnly=false 时） ──
    /** @type {{appendFragment: Function, flush: Function, info: Object}|null} */
    let videoProcessor = null;
    /** @type {{push(s: Object): void, flush(): void}|null} */
    let videoWriter = null;

    const downloadVideo = async () => {
      if (audioOnly) return;

      const fetcher = new HttpFetcher(videoVariant.urls, {
        concurrency: 1,                  // 顺序下载，保证 mp4box 按序 appendBuffer
        chunkSize: BILI_CHUNK_SIZE,
        signal: task._abortController.signal,
      });

      const onChunk = async (chunkInfo) => {
        if (!videoProcessor) {
          // 第一块：切出 init segment 建 processor
          if (chunkInfo.data.byteLength < videoInitSize) {
            throw new Error(`第一块过小（${chunkInfo.data.byteLength}字节），无法覆盖 init segment（${videoInitSize}字节）`);
          }
          const initSeg = chunkInfo.data.subarray(0, videoInitSize);
          // 用 batchedWriter 攒批写入，避免单样本 fragment 引发的
          // PIPELINE_ERROR_DECODE（见 remuxer.js createMultiSampleMoof 注释）
          videoProcessor = await createInputProcessor(initSeg, (samples) => {
            for (const s of samples) {
              videoWriter.push(s);
            }
          });
          // onReady 已触发，拿到 track 信息，addTrack 到输出
          const vTrack = videoProcessor.info.tracks.find((t) => t.video || t.type === 'video');
          if (!vTrack) throw new Error('video init segment 中未找到视频轨道');
          // 关键修复：必须把源 sample entry 的 avcC/hvcC/av1C 等配置盒原样搬过去，
          // 否则输出文件无 SPS/PPS 等解码器配置 → 无法播放。
          // type 字段优先用源 entry 的 type（权威值），找不到时降级到 codec.split('.')[0]
          const vSrcEntry = videoProcessor.getSampleEntry(vTrack.id);
          const videoFourCc = (vTrack.codec || videoVariant.codecs || 'avc1').split('.')[0];
          outputVideoTrackId = output.addTrack({
            type: vSrcEntry ? vSrcEntry.type : videoFourCc,
            timescale: vTrack.timescale || 90000,
            duration: vTrack.duration || 0,
            width: vTrack.video ? vTrack.video.width : undefined,
            height: vTrack.video ? vTrack.video.height : undefined,
            codec: vTrack.codec,
            description_boxes: vSrcEntry ? vSrcEntry.boxes : undefined,
            // 显式传 hdlr：mp4box.js 的 addTrack() 默认 handler 就是 'vide'，
            // 对视频轨道本来凑巧对，但必须写明，不能依赖这个默认值
            // （音频轨道就是因为漏传这个才被静默判成视频轨道，见下方 audio 的注释）。
            hdlr: 'vide',
            name: 'VideoHandler',
          });
          // trackId 已知，创建 batchedWriter（必须在喂入 fragments 之前）
          // 视频用 GOP 边界切分，确保每个 fragment 从关键帧开始
          videoWriter = createBatchedSampleWriter(output, outputVideoTrackId, { gopAware: true });
          // 把第一块的剩余部分（sidx + moof + mdat...）喂进去
          // fileStart = videoInitSize（init segment 之后的起始偏移）
          const remaining = chunkInfo.data.subarray(videoInitSize);
          if (remaining.byteLength > 0) {
            videoProcessor.appendFragment(remaining, videoInitSize);
          }
        } else {
          // 后续块：直接 appendBuffer，fileStart = chunkInfo.offset
          videoProcessor.appendFragment(chunkInfo.data, chunkInfo.offset);
        }
        videoDownloaded += chunkInfo.data.byteLength;
      };

      const onProgress = (info) => {
        videoDownloaded = info.downloaded;
        videoTotal = info.total;
        updateProgress();
      };

      await fetcher.download(onProgress, onChunk);
      if (videoProcessor) videoProcessor.flush();
      // flush 剩余凑不够一批的 sample
      if (videoWriter) videoWriter.flush();
    };

    // ── audio 下载+处理流 ──
    /** @type {{appendFragment: Function, flush: Function, info: Object}|null} */
    let audioProcessor = null;
    /** @type {{push(s: Object): void, flush(): void}|null} */
    let audioWriter = null;

    const downloadAudio = async () => {
      if (!audioVariant) return;

      const fetcher = new HttpFetcher(audioVariant.urls, {
        concurrency: 1,
        chunkSize: BILI_CHUNK_SIZE,
        signal: task._abortController.signal,
      });

      const onChunk = async (chunkInfo) => {
        if (!audioProcessor) {
          if (chunkInfo.data.byteLength < audioInitSize) {
            throw new Error(`第一块过小（${chunkInfo.data.byteLength}字节），无法覆盖 audio init segment（${audioInitSize}字节）`);
          }
          const initSeg = chunkInfo.data.subarray(0, audioInitSize);
          // 用 batchedWriter 攒批写入，避免单样本 fragment 引发的
          // PIPELINE_ERROR_DECODE（见 remuxer.js createMultiSampleMoof 注释）
          audioProcessor = await createInputProcessor(initSeg, (samples) => {
            for (const s of samples) {
              audioWriter.push(s);
            }
          });
          const aTrack = audioProcessor.info.tracks.find((t) => t.audio || t.type === 'audio');
          if (!aTrack) throw new Error('audio init segment 中未找到音频轨道');
          // 同上 video：把源 sample entry 的 esds 等配置盒原样搬过去，否则 AAC 无 esds → 静音
          const aSrcEntry = audioProcessor.getSampleEntry(aTrack.id);
          const audioFourCc = (aTrack.codec || audioVariant.codecs || 'mp4a').split('.')[0];
          // 关键修复 1：必须显式传 samplerate/channel_count，否则 mp4box.js 的
          // addTrack() 会分别 fallback 成 65536（16.16 定点数下等于"1Hz"）和 2——
          // 容器层 stsd/mp4a 的 samplerate 字段被写成荒谬的 1Hz。
          // 关键修复 2（真正的静音根因）：addTrack() 的 hdlr 参数默认值是 "vide"
          // （对视频轨道凑巧对，从未被发现是缺陷）。我们从未显式传 hdlr，
          // 导致音频轨道的 hdlr.handler_type 也被写成 "vide" 而不是 "soun"——
          // 用逐字节解析 moov/trak/mdia/hdlr 实测确认过这一点。播放器根据
          // handler_type 判断轨道类型并决定要不要接入音频输出管线，
          // handler_type="vide" 的音频轨道会被直接当作视频轨道处理，
          // 因此实际采样数据完全正确（decodeAudioData 验证过是真实音频），
          // 只是从未被路由到音频输出——表现为"看起来正常但完全没声音"。
          outputAudioTrackId = output.addTrack({
            type: aSrcEntry ? aSrcEntry.type : audioFourCc,
            timescale: aTrack.timescale || 48000,
            duration: aTrack.duration || 0,
            codec: aTrack.codec,
            description_boxes: aSrcEntry ? aSrcEntry.boxes : undefined,
            samplerate: aTrack.audio ? aTrack.audio.sample_rate : undefined,
            channel_count: aTrack.audio ? aTrack.audio.channel_count : undefined,
            samplesize: aTrack.audio ? aTrack.audio.sample_size : undefined,
            hdlr: 'soun',
            name: 'SoundHandler',
          });
          // trackId 已知，创建 batchedWriter（必须在喂入 fragments 之前）
          audioWriter = createBatchedSampleWriter(output, outputAudioTrackId);
          const remaining = chunkInfo.data.subarray(audioInitSize);
          if (remaining.byteLength > 0) {
            audioProcessor.appendFragment(remaining, audioInitSize);
          }
        } else {
          audioProcessor.appendFragment(chunkInfo.data, chunkInfo.offset);
        }
        audioDownloaded += chunkInfo.data.byteLength;
      };

      const onProgress = (info) => {
        audioDownloaded = info.downloaded;
        audioTotal = info.total;
        updateProgress();
      };

      await fetcher.download(onProgress, onChunk);
      if (audioProcessor) audioProcessor.flush();
      // flush 剩余凑不够一批的 sample
      if (audioWriter) audioWriter.flush();
    };

    // ── 并发下载 video + audio 两路 ──
    // 每路内部 concurrency=1（顺序），两路之间并发
    await Promise.all([downloadVideo(), downloadAudio()]);

    // ── 序列化输出并写盘 ──
    // mp4box.js 的 write() 是一次性序列化，addSample 累积的所有 samples 在此写出
    task.status = TaskStatus.WRITING;
    task.downloaded = task.total > 0 ? task.total : task.downloaded;
    reportStatus(task);

    // 修正 addTrack() 留下的容器级元数据缺陷（倾斜矩阵、duration=0 等），必须在 write 之前
    finalizeMp4Metadata(output);

    const stream = new DataStream();
    stream.endianness = DataStream.BIG_ENDIAN;
    output.write(stream);

    const outputBuffer = stream.buffer;
    const outputData = new Uint8Array(outputBuffer);

    // ── P3 第 1 项验证：回灌 mp4box 自检解码器配置盒 ──
    // 断言：codec 是完整字符串（非裸 fourCC），stsd entry 含 avcC/esds 等配置盒
    // 自检失败不中断流程（文件已生成），但会在控制台报错便于定位
    await verifyRemux(outputData);

    // 分块写入 FileWriter（1MB 一块）
    const CHUNK_SIZE = 1024 * 1024;
    let offset = 0;
    while (offset < outputData.length) {
      const end = Math.min(offset + CHUNK_SIZE, outputData.length);
      await writer.write(outputData.subarray(offset, end), offset);
      offset = end;
    }

    // 关闭 writer
    const closeResult = await writer.close();
    writer = null;

    // Blob 模式：通知 SW 下载 blob。
    // 这是降级路径唯一的落盘动作，SW 那边失败了就必须把任务判失败——
    // 否则用户看到"已完成"，磁盘上却什么都没有。
    if (closeResult.method === 'blob' && closeResult.url) {
      const blobResponse = await chrome.runtime.sendMessage({
        type: 'BLOB_DOWNLOAD',
        target: 'sw',
        taskId: task.id,
        url: closeResult.url,
        fileName: task.fileName,
        conflictStrategy: task.conflictStrategy,
      });
      if (!blobResponse?.ok) {
        throw new Error(blobResponse?.error || 'Blob 保存失败');
      }
    }

    // 完成
    task.status = TaskStatus.DONE;
    task.downloaded = task.total > 0 ? task.total : task.downloaded;
    task.speed = 0;
    task.eta = 0;
    task.completedAt = Date.now();
    reportStatus(task);

  } catch (err) {
    if (err.name === 'AbortError' || task.status === TaskStatus.CANCELED) {
      task.status = TaskStatus.CANCELED;
    } else {
      task.status = TaskStatus.FAILED;
      // URL 失效的友好提示
      const msg = err.message || String(err);
      if (/403|410|expired|时效|过期/i.test(msg)) {
        task.error = '下载链接已失效，请重新打开播放页刷新链接后重试';
      } else {
        task.error = msg;
      }
      console.error(`[WebGrab/Offscreen] B 站任务失败: ${task.id}`, err);
    }
    task.completedAt = Date.now();
    reportStatus(task);

    if (writer) {
      try { await writer.abort(); } catch { /* 忽略 abort 错误 */ }
    }
  } finally {
    task._abortController = null;
    activeCount--;
    // 任务进入终态（done/failed/canceled），清理 IndexedDB 中的句柄
    if (task.fileHandleKey) {
      deleteHandle(task.fileHandleKey).catch(() => {});
      task.fileHandleKey = null;
    }
    processQueue();
  }
}

/**
 * 取消任务
 * @param {DownloadTask} task
 */
async function cancelTask(task) {
  // 从待执行队列中移除（若还在排队）
  const index = pendingQueue.indexOf(task.id);
  if (index !== -1) {
    pendingQueue.splice(index, 1);
  }

  const wasRunning = Boolean(task._abortController);
  if (wasRunning) {
    // 任务已开始执行：abort 后由 executeTask 的 finally 负责 deleteHandle
    task._abortController.abort();
  } else {
    // 任务未开始执行（pending 状态）：finally 不会触发，这里手动清理句柄
    if (task.fileHandleKey) {
      deleteHandle(task.fileHandleKey).catch(() => {});
      task.fileHandleKey = null;
    }
    const directoryHandleKey = task.streamMeta?.dirHandleKey;
    if (directoryHandleKey) {
      deleteHandle(directoryHandleKey).catch(() => {});
      task.streamMeta.dirHandleKey = null;
    }
  }

  task.status = TaskStatus.CANCELED;
  task.completedAt = Date.now();
  reportStatus(task);

  // 排队中的小说任务不会进入 executeNovelTask 的 catch，因此在这里同步
  // 落库 canceled；已运行任务由 worker 在 AbortError 分支落库。
  if (!wasRunning && task.streamMeta?.kind === 'novel' && task.streamMeta.bookId) {
    await markNovelTaskCanceled(task.streamMeta.bookId);
  }
}

/**
 * 向 SW 上报任务状态
 * @param {DownloadTask} task
 */
function reportStatus(task) {
  const report = stripInternal(task);
  chrome.runtime.sendMessage({
    type: 'TASK_UPDATE',
    target: 'sw',
    task: report,
  }).catch(() => {
    // SW 可能休眠，忽略错误
  });
}

/**
 * 去除内部字段，生成可序列化的任务对象
 * @param {DownloadTask} task
 * @returns {Object}
 */
function stripInternal(task) {
  const { _abortController, ...rest } = task;
  return rest;
}

// ─── 通知 SW offscreen 已就绪 ──────────────────────────────
chrome.runtime.sendMessage({
  type: 'OFFSCREEN_READY',
  target: 'sw',
}).catch(() => {});

console.log('[WebGrab/Offscreen] 下载队列已初始化');
