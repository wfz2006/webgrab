/**
 * 下载管理器 —— SW 端的下载任务与 Offscreen 生命周期管理
 *
 * 职责：
 *   - ensureOffscreen()：确保 offscreen 存在，不重复创建
 *   - 任务创建、DNR 集成、分派到 offscreen
 *   - 任务状态持久化到 chrome.storage.local
 *   - Offscreen 生命周期：任务清空后延迟 30 秒关闭
 *   - 小文件直接走 chrome.downloads.download()，无需 offscreen
 */

import { acquire, release, cleanupAll } from './dnr-manager.js';
import { getAdapterForUrl } from './adapter-router.js';
import { buildFileName } from '../lib/filename.js';
import { prepareChromeDownload } from '../lib/chrome-download-path.js';
import {
  adaptiveStreamType,
  normalizeAdaptiveStreamOutput,
} from '../lib/media-output.js';

const TASKS_KEY = 'webgrab_tasks';
const OFFSCREEN_URL = 'offscreen/downloader.html';
const OFFSCREEN_CLOSE_DELAY = 30_000;
const SMALL_FILE_THRESHOLD = 50 * 1024 * 1024; // 50MB

/** offscreen 是否已创建（SW 内存态，重启后靠 getContexts 恢复） */
let offscreenExists = false;
/** offscreen 就绪 Promise（等 OFFSCREEN_READY 消息） */
let offscreenReadyPromise = null;
let offscreenReadyResolve = null;
/**
 * 正在进行的 offscreen 创建流程（单飞锁）。
 * 整个扩展同时只允许存在一个 offscreen document，第二次 createDocument 会直接
 * 抛错而不是排队等待；并发下载任务各自调 ensureOffscreen 时必须共用同一次创建。
 * @type {Promise<void>|null}
 */
let offscreenSetupPromise = null;
/** 当前由 offscreen 执行的任务；taskId 集合让重复终态天然幂等。 */
const activeOffscreenTaskIds = new Set();
/** 延迟关闭 offscreen 的定时器 */
let closeTimer = null;
/** 同一 SW 实例内串行化全本任务的“检查 + 创建”，封住双 popup 竞态。 */
let novelStartGate = Promise.resolve();
/** 串行化 chrome.storage.local 的任务数组读改写，避免并发更新互相覆盖。 */
let taskWriteGate = Promise.resolve();
/**
 * taskId → 排队中但还没真正落盘的写入。
 * 同一个 taskId 在轮到它落盘之前又来新的更新（高频进度上报常见），
 * 合并成一次写入而不是排队多次完整读改写；所有并发调用方仍然共享
 * 同一个 Promise，await 后拿到的必定是合并后写入磁盘的最新结果。
 * @type {Map<string, {latestTask: Object, promise: Promise<Object>}>}
 */
const pendingTaskWrites = new Map();
let taskChangeListener = null;

export function setTaskChangeListener(listener) {
  taskChangeListener = typeof listener === 'function' ? listener : null;
}

// ─── 任务存储 ──────────────────────────────────────────────

/**
 * 加载所有任务
 * @returns {Promise<Object[]>}
 */
async function loadTasks() {
  const result = await chrome.storage.local.get(TASKS_KEY);
  return result[TASKS_KEY] || [];
}

/**
 * 保存所有任务
 * @param {Object[]} tasks
 */
async function saveTasks(tasks) {
  await chrome.storage.local.set({ [TASKS_KEY]: tasks });
}

/**
 * 创建或更新单个任务
 * @param {Object} task
 */
async function persistTaskUpdate(task) {
  const tasks = await loadTasks();
  const index = tasks.findIndex((t) => t.id === task.id);
  if (index >= 0) {
    tasks[index] = { ...tasks[index], ...task };
  } else {
    tasks.unshift(task);
  }
  const mergedTask = index >= 0 ? tasks[index] : tasks[0];
  mergedTask.updatedAt = Date.now();
  // 最多保留 100 条历史
  if (tasks.length > 100) {
    tasks.length = 100;
  }
  await saveTasks(tasks);

  if (['done', 'failed', 'canceled'].includes(mergedTask.status)) {
    finishOffscreenTask(mergedTask.id);
  }

  return mergedTask;
}

async function upsertTask(task) {
  // 同一 taskId 已有一次写入排队但还没轮到执行：合并成最新数据，
  // 复用同一个 promise，不再额外排队一次完整读改写（数组含最多 100 条任务，
  // 高频进度上报时逐条排队会让 chrome.storage.local 读改写成为瓶颈）。
  const existing = pendingTaskWrites.get(task.id);
  if (existing) {
    existing.latestTask = task;
    return existing.promise;
  }

  const entry = { latestTask: task, promise: null };
  pendingTaskWrites.set(task.id, entry);

  const writeOperation = taskWriteGate.then(() => {
    // 落盘时取当次真正执行时刻的最新数据，而不是最初排队时刻的数据；
    // 先从 map 摘除，让排队期间之后到达的新更新重新开一个 entry。
    pendingTaskWrites.delete(task.id);
    return persistTaskUpdate(entry.latestTask);
  });
  // 失败不能毒死后续写入；闸门只覆盖 get→merge→set，不把监听器耗时塞进临界区。
  taskWriteGate = writeOperation.catch(() => {});
  entry.promise = writeOperation;

  const mergedTask = await writeOperation;
  try {
    await taskChangeListener?.(mergedTask);
  } catch {
    // 悬浮窗状态发布失败不能破坏下载状态持久化。
  }
  return mergedTask;
}

/**
 * 删除单个任务
 * @param {string} taskId
 */
async function removeTask(taskId) {
  const tasks = await loadTasks();
  const filtered = tasks.filter((t) => t.id !== taskId);
  await saveTasks(filtered);
}

// ─── Offscreen 生命周期 ────────────────────────────────────

/**
 * 确保 offscreen document 已创建
 */
export async function ensureOffscreen() {
  cancelOffscreenClose();

  if (offscreenExists) return;

  // 单飞：并发调用共用同一次创建流程。没有这道锁时，几个同时开始的下载任务
  // 会各自走到 createDocument，第一个之外的全部拿到
  // "Only a single offscreen document may be created." 并被判为任务失败。
  if (offscreenSetupPromise) return offscreenSetupPromise;

  offscreenSetupPromise = setupOffscreen().finally(() => {
    offscreenSetupPromise = null;
  });
  return offscreenSetupPromise;
}

async function setupOffscreen() {
  // 检查是否已存在（SW 重启后恢复状态）
  try {
    const contexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT'],
    });
    if (contexts.length > 0) {
      offscreenExists = true;
      return;
    }
  } catch {
    // getContexts 可能不可用，继续尝试创建
  }

  // 就绪 Promise 必须先于 createDocument 建好：offscreen 文档加载很快，
  // OFFSCREEN_READY 完全可能在 createDocument 返回之前就送达，
  // 那时 offscreenReadyResolve 还是空的，通知会落空、白等 5 秒超时兜底。
  offscreenReadyPromise = new Promise((resolve) => {
    offscreenReadyResolve = resolve;
    // 超时兜底：5 秒后认为就绪
    setTimeout(() => resolve(), 5000);
  });

  // 创建 offscreen document
  try {
    await chrome.offscreen.createDocument({
      url: OFFSCREEN_URL,
      reasons: ['WORKERS', 'BLOBS'],
      justification: '分片下载、音视频合并与流式写盘',
    });
  } catch (error) {
    // 另一个上下文（或上一次未及时反映到 getContexts 的创建）已经把文档建好了：
    // 这种报错说明文档确实存在，按成功处理，别把任务判死。
    if (!/single offscreen document/i.test(error?.message || '')) throw error;
  }

  offscreenExists = true;

  await offscreenReadyPromise;
}

/**
 * 安排延迟关闭 offscreen
 */
function scheduleOffscreenClose() {
  cancelOffscreenClose();
  closeTimer = setTimeout(async () => {
    if (activeOffscreenTaskIds.size === 0 && offscreenExists) {
      try {
        await chrome.offscreen.closeDocument();
        offscreenExists = false;
        console.log('[WebGrab] Offscreen 已关闭（空闲超时）');
      } catch (err) {
        // 可能已被关闭
        offscreenExists = false;
      }
    }
    closeTimer = null;
  }, OFFSCREEN_CLOSE_DELAY);
}

/**
 * 取消延迟关闭
 */
function cancelOffscreenClose() {
  if (closeTimer) {
    clearTimeout(closeTimer);
    closeTimer = null;
  }
}

/**
 * 幂等地结束一个 offscreen 任务。只有真实移除过 taskId 的首次终态才能触发关闭判断。
 */
function finishOffscreenTask(taskId) {
  if (!activeOffscreenTaskIds.delete(taskId)) return false;
  if (activeOffscreenTaskIds.size === 0) scheduleOffscreenClose();
  return true;
}

/**
 * 唯一的 offscreen 任务派发入口：确保文档存在、登记 taskId，再发送任务。
 * 派发失败时在同一入口撤销登记；正常终态由 persistTaskUpdate 幂等移除。
 */
async function dispatchOffscreenTask(task, fallbackError = 'offscreen 未接受任务') {
  await ensureOffscreen();
  activeOffscreenTaskIds.add(task.id);
  cancelOffscreenClose();

  try {
    const response = await chrome.runtime.sendMessage({
      type: 'EXECUTE_TASK',
      target: 'offscreen',
      task,
    });
    if (!response?.ok) throw new Error(response?.error || fallbackError);
    return response;
  } catch (error) {
    finishOffscreenTask(task.id);
    throw error;
  }
}

/**
 * 原子地发起 chrome.downloads 下载并等待终态。
 *
 * 必须在 download() 前先注册 onChanged，且拿到 downloadId 后立即
 * search() 一次当前状态，同时覆盖“监听过晚”和“ID 返回过晚”两种竞态。
 *
 * @param {chrome.downloads.DownloadOptions} options
 * @param {number} [timeoutMs=300000]
 * @returns {{
 *   started: Promise<{downloadId: number|null, error?: string}>,
 *   completion: Promise<{downloadId: number|null, state: string, error?: string}>
 * }}
 */
export function startDownloadAndWait(options, timeoutMs = 300000) {
  let downloadId = null;
  let settled = false;
  let timeoutId = null;
  let resolveStarted;

  const started = new Promise((resolve) => {
    resolveStarted = resolve;
  });

  const completion = new Promise((resolveCompletion) => {
    const cleanup = () => {
      chrome.downloads.onChanged.removeListener(handler);
      if (timeoutId !== null) clearTimeout(timeoutId);
    };

    const finish = (state, error) => {
      if (settled) return;
      settled = true;
      cleanup();

      if (downloadId === null) {
        resolveCompletion({ downloadId: null, state, error });
        return;
      }

      // error 可能不在 onChanged 的同一个 delta 中，搜完整记录补齐。
      chrome.downloads
        .search({ id: downloadId })
        .then((items) => {
          const item = items[0];
          const searchedState =
            item && (item.state === 'complete' || item.state === 'interrupted')
              ? item.state
              : state;
          resolveCompletion({
            downloadId,
            state: searchedState,
            error: item?.error || error || undefined,
          });
        })
        .catch(() => resolveCompletion({ downloadId, state, error }));
    };

    const handler = (delta) => {
      if (downloadId === null || delta.id !== downloadId) return;
      if (
        delta.state &&
        (delta.state.current === 'complete' || delta.state.current === 'interrupted')
      ) {
        finish(delta.state.current);
      }
    };

    timeoutId = setTimeout(() => finish('timeout'), timeoutMs);

    // 关键时序：先挂监听器，紧接着发起下载，中间没有 await。
    chrome.downloads.onChanged.addListener(handler);
    try {
      chrome.downloads.download(options, (id) => {
        if (chrome.runtime.lastError) {
          const error = chrome.runtime.lastError.message;
          resolveStarted({ downloadId: null, error });
          finish('error', error);
          return;
        }

        downloadId = id;
        resolveStarted({ downloadId });

        // 事件可能在回调前已发出（当时还不知道 ID），主动查终态兜底。
        chrome.downloads
          .search({ id })
          .then((items) => {
            const item = items[0];
            if (item && (item.state === 'complete' || item.state === 'interrupted')) {
              finish(item.state, item.error);
            }
          })
          .catch(() => {
            // 查询失败时仍保留 onChanged + 超时兜底。
          });
      });
    } catch (err) {
      const error = err.message || String(err);
      resolveStarted({ downloadId: null, error });
      finish('error', error);
    }
  });

  return { started, completion };
}

// ─── 下载方法 ──────────────────────────────────────────────

/**
 * 启动下载
 *
 * 决策逻辑：
 *   1. 有 fileHandle（用户已通过 showSaveFilePicker 选择保存位置）→ 走 offscreen
 *   2. 无 fileHandle + 小文件/未知大小 → chrome.downloads.download() 首次直接下载
 *   3. 首次返回 SERVER_FORBIDDEN → DNR + offscreen/fetch（Blob 降级限 50MB）
 *
 * 手势保护：popup 在点击下载后立即调用 showSaveFilePicker，
 * 拿到 fileHandle 后连同 resource 一起发给 SW，避免消息往返耗尽手势窗口。
 *
 * 句柄传递：popup 把 FileSystemFileHandle 存入 IndexedDB（handle-store.js），
 * 只把 fileHandleKey 字符串发给 SW；SW 透传给 offscreen，offscreen 用 key 从
 * IndexedDB 取出真 handle。原因：chrome.runtime.sendMessage 是 JSON 序列化，
 * 会把 FileSystemFileHandle 变成空对象 {}（原型方法丢失）。
 *
 * @param {Object} resource - 资源对象 { url, kind, ext, mime, size, title }
 * @param {string|null} fileHandleKey - IndexedDB 中的句柄 key，可能为 null
 * @returns {Promise<{method: 'direct'|'offscreen', taskId?: string, suggestedName?: string}>}
 */
export async function startDownload(resource, fileHandleKey, sourceTabId = null) {
  const streamType = adaptiveStreamType(resource);
  resource = normalizeAdaptiveStreamOutput(resource);
  const AdapterClass = getAdapterForUrl(resource.url);
  const adapter = AdapterClass ? new AdapterClass() : null;
  const fileName = resource.organizedPath || buildFileName(resource.url, resource.title, resource.ext);
  const conflictStrategy = resource.conflictStrategy || 'uniquify';
  const taskId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 没有 fileHandleKey 的小文件/未知大小文件 → 直接 chrome.downloads.download()
  // 防盗链站点（dm5.com 等）首次会 403 失败，由
  // handleDirectDownloadCompletion 切换到 DNR + offscreen/fetch。
  //   无防盗链站点零开销、行为不变（一次成功）。
  // 有 fileHandleKey 时不走这条路径（已经选好文件了，直接 offscreen 写入）
  // size < 0（未知大小）也走这条路径——图片等资源嗅探时往往不知道大小，
  // chrome.downloads.download() 本身能正确处理任意大小（浏览器原生流式下载）
  if (!streamType && !fileHandleKey && (resource.size < 0 || resource.size < SMALL_FILE_THRESHOLD)) {
    try {
      const prepared = await prepareChromeDownload({
        url: resource.url,
        filename: fileName,
        saveAs: false,
      }, conflictStrategy);
      if (prepared.skipped) {
        await upsertTask({
          id: taskId,
          url: resource.url,
          fileName,
          kind: resource.kind,
          size: resource.size,
          status: 'done',
          skipped: true,
          downloaded: 0,
          total: resource.size,
          speed: 0,
          eta: 0,
          error: '同名文件已存在，已跳过',
          createdAt: Date.now(),
          completedAt: Date.now(),
          tabId: sourceTabId,
        });
        return { method: 'skipped', taskId };
      }
      // 原子地“先监听、后下载”；completion 会保存已到达的终态，
      // 所以后续 upsertTask 的异步写入不会再造成事件丢失。
      const attempt = startDownloadAndWait(prepared.options);
      const startResult = await attempt.started;
      if (startResult.downloadId === null) {
        throw new Error(startResult.error || 'chrome.downloads.download 启动失败');
      }

      // 记录任务（状态为 downloading，由异步监听器更新到 done/failed）
      const task = {
        id: taskId,
        url: resource.url,
        fileName,
          kind: resource.kind,
          size: resource.size,
          conflictStrategy,
          status: 'downloading',
        downloaded: 0,
        total: resource.size,
        speed: 0,
        eta: -1,
        error: null,
        createdAt: Date.now(),
        completedAt: null,
        tabId: sourceTabId,
      };
      await upsertTask(task);

      // 异步监听完成 / 失败重试（不阻塞 SW 返回给 popup）
      // - complete → 任务标记 done
      // - interrupted + SERVER_FORBIDDEN → 切换 offscreen/fetch（DNR 注入 pageUrl Referer）
      // - 其他 interrupted → 任务标记 failed
      handleDirectDownloadCompletion(taskId, attempt.completion, resource, adapter).catch(
        (err) => {
          console.error('[WebGrab] 直接下载监听失败:', err);
          upsertTask({
            id: taskId,
            status: 'failed',
            error: err.message || String(err),
            completedAt: Date.now(),
          });
        }
      );

      return { method: 'direct', taskId };
    } catch (err) {
      // chrome.downloads 调用本身失败（如 URL 无效），回退到 offscreen
      console.warn('[WebGrab] 直接下载启动失败，回退到 offscreen:', err);
    }
  }

  // offscreen 路径：创建任务。HLS/DASH 清单永远不能交给 chrome.downloads
  // 直接保存；必须在这里解析分片、解密/合并并输出 MP4。

  const task = {
    id: taskId,
    url: resource.url,
    fileName,
    kind: resource.kind,
    size: resource.size,
    conflictStrategy,
    status: 'pending',
    downloaded: 0,
    total: resource.size,
    speed: 0,
    eta: -1,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    tabId: sourceTabId,
    streamType,
    streamMeta: resource.streamMeta || null,
    conflictStrategy,
  };
  await upsertTask(task);

  // 异步执行（不阻塞消息响应，SW 能快速返回给 popup）
  // executeWithHandle 内部会：申请 DNR → ensureOffscreen → 发 EXECUTE_TASK 给 offscreen
  // fileHandleKey 可能为 null（API 不可用），此时 offscreen 走 Blob 降级模式
  executeWithHandle(taskId, fileHandleKey, resource, streamType).catch((err) => {
    console.error('[WebGrab] 异步执行下载失败:', err);
  });

  return { method: 'offscreen', taskId, suggestedName: fileName };
}

/**
 * 直接下载（chrome.downloads.download）的完成监听与防盗链 fallback
 *
 * 流程：
 *   1. 消费已在 download() 前建立的终态 Promise（complete / interrupted）
 *   2. 若 interrupted 且 error === SERVER_FORBIDDEN：
 *      - 向 adapter 索要 headers（含来源页 Referer）
 *      - 清理原失败下载项，切换到 executeWithHandle 的 offscreen + fetch 路径
 *      - executeWithHandle 申请 fetch 用 DNR，offscreen 终态更新负责回收
 *   3. 其他终态：在本函数内更新任务为 done / failed
 *
 * 不抛错——所有异常都转化为任务状态更新，确保任务列表始终反映真实状态。
 *
 * @param {string} taskId
 * @param {Promise<{downloadId: number|null, state: string, error?: string}>} firstCompletion
 *        - 首次下载在调用前已建立的终态 Promise
 * @param {Object} resource - 资源对象（含 url、pageUrl 等）
 * @param {Object} adapter - 站点适配器实例（可能为 null）
 * @returns {Promise<void>}
 */
async function handleDirectDownloadCompletion(taskId, firstCompletion, resource, adapter) {
  // ── 第一次等待 ──
  const result = await firstCompletion;
  const downloadId = result.downloadId;
  console.log(`[WebGrab] 直接下载首次终态: taskId=${taskId} state=${result.state} error=${result.error || ''}`);

  // ── 防盗链 fallback：interrupted + SERVER_FORBIDDEN + adapter 有 headers ──
  if (
    result.state === 'interrupted' &&
    result.error === 'SERVER_FORBIDDEN' &&
    adapter
  ) {
    const headers = adapter.requiredHeaders(resource.url, resource.pageUrl);
    if (headers && Object.keys(headers).length > 0) {
      console.log(`[WebGrab] 检测到防盗链 403，切换 offscreen/fetch 下载: taskId=${taskId}`);

      // 清理首次失败的下载项（避免留下错误记录）
      try {
        await chrome.downloads.cancel(downloadId);
      } catch {
        /* ignore */
      }
      try {
        await chrome.downloads.erase({ id: downloadId });
      } catch {
        /* ignore */
      }

      // chrome.downloads.download() 不应用 DNR modifyHeaders；切换到已验证可用的
      // offscreen + fetch 路径。executeWithHandle 负责申请 DNR，并由
      // handleTaskUpdate 在 offscreen 终态后回收，这里不能提前 release。
      try {
        await executeWithHandle(taskId, null, resource, null);
        console.log(`[WebGrab] 防盗链 fallback 已交给 offscreen/fetch: taskId=${taskId}`);
      } catch (e) {
        // executeWithHandle 已负责回收 DNR 并把任务置为 failed。
        console.error('[WebGrab] 防盗链 offscreen/fetch fallback 启动失败:', e);
      }
      return;
    }
  }

  // ── 终态更新 ──
  if (result.state === 'complete') {
    await upsertTask({
      id: taskId,
      status: 'done',
      downloaded: resource.size,
      total: resource.size,
      completedAt: Date.now(),
    });
  } else if (result.state === 'timeout') {
    await upsertTask({
      id: taskId,
      status: 'failed',
      error: '下载超时（5 分钟未完成）',
      completedAt: Date.now(),
    });
  } else {
    const errMsg = `下载失败: ${result.error || 'unknown'}`;
    await upsertTask({
      id: taskId,
      status: 'failed',
      error: errMsg,
      completedAt: Date.now(),
    });
  }
}

/**
 * 启动批量下载任务
 *
 * 用户在资源列表中多选资源后，一次性下载到指定目录。
 * 目录通过 showDirectoryPicker() 选择（仅一次用户授权），
 * 每个文件通过 FileSystemDirectoryHandle.getFileHandle(name, {create:true}) 写入。
 *
 * @param {Array<Object>} resources - 资源列表
 * @param {string} dirHandleKey - IndexedDB 中的目录句柄 key
 * @returns {Promise<{method: 'offscreen', taskId: string}>}
 */
export async function startBatchDownload(resources, dirHandleKey, sourceTabId = null) {
  const taskId = `batch_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // 批量下载从一开始就 100% 走 offscreen + fetch，因此在派发任务前
  // 按完整 headers 分组并主动注册 DNR。同 headers 的多个 CDN 域名共用一条规则。
  try {
    await acquireResourceHeaderRules(taskId, resources);
  } catch (err) {
    // 多分组中途失败时一次性回收已成功注册的所有规则。
    await release(taskId);
    throw err;
  }

  const task = {
    id: taskId,
    url: resources.length > 0 ? resources[0].url : '',
    fileName: `批量下载(${resources.length}个文件)`,
    kind: 'image',
    size: -1,
    status: 'pending',
    downloaded: 0,
    total: resources.length,
    speed: 0,
    eta: -1,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    tabId: sourceTabId,
    streamType: null,
    streamMeta: {
      kind: 'batch',
      resources,
      dirHandleKey,
    },
  };
  try {
    await upsertTask(task);
  } catch (err) {
    await release(taskId);
    throw err;
  }

  // 异步执行
  dispatchOffscreenTask(task, 'offscreen 未接受批量任务').catch(async (err) => {
    console.error('[WebGrab] 批量下载启动失败:', err);
    await release(taskId);
    await upsertTask({ ...task, status: 'failed', error: err.message, completedAt: Date.now() });
  });

  return { method: 'offscreen', taskId };
}

/**
 * 按完整请求头分组，为全部 offscreen fetch 主动申请 DNR。无防盗链适配器返回
 * 空 headers，因此不会产生多余规则。漫画 CBZ 与批量散文件共用此逻辑。
 */
async function acquireResourceHeaderRules(taskId, resources) {
  const headerGroups = new Map();
  for (const resource of resources || []) {
    const AdapterClass = getAdapterForUrl(resource.url);
    const adapter = AdapterClass ? new AdapterClass() : null;
    const headers = adapter ? adapter.requiredHeaders(resource.url, resource.pageUrl) : {};
    if (!headers || Object.keys(headers).length === 0) continue;
    const domains = extractDomains([resource.url]);
    if (domains.length === 0) continue;
    const headerKey = JSON.stringify(Object.keys(headers).sort().map((name) => [name, headers[name]]));
    let group = headerGroups.get(headerKey);
    if (!group) {
      group = { headers, domains: new Set() };
      headerGroups.set(headerKey, group);
    }
    for (const domain of domains) group.domains.add(domain);
  }
  for (const group of headerGroups.values()) {
    await acquire(taskId, { domains: [...group.domains], headers: group.headers });
  }
}

async function dispatchPackageTask(task) {
  await upsertTask(task);
  try {
    await dispatchOffscreenTask(task, 'offscreen 未接受打包任务');
  } catch (error) {
    await release(task.id);
    await upsertTask({ id: task.id, status: 'failed', error: error?.message || String(error), completedAt: Date.now() });
    throw error;
  }
  return { method: 'offscreen', taskId: task.id };
}

/** 启动漫画 CBZ / 文件夹索引打包。 */
export async function startComicPackage({ resources, dirHandleKey, mode, title, source, organizedPath, conflictStrategy, sourceTabId }) {
  if (!Array.isArray(resources) || resources.length === 0) throw new Error('请先选择要打包的图片');
  if (!dirHandleKey) throw new Error('漫画打包缺少目录句柄');
  if (!['cbz', 'folder', 'both'].includes(mode)) throw new Error('漫画输出格式无效');
  const taskId = `comic_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  try {
    await acquireResourceHeaderRules(taskId, resources);
    const task = {
      id: taskId,
      url: source || resources[0]?.pageUrl || '',
      fileName: organizedPath || `${title || '漫画'}${mode === 'folder' ? '（本地阅读文件夹）' : '.cbz'}`,
      kind: 'comic-package',
      size: -1,
      status: 'pending',
      downloaded: 0,
      total: resources.length,
      successCount: 0,
      failureCount: 0,
      speed: 0,
      eta: -1,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
      tabId: sourceTabId,
      streamType: null,
      streamMeta: {
        kind: 'comic-package', resources, dirHandleKey, mode, title, source,
        ...(organizedPath ? { organizedPath } : {}),
        ...(conflictStrategy ? { conflictStrategy } : {}),
      },
    };
    return await dispatchPackageTask(task);
  } catch (error) {
    await release(taskId);
    throw error;
  }
}

/** 从 P4-1 IndexedDB 书库启动 EPUB 3 打包。 */
export async function startEpubPackage({ bookId, fileHandleKey, title, source, chapterCount, organizedPath, conflictStrategy, sourceTabId }) {
  if (!bookId) throw new Error('EPUB 打包缺少 bookId');
  if (!fileHandleKey) throw new Error('EPUB 打包缺少文件句柄');
  const taskId = `epub_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const task = {
    id: taskId,
    url: source || '',
    fileName: organizedPath || `${title || '小说'}.epub`,
    kind: 'epub-package',
    size: -1,
    fileHandleKey,
    status: 'pending',
    downloaded: 0,
    total: chapterCount || 0,
    successCount: 0,
    failureCount: 0,
    speed: 0,
    eta: -1,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    tabId: sourceTabId,
    streamType: null,
    streamMeta: {
      kind: 'epub-package', bookId,
      ...(organizedPath ? { organizedPath } : {}),
      ...(conflictStrategy ? { conflictStrategy } : {}),
    },
  };
  return dispatchPackageTask(task);
}

/**
 * 启动一个全本提取任务。任务对象只保存 bookId 和轻量计数，正文始终留在
 * webgrab_novels IndexedDB 中。
 * @param {Object} bookSummary
 * @returns {Promise<{method:'offscreen', taskId:string, bookId:string}>}
 */
export function startNovelExtraction(bookSummary, sourceTabId = null) {
  const operation = novelStartGate.then(() => startNovelExtractionLocked(bookSummary, sourceTabId));
  novelStartGate = operation.catch(() => {});
  return operation;
}

async function startNovelExtractionLocked(bookSummary, sourceTabId = null) {
  if (!bookSummary?.id) throw new Error('小说任务缺少 bookId');
  const existing = await loadTasks();
  const activeNovel = existing.find(
    (task) => task.kind === 'novel' &&
      ['pending', 'extracting', 'downloading', 'writing'].includes(task.status)
  );
  if (activeNovel) {
    throw new Error('已有一本小说正在提取，请等待完成或先取消当前任务');
  }

  const taskId = `novel_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const task = {
    id: taskId,
    url: bookSummary.source || '',
    fileName: bookSummary.title || '小说正文',
    kind: 'novel',
    size: -1,
    status: 'pending',
    downloaded: 0,
    total: bookSummary.plannedCount || 0,
    successCount: 0,
    failureCount: 0,
    speed: 0,
    eta: -1,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    tabId: sourceTabId,
    streamType: null,
    streamMeta: {
      kind: 'novel',
      bookId: bookSummary.id,
    },
  };
  await upsertTask(task);

  try {
    await dispatchOffscreenTask(task, 'offscreen 未接受小说任务');
  } catch (error) {
    await upsertTask({
      id: taskId,
      status: 'failed',
      error: error?.message || String(error),
      completedAt: Date.now(),
    });
    throw error;
  }
  return { method: 'offscreen', taskId, bookId: bookSummary.id };
}

/**
 * 启动 B 站下载任务
 *
 * B 站任务与普通下载不同：
 *   - 需要同时下载 video + audio 两条流（音视频分离）
 *   - DNR 规则需覆盖所有 m4s URL 的域名（主域 + 备域）
 *   - streamMeta.kind = 'bilibili' 触发 offscreen 的 executeBilibiliTask
 *   - 仅下载音频模式（audioOnly=true）：只下 audio 流，输出 m4a
 *
 * @param {Object} params
 * @param {Object} params.videoVariant - 视频变体 { urls, codecs, segmentBase, width, height, ... }
 * @param {Object} [params.audioVariant] - 音频变体 { urls, codecs, segmentBase, ... }
 * @param {string} params.fileName - 文件名
 * @param {string|null} params.fileHandleKey - IndexedDB 中的句柄 key
 * @param {string} [params.pageUrl] - B 站播放页 URL（用于适配器匹配，可选）
 * @param {boolean} [params.audioOnly] - 仅下载音频
 * @returns {Promise<{method: 'offscreen', taskId: string}>}
 */
export async function startBilibiliDownload(params) {
  const { videoVariant, audioVariant, fileName, fileHandleKey, audioOnly = false, conflictStrategy = 'uniquify' } = params;

  const taskId = `bili_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

  // B 站 CDN 校验 Referer，必须通过 DNR 注入
  const headers = {
    Referer: 'https://www.bilibili.com/',
    Origin: 'https://www.bilibili.com',
  };

  // 收集所有 m4s URL 的域名（video + audio，主 + 备）
  const allUrls = [
    ...(videoVariant ? videoVariant.urls : []),
    ...(audioVariant ? audioVariant.urls : []),
  ];
  const domains = extractDomains(allUrls);

  // 创建任务记录
  const task = {
    id: taskId,
    url: videoVariant ? videoVariant.urls[0] : (audioVariant ? audioVariant.urls[0] : ''),
    fileName,
    kind: audioOnly ? 'audio' : 'video',
    size: -1, // B 站流大小未知，下载时由 HttpFetcher 探测
    status: 'pending',
    downloaded: 0,
    total: -1,
    speed: 0,
    eta: -1,
    error: null,
    createdAt: Date.now(),
    completedAt: null,
    tabId: params.sourceTabId ?? null,
    streamType: null, // B 站不走 hls/dash 路径，走 streamMeta.kind=bilibili
    conflictStrategy,
    streamMeta: {
      kind: 'bilibili',
      videoVariant: audioOnly ? null : videoVariant,
      audioVariant,
      audioOnly,
    },
  };
  await upsertTask(task);

  // 异步执行
  executeBilibiliWithHandle(taskId, fileHandleKey, fileName, headers, domains, task.streamMeta, conflictStrategy).catch((err) => {
    console.error('[WebGrab] B 站下载异步执行失败:', err);
  });

  return { method: 'offscreen', taskId };
}

/**
 * B 站任务的 offscreen 执行（申请 DNR + ensureOffscreen + 发送任务）
 *
 * @param {string} taskId
 * @param {string|null} fileHandleKey - IndexedDB 中的句柄 key
 * @param {string} fileName
 * @param {Object} headers - DNR 注入的请求头 {Referer, Origin}
 * @param {string[]} domains - DNR 作用域域名列表
 * @param {Object} streamMeta - { kind: 'bilibili', videoVariant, audioVariant, audioOnly }
 */
async function executeBilibiliWithHandle(taskId, fileHandleKey, fileName, headers, domains, streamMeta, conflictStrategy = 'uniquify') {
  try {
    // 申请 DNR 规则（Referer/Origin 通过 DNR 注入到 B 站 CDN 域名）
    if (domains.length > 0) {
      await acquire(taskId, { domains, headers });
    }

    // 更新任务状态
    await upsertTask({
      id: taskId,
      status: 'downloading',
      downloaded: 0,
      total: -1,
      speed: 0,
      eta: -1,
      error: null,
    });

    // 发送到 offscreen
    // headers 传空对象：Referer/Origin 属于 forbidden header names，必须通过 DNR 注入
    await dispatchOffscreenTask({
      id: taskId,
      url: streamMeta.videoVariant ? streamMeta.videoVariant.urls[0]
                                   : (streamMeta.audioVariant ? streamMeta.audioVariant.urls[0] : ''),
      backupUrls: [],
      fileName,
      kind: streamMeta.audioOnly ? 'audio' : 'video',
      size: -1,
      fileHandleKey,
      headers: {},
      streamType: null,
      streamMeta,
      conflictStrategy,
    }, 'offscreen 未接受 B 站任务');
  } catch (err) {
    // 任何步骤失败：回收 DNR、更新任务状态为 failed
    await release(taskId);
    await upsertTask({
      id: taskId,
      status: 'failed',
      error: err.message || String(err),
      completedAt: Date.now(),
    });
    throw err;
  }
}

/**
 * 使用文件句柄执行 offscreen 下载
 * @param {string} taskId
 * @param {string|null} fileHandleKey - IndexedDB 中的句柄 key
 * @param {Object} resource - 资源信息
 * @param {string|null} [streamType] - 流媒体类型 "hls"|"dash"|null
 */
export async function executeWithHandle(taskId, fileHandleKey, resource, streamType = null) {
  const AdapterClass = getAdapterForUrl(resource.url);
  const adapter = AdapterClass ? new AdapterClass() : null;
  const headers = adapter ? adapter.requiredHeaders(resource.url, resource.pageUrl) : {};
  const needsDnr = headers && Object.keys(headers).length > 0;
  const fileName = resource.organizedPath || buildFileName(resource.url, resource.title, resource.ext);

  try {
    // 申请 DNR 规则（Referer/Origin/User-Agent 等通过 DNR 注入）
    if (needsDnr) {
      const domains = extractDomains([resource.url]);
      await acquire(taskId, { domains, headers });
    }

    // 更新任务状态
    await upsertTask({
      id: taskId,
      url: resource.url,
      fileName,
      kind: resource.kind,
      size: resource.size,
      status: 'downloading',
      downloaded: 0,
      total: resource.size,
      speed: 0,
      eta: -1,
      error: null,
      createdAt: Date.now(),
      completedAt: null,
    });

    // 发送到 offscreen
    // headers 传空对象：Referer/Origin/UA 属于 forbidden header names，
    // fetch() 无法直接设置，必须通过 DNR 注入；offscreen 中的 fetch 会被 DNR 规则覆盖
    await dispatchOffscreenTask({
      id: taskId,
      url: resource.url,
      backupUrls: Array.isArray(resource.backupUrls) ? resource.backupUrls : [],
      fileName,
      kind: resource.kind,
      size: resource.size,
      fileHandleKey,
      headers: {},
      streamType,
      streamMeta: resource.streamMeta || null,
      conflictStrategy: resource.conflictStrategy || 'uniquify',
    }, 'offscreen 未接受下载任务');
  } catch (err) {
    // 任何步骤失败：回收 DNR、更新任务状态为 failed
    await release(taskId);
    await upsertTask({
      id: taskId,
      status: 'failed',
      error: err.message || String(err),
      completedAt: Date.now(),
    });
    throw err;
  }
}

/**
 * 取消任务
 * @param {string} taskId
 */
export async function cancelTask(taskId) {
  // SW 可能在长任务期间重启，此时内存态 offscreenExists 会丢失；先从
  // Chrome 查询真实上下文，避免用户点击取消却没有通知仍在运行的 offscreen。
  if (!offscreenExists) {
    try {
      const contexts = await chrome.runtime.getContexts({
        contextTypes: ['OFFSCREEN_DOCUMENT'],
      });
      offscreenExists = contexts.length > 0;
    } catch {
      // 旧版 Chrome 无 getContexts 时沿用内存态。
    }
  }
  // 通知 offscreen 取消
  if (offscreenExists) {
    try {
      await chrome.runtime.sendMessage({
        type: 'CANCEL_TASK',
        target: 'offscreen',
        taskId,
      });
    } catch {
      // offscreen 可能已关闭
    }
  }

  // 释放 DNR
  await release(taskId);

  // 更新任务状态
  await upsertTask({
    id: taskId,
    status: 'canceled',
    completedAt: Date.now(),
  });

}

/**
 * 获取所有任务
 * @returns {Promise<Object[]>}
 */
export async function getTasks() {
  return loadTasks();
}

/**
 * 删除任务记录
 * @param {string} taskId
 */
export async function deleteTask(taskId) {
  await removeTask(taskId);
}

/**
 * 处理来自 offscreen 的任务状态更新
 * @param {Object} task
 */
export async function handleTaskUpdate(task) {
  await upsertTask(task);

  // 终态处理
  const isTerminal = ['done', 'failed', 'canceled'].includes(task.status);
  if (isTerminal) {
    // 释放 DNR 规则
    await release(task.id);

  }
}

/**
 * 处理 Blob 下载请求（offscreen 中小文件无文件句柄时）
 *
 * 必须等到真正落盘完成才算成功并把结果回给 offscreen：
 * 这是降级路径唯一的落盘动作，吞掉失败会让任务显示"已完成"而磁盘上没有文件。
 * 等待期间 blob URL 也保持有效（offscreen 文档还没被回收）。
 *
 * @param {string} taskId
 * @param {string} url - blob URL
 * @param {string} fileName
 * @returns {Promise<{skipped?: boolean, downloadId?: number}>}
 * @throws {Error} 启动失败或未能完成时
 */
export async function handleBlobDownload(taskId, url, fileName, conflictStrategy = 'uniquify') {
  const prepared = await prepareChromeDownload({
    url,
    filename: fileName,
    saveAs: false, // 已经选过保存位置或由浏览器决定
  }, conflictStrategy);
  if (prepared.skipped) return { skipped: true };

  const attempt = startDownloadAndWait(prepared.options);
  const startResult = await attempt.started;
  if (startResult.downloadId === null) {
    throw new Error(startResult.error || 'Blob 保存启动失败');
  }

  const result = await attempt.completion;
  if (result.state !== 'complete') {
    throw new Error(
      result.state === 'timeout'
        ? 'Blob 保存超时（5 分钟未完成）'
        : `Blob 保存失败: ${result.error || result.state}`
    );
  }
  return { downloadId: result.downloadId };
}

/**
 * 处理 offscreen 就绪通知
 */
export function handleOffscreenReady() {
  if (offscreenReadyResolve) {
    offscreenReadyResolve();
  }
}

/**
 * 初始化：清理遗留 DNR 规则
 */
export async function init() {
  await cleanupAll();
}

// ─── 辅助函数 ──────────────────────────────────────────────

/**
 * 从 URL 列表提取域名
 * @param {string[]} urls
 * @returns {string[]}
 */
function extractDomains(urls) {
  const domains = new Set();
  for (const url of urls) {
    try {
      const u = new URL(url);
      domains.add(u.hostname);
    } catch {
      // 忽略无效 URL
    }
  }
  return Array.from(domains);
}
