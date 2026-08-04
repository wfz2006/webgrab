/**
 * P4-1 小说功能的 Service Worker 编排层。
 */

import { getBook, getNovel, saveSingleChapter } from '../lib/novel-store.js';
import { ensureOffscreen, startNovelExtraction } from './download-manager.js';

const TAB_MESSAGE_TIMEOUT_MS = 8000;

async function sendTab(tabId, message) {
  const operation = message?.type === 'NOVEL_EXTRACT_CURRENT' ? '正文提取' : '页面检测';
  let timeoutId = null;
  try {
    const response = await Promise.race([
      chrome.tabs.sendMessage(tabId, message, { frameId: 0 }),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          reject(new Error(`${operation}超时，可能是页面结构过于复杂`));
        }, TAB_MESSAGE_TIMEOUT_MS);
      }),
    ]);
    if (!response?.ok) throw new Error(response?.error || '页面正文脚本未响应');
    return response.data;
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

async function sendOffscreen(message) {
  await ensureOffscreen();
  const response = await chrome.runtime.sendMessage({ ...message, target: 'offscreen' });
  if (!response?.ok) throw new Error(response?.error || 'offscreen 操作失败');
  return response.data;
}

export async function detectNovelPage(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('缺少当前标签页');
  return sendTab(tabId, { type: 'NOVEL_DETECT_PAGE' });
}

export async function extractCurrentChapter(tabId, source) {
  if (!Number.isInteger(tabId) || tabId < 0) throw new Error('缺少当前标签页');
  await chrome.scripting.executeScript({
    target: { tabId, frameIds: [0] },
    files: ['lib/readability.js'],
    world: 'ISOLATED',
  });
  const chapter = await sendTab(tabId, { type: 'NOVEL_EXTRACT_CURRENT' });
  const book = await saveSingleChapter(chapter, source || chapter.url);
  return {
    bookId: book.id,
    title: chapter.title,
    author: chapter.byline,
    source: source || chapter.url,
    wordCount: chapter.wordCount,
    paragraphCount: chapter.paragraphCount,
    preview: chapter.text.slice(0, 240),
    hasMorePages: Boolean(chapter.hasMorePages),
    nextPageUrl: chapter.nextPageUrl || null,
    warning: chapter.warning || null,
    status: 'done',
  };
}

export async function prepareFullNovel(input) {
  if (!input?.source || !input?.catalogUrl) throw new Error('未找到目录页');
  return sendOffscreen({ type: 'NOVEL_PREPARE', input });
}

export async function startFullNovel(bookId, sourceTabId = null) {
  const book = await getBook(bookId);
  if (!book) throw new Error('准备好的小说记录不存在');
  if (book.status !== 'prepared') throw new Error(`小说当前状态不能开始: ${book.status}`);
  return startNovelExtraction(book, sourceTabId);
}

export async function discardPreparedNovel(bookId) {
  return sendOffscreen({ type: 'NOVEL_DISCARD_PREPARED', bookId });
}

export async function getNovelBookStatus(bookId) {
  return summarize(await getBook(bookId));
}

/** P4-2 的直接读取入口；P4-1 UI 不经消息传递正文。 */
export async function getStoredNovel(bookId) {
  return getNovel(bookId);
}

function summarize(book) {
  if (!book) return null;
  const { plan, failures, skippedExternal, ...summary } = book;
  return {
    ...summary,
    failurePreview: (failures || []).slice(0, 20),
    skippedExternalPreview: (skippedExternal || []).slice(0, 20),
  };
}
