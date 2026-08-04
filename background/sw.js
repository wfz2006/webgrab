/**
 * Service Worker 入口 —— 事件注册与消息路由
 *
 * MV3 约束：SW 30 秒无事件即被终止，全局变量随时丢失。
 * 所有跨事件状态由 resource-store.js 写入 chrome.storage.session。
 * 下载状态由 download-manager.js 写入 chrome.storage.local。
 */

import { initSniffer, disposeTab as disposeSnifferTab } from './sniffer-network.js';
import {
  addResource,
  getResourcesByTab,
  clearTab,
  restoreFromStorage,
  updateBadge,
  getStatsByTab,
  setResourceChangeListener,
} from './resource-store.js';
import { routeByTab, getAdapterForUrl } from './adapter-router.js';
import * as downloadManager from './download-manager.js';
import * as novelManager from './novel-manager.js';
import { prepareChromeDownload } from '../lib/chrome-download-path.js';
import * as companionManager from './companion-manager.js';
import { registerContextMenu, handleContextMenuClick } from './context-menu.js';
import { recoverOpenTabs } from './content-script-recovery.js';

// ─── 初始化 ────────────────────────────────────────────────
initSniffer();
chrome.contextMenus?.onClicked.addListener(handleContextMenuClick);
setResourceChangeListener(({ tabId, count, found }) => companionManager.publishResourceCount(tabId, count, { found }));
downloadManager.setTaskChangeListener((task) => companionManager.publishTaskState(task));

// 从 session storage 恢复资源表（SW 重启后）
restoreFromStorage().catch((err) => {
  console.error('[WebGrab] 恢复资源表失败:', err);
});

// 清理遗留 DNR 规则（SW 重启后）
downloadManager.init().catch((err) => {
  console.error('[WebGrab] DNR 清理失败:', err);
});

// ─── 标签页生命周期 ──────────────────────────────────────────
chrome.tabs.onRemoved.addListener((tabId) => {
  clearTab(tabId);
  disposeSnifferTab(tabId);
});

// 导航到新页面时清理旧资源（同标签页内导航）
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url) {
    clearTab(tabId);
  }
  if (changeInfo.status === 'complete' && tab.url) {
    routeByTab(tabId, tab.url).catch(() => {});
  }
});

// SPA 历史导航兜底
if (chrome.webNavigation?.onHistoryStateUpdated) {
  chrome.webNavigation.onHistoryStateUpdated.addListener((details) => {
    if (details.frameId === 0) {
      clearTab(details.tabId);
    }
  });
}

// ─── 消息路由 ──────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // 跳过发给其他上下文的消息
  if (message.target && message.target !== 'sw') return;

  handleMessage(message, sender)
    .then((result) => sendResponse({ ok: true, data: result }))
    .catch((err) => {
      console.error('[WebGrab] 消息处理错误:', err);
      sendResponse({ ok: false, error: err.message || String(err) });
    });
  return true; // 异步响应
});

/**
 * 处理各类消息
 * @param {any} message
 * @param {chrome.runtime.MessageSender} sender
 */
async function handleMessage(message, sender) {
  const tabId = sender.tab?.id ?? message.tabId;

  switch (message.type) {
    // ── L3 hook 消息 ──
    case 'HOOK_READY':
      console.log('[WebGrab] Hook 已安装:', message.url);
      return { ok: true };

    case 'DOM_RESOURCES': {
      const { resources } = message;
      for (const res of resources) {
        await addResource({
          ...res,
          tabId,
          frameId: sender.frameId ?? 0,
          pageUrl: sender.tab?.url ?? '',
          source: 'dom',
        });
      }
      return { count: resources.length };
    }

    case 'HOOK_RESOURCE': {
      await addResource({
        ...message.resource,
        tabId,
        frameId: sender.frameId ?? 0,
        pageUrl: sender.tab?.url ?? '',
        source: 'hook',
      });
      return { ok: true };
    }

    case 'HOOK_SOURCE_BUFFER':
      console.log(
        `[WebGrab] SourceBuffer 创建: tab=${tabId} mime=${message.mimeType} url=${message.url ?? 'N/A'}`
      );
      return { ok: true };

    case 'HOOK_BUFFER_STATS':
      console.log(
        `[WebGrab] Buffer 统计: tab=${tabId} mime=${message.mimeType} size=${message.totalBytes} chunks=${message.chunkCount}`
      );
      return { ok: true };

    // ── P0 资源列表 ──
    case 'GET_RESOURCES': {
      const resources = await getResourcesByTab(message.tabId);
      return { resources };
    }

    case 'GET_STATS': {
      const stats = await getStatsByTab(message.tabId);
      return { stats };
    }

    case 'COMPANION_GET_STATE':
      return companionManager.buildCompanionSnapshot(tabId);

    case 'CLEAR_TAB': {
      clearTab(message.tabId);
      return { ok: true };
    }

    case 'REFRESH_BADGE': {
      await updateBadge(message.tabId);
      return { ok: true };
    }

    // ── P1 下载 ──
    case 'START_DOWNLOAD': {
      const result = await downloadManager.startDownload(
        message.resource,
        message.fileHandleKey,
        tabId
      );
      return result;
    }

    // ── P3 B 站深度适配 ──
    case 'GET_EXTRACT': {
      // 让适配器从页面提取结构化媒体信息（分 P、清晰度、编码等）
      const AdapterClass = getAdapterForUrl(message.pageUrl);
      if (!AdapterClass) return { supported: false };
      const adapter = new AdapterClass();
      const result = await adapter.extract(message.tabId, message.pageUrl);
      return result;
    }

    case 'PROBE_UPDATE': {
      // 探针通知页面 __playinfo__ 已更新（分 P 切换）
      // popup 会按需手动刷新，这里只需确认收到
      return { ok: true };
    }

    case 'SWITCH_BILI_PART': {
      // popup 请求切换到目标分 P
      // SW 负责：chrome.tabs.update 导航 → 轮询 probe 等待 currentCid 匹配 → 返回新 extract 数据
      // 竞态处理：用 currentSwitchRequestId 标识最新请求，旧请求的轮询循环检测到被覆盖后静默退出
      const { tabId, targetUrl, targetCid, requestId } = message;
      const result = await switchBiliPart(tabId, targetUrl, targetCid, requestId);
      return result;
    }

    case 'PROBE_READY': {
      // 探针已安装，确认收到即可（与 PROBE_UPDATE 同级）
      return { ok: true };
    }

    case 'START_BILIBILI_DOWNLOAD': {
      const result = await downloadManager.startBilibiliDownload({
        videoVariant: message.videoVariant,
        audioVariant: message.audioVariant,
        fileName: message.organizedPath || message.fileName,
        fileHandleKey: message.fileHandleKey,
        pageUrl: message.pageUrl,
        audioOnly: message.audioOnly,
        conflictStrategy: message.conflictStrategy,
        sourceTabId: tabId,
      });
      return result;
    }

    case 'START_BATCH_DOWNLOAD': {
      const result = await downloadManager.startBatchDownload(
        message.resources,
        message.dirHandleKey,
        tabId
      );
      return result;
    }

    case 'START_COMIC_PACKAGE':
      return downloadManager.startComicPackage({
        resources: message.resources,
        dirHandleKey: message.dirHandleKey,
        mode: message.mode,
        title: message.title,
        source: message.source,
        organizedPath: message.organizedPath,
        conflictStrategy: message.conflictStrategy,
        sourceTabId: tabId,
      });

    case 'START_EPUB_PACKAGE':
      return downloadManager.startEpubPackage({
        bookId: message.bookId,
        fileHandleKey: message.fileHandleKey,
        title: message.title,
        source: message.source,
        chapterCount: message.chapterCount,
        organizedPath: message.organizedPath,
        conflictStrategy: message.conflictStrategy,
        sourceTabId: tabId,
      });

    // ── P4-1 小说 / 长文本按需提取 ──
    case 'NOVEL_DETECT':
      return novelManager.detectNovelPage(message.tabId);

    case 'NOVEL_EXTRACT_CHAPTER':
      return novelManager.extractCurrentChapter(message.tabId, message.pageUrl);

    case 'NOVEL_PREPARE_FULL':
      return novelManager.prepareFullNovel({
        source: message.pageUrl,
        catalogUrl: message.catalogUrl,
        pageTitle: message.pageTitle,
        catalogChapters: message.catalogChapters || null,
      });

    case 'NOVEL_START_FULL':
      return novelManager.startFullNovel(message.bookId, tabId);

    case 'NOVEL_DISCARD_PREPARED':
      return novelManager.discardPreparedNovel(message.bookId);

    case 'NOVEL_GET_BOOK_STATUS':
      return novelManager.getNovelBookStatus(message.bookId);

    case 'BATCH_FALLBACK_DOWNLOAD': {
      // 批量下载中 fetch 失败时的备用路径：用 chrome.downloads.download() 下载
      // chrome.downloads.download() 不受 COEP 限制，能下载 fetch() 无法访问的跨域资源
      // 文件存到默认下载目录的 WebGrab_Batch/ 子文件夹
      try {
        const prepared = await prepareChromeDownload({
          url: message.url,
          filename: message.organizedPath || `WebGrab_Batch/${message.filename}`,
          saveAs: false,
        }, message.conflictStrategy || 'uniquify');
        if (prepared.skipped) return { success: true, skipped: true };
        const downloadId = await new Promise((resolve, reject) => {
          chrome.downloads.download(
            prepared.options,
            (id) => {
              if (chrome.runtime.lastError) {
                reject(new Error(chrome.runtime.lastError.message));
              } else {
                resolve(id);
              }
            }
          );
        });

        // 等待下载完成（chrome.downloads.onChanged 事件保持 SW 存活）
        const completed = await new Promise((resolve) => {
          const handler = (delta) => {
            if (delta.id === downloadId) {
              if (delta.state && (delta.state.current === 'complete' || delta.state.current === 'interrupted')) {
                chrome.downloads.onChanged.removeListener(handler);
                resolve(delta.state.current === 'complete');
              }
            }
          };
          chrome.downloads.onChanged.addListener(handler);
          // 超时保护（60秒）
          setTimeout(() => {
            chrome.downloads.onChanged.removeListener(handler);
            resolve(false);
          }, 60000);
        });

        if (completed) {
          return { ok: true };
        } else {
          return { ok: false, error: '备用下载未完成或超时' };
        }
      } catch (err) {
        return { ok: false, error: err.message || String(err) };
      }
    }

    case 'DOWNLOAD_FILE_HANDLE': {
      // 兼容旧路径（popup 已不再发送此消息，fileHandleKey 在 START_DOWNLOAD 时一并传入）
      await downloadManager.executeWithHandle(
        message.taskId,
        message.fileHandleKey,
        message.resource
      );
      return { ok: true };
    }

    case 'CANCEL_TASK': {
      await downloadManager.cancelTask(message.taskId);
      return { ok: true };
    }

    case 'GET_TASKS': {
      const tasks = await downloadManager.getTasks();
      return { tasks };
    }

    case 'DELETE_TASK': {
      await downloadManager.deleteTask(message.taskId);
      return { ok: true };
    }

    // ── 来自 offscreen ──
    case 'OFFSCREEN_READY': {
      downloadManager.handleOffscreenReady();
      return { ok: true };
    }

    case 'TASK_UPDATE': {
      // 先广播给所有扩展页面（popup/悬浮窗），不等待磁盘持久化完成。
      // message.task 已是完整任务对象（queue.js 的 stripInternal 产出），广播不依赖持久化结果。
      // 持久化写入 chrome.storage.local 时会串行排队（taskWriteGate），
      // 并发下载多时排队会有几十毫秒到上百毫秒延迟；若等它完成再广播，
      // 进度条会被"其他任务的写入排队"卡住，即使当前任务下载本身很顺畅。
      chrome.runtime.sendMessage({
        type: 'TASK_BROADCAST',
        target: 'popup',
        task: message.task,
      }).catch(() => {
        // 没有接收方时会报错，忽略
      });
      await downloadManager.handleTaskUpdate(message.task);
      return { ok: true };
    }

    case 'BLOB_DOWNLOAD': {
      await downloadManager.handleBlobDownload(
        message.taskId,
        message.url,
        message.fileName,
        message.conflictStrategy
      );
      return { ok: true };
    }

    default:
      throw new Error(`未知消息类型: ${message.type}`);
  }
}

// ─── 安装/更新 ──────────────────────────────────────────────
chrome.runtime.onInstalled.addListener((details) => {
  registerContextMenu();
  recoverOpenTabs()
    .then((summary) => console.log('[WebGrab] 已打开标签页自愈注入完成:', summary))
    .catch((error) => console.warn('[WebGrab] 查询已打开标签页失败，跳过自愈注入:', error));
  if (details.reason === 'install') {
    console.log('[WebGrab] 首次安装，版本:', chrome.runtime.getManifest().version);
    chrome.tabs.create({ url: chrome.runtime.getURL('ui/onboarding.html') }).catch(() => {});
  }
  chrome.storage.local.get('settings').then((result) => {
    if (!result.settings) {
      chrome.storage.local.set({
        settings: {
          minImageSize: 10,
          minVideoSize: 100,
          minAudioSize: 30,
          concurrency: 4,
          showHookResources: true,
        },
      });
    }
  });
});

// ─── B 站分 P 切换 ──────────────────────────────────────────
//
// 流程：chrome.tabs.update 导航到目标分 P URL → 轮询 PROBE_GET_DATA 等 currentCid 匹配
// → 匹配后调 adapter.extract 转成最终格式返回给 popup。
//
// 合规：chrome.tabs.update 是浏览器原生导航（用户手打地址栏效果相同），
// 不发任何接口请求；probe 只读页面已产生的 __playinfo__/__INITIAL_STATE__。
//
// 竞态：popup 每次发起切换带递增 requestId，SW 维护 currentSwitchRequestId。
// 旧请求的轮询循环检测到 requestId 不匹配后静默退出（返回 { ok: false, error: 'superseded' }）。
// chrome.tabs.update 是覆盖式的，后一次导航会覆盖前一次，页面最终停在最新目标 URL。

/** 当前最新的切换请求 ID（用于竞态控制） */
let currentSwitchRequestId = 0;

/** 分 P 切换总超时（覆盖 SPA 路由 + __playinfo__ 注入 + 网络请求的合理窗口） */
const SWITCH_PART_TIMEOUT = 8000;

/** 轮询间隔 */
const SWITCH_POLL_INTERVAL = 500;

/**
 * 切换 B 站分 P 并等待新播放清单就绪
 *
 * 返回值约定：遵循其他 handler 的约定（如 GET_EXTRACT），成功返回裸 extract 结果，
 * 失败 throw Error。onMessage wrapper 会统一包装成 { ok: true, data: result } 或
 * { ok: false, error: err.message }。被覆盖（superseded）时也 throw，popup 侧的
 * switchingPart.requestId 检查会提前拦截。
 *
 * @param {number} tabId - 目标标签页
 * @param {string} targetUrl - 目标分 P 的 URL（含 ?p=N）
 * @param {number} targetCid - 目标分 P 的 cid
 * @param {number} requestId - popup 生成的请求 ID，用于竞态控制
 * @returns {Promise<Object>} extract 结果（成功时）
 * @throws {Error} 超时、导航失败或被覆盖时
 */
async function switchBiliPart(tabId, targetUrl, targetCid, requestId) {
  // 标记为最新请求（覆盖前一个）
  currentSwitchRequestId = requestId;

  // 1. 触发浏览器导航（不是接口请求，是正常页面跳转）
  try {
    await chrome.tabs.update(tabId, { url: targetUrl });
  } catch (err) {
    throw new Error(`导航失败: ${err.message || err}`);
  }

  // 2. 轮询等待新 probe 数据（currentCid 匹配）
  const start = Date.now();
  while (Date.now() - start < SWITCH_PART_TIMEOUT) {
    // 检查是否被新请求覆盖
    if (currentSwitchRequestId !== requestId) {
      throw new Error('superseded');
    }

    await sleep(SWITCH_POLL_INTERVAL);

    // 再次检查（sleep 后可能已被覆盖）
    if (currentSwitchRequestId !== requestId) {
      throw new Error('superseded');
    }

    try {
      // 直接向 probe 请求原始数据，检查 currentCid
      // frameId: 0 只发给主 frame（probe 只在主 frame 运行）
      const probeData = await chrome.tabs.sendMessage(
        tabId,
        { type: 'PROBE_GET_DATA' },
        { frameId: 0 }
      );

      // probe 未就绪或返回错误 → 继续轮询
      if (!probeData || probeData.error) continue;

      // 检查 currentCid 是否匹配目标分 P
      // 注意：导航后页面重新加载，旧 probe 实例被销毁，新 probe 实例的 currentCid
      //       来自新 __INITIAL_STATE__，匹配说明新页面已就绪
      if (probeData.currentCid === targetCid) {
        // currentCid 匹配，用 adapter 转成最终格式
        // 此时 probe 缓存已就绪，adapter.extract 内部的 PROBE_GET_DATA 会立即返回
        const AdapterClass = getAdapterForUrl(targetUrl);
        if (!AdapterClass) {
          throw new Error('目标 URL 不是 B 站视频页');
        }
        const adapter = new AdapterClass();
        const extractResult = await adapter.extract(tabId, targetUrl);
        return extractResult;
      }
      // currentCid 不匹配（页面还在加载或返回了旧缓存）→ 继续轮询
    } catch (err) {
      // chrome.tabs.sendMessage 失败（probe 未注入、页面还在加载）→ 继续轮询
      // 注意：这里不 catch throw 的 superseded 错误，因为 throw 会跳出 while
      if (err.message === 'superseded') throw err;
    }
  }

  // 3. 超时
  throw new Error('切换分 P 超时，请手动在页面上点击该分 P 后重试');
}

/**
 * Promise 版 setTimeout
 * @param {number} ms
 * @returns {Promise<void>}
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
