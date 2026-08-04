/**
 * 右键菜单 —— 在图片/视频/音频上提供"用 WebGrab 下载"
 *
 * 点击后先把资源登记进 resource-store（跟正常嗅探到的资源共用同一份去重表和
 * badge 计数），再直接复用 download-manager.startDownload 发起下载——
 * 和 popup 里点下载按钮走的是同一条后端路径，只是路径规划在 SW 里做
 * （右键菜单没有 popup 上下文，没有 window.showDirectoryPicker 可用）。
 */
import { createPathContext, buildOrganizedPath } from '../lib/path-planner.js';
import { loadPathSettings } from '../lib/path-settings.js';
import { addResource } from './resource-store.js';
import * as downloadManager from './download-manager.js';

const MENU_ID = 'webgrab-context-download';

export function registerContextMenu() {
  if (!chrome.contextMenus) return;
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: chrome.i18n?.getMessage?.('contextMenuDownload') || '用 WebGrab 下载',
      contexts: ['image', 'video', 'audio'],
    });
  });
}

function kindFromMediaType(mediaType) {
  if (mediaType === 'image' || mediaType === 'video' || mediaType === 'audio') return mediaType;
  return 'other';
}

function extractExt(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf('.');
    return dot === -1 ? '' : pathname.slice(dot + 1).toLowerCase().split(/[?#]/)[0];
  } catch {
    return '';
  }
}

function extractFileName(url) {
  try {
    const pathname = new URL(url).pathname;
    const slash = pathname.lastIndexOf('/');
    return decodeURIComponent(slash !== -1 ? pathname.slice(slash + 1) : pathname) || 'download';
  } catch {
    return url.split('/').pop() || 'download';
  }
}

/** 路径模板会另外拼一次 {ext}，标题里不能带扩展名，否则文件名变成 "x.png.png"。 */
function titleWithoutExtension(value) {
  return String(value || 'download').replace(/\.[a-z0-9]{2,8}$/i, '');
}

export async function handleContextMenuClick(info, tab) {
  if (info.menuItemId !== MENU_ID || !info.srcUrl) return;

  const url = info.srcUrl;
  const tabId = tab?.id ?? -1;
  const pageUrl = info.pageUrl || tab?.url || '';
  const kind = kindFromMediaType(info.mediaType);
  const ext = extractExt(url);
  const title = extractFileName(url);

  await addResource({
    url,
    kind,
    ext,
    mime: '',
    size: -1,
    tabId,
    frameId: 0,
    pageUrl,
    source: 'network',
    title,
    discoveredAt: Date.now(),
  }).catch(() => {});

  const pathSettings = await loadPathSettings();
  const context = createPathContext({
    type: ['video', 'audio', 'image'].includes(kind) ? kind : 'other',
    url,
    pageUrl,
    source: pageUrl,
    title: titleWithoutExtension(title),
    ext: ext || 'bin',
  });
  const organizedPath = buildOrganizedPath(context, pathSettings);

  await downloadManager.startDownload({
    url,
    kind,
    ext,
    mime: '',
    size: -1,
    title,
    pageUrl,
    organizedPath,
    conflictStrategy: pathSettings.conflictStrategy,
  }, null, tabId);
}
