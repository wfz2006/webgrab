import { getResourcesByTab } from './resource-store.js';
import { getTasks } from './download-manager.js';

const ACTIVE_STATUSES = new Set(['pending', 'downloading', 'extracting', 'writing', 'packing']);

function clamp01(value) {
  return Math.max(0, Math.min(1, Number.isFinite(value) ? value : 0));
}

export function getTaskPresentation(task = {}) {
  const status = String(task.status || 'idle');
  let phase = 'idle';
  if (status === 'extracting') phase = 'scanning';
  else if (['pending', 'downloading', 'writing', 'packing'].includes(status)) phase = 'downloading';
  else if (status === 'done') phase = 'done';
  else if (status === 'failed') phase = 'error';
  const total = Number(task.total);
  const completed = Number.isFinite(Number(task.downloaded)) ? Number(task.downloaded) : Number(task.successCount || 0);
  const progress = total > 0 ? clamp01(completed / total) : 0;
  return {
    phase,
    progress,
    error: typeof task.error === 'string' ? task.error : '',
    taskId: typeof task.id === 'string' ? task.id : '',
    status,
  };
}

export function selectTabTask(tasks, tabId) {
  const matching = (Array.isArray(tasks) ? tasks : []).filter((task) => Number(task.tabId) === Number(tabId));
  matching.sort((a, b) => {
    const activeDelta = Number(ACTIVE_STATUSES.has(b.status)) - Number(ACTIVE_STATUSES.has(a.status));
    if (activeDelta) return activeDelta;
    return Number(b.updatedAt || b.completedAt || b.createdAt || 0) - Number(a.updatedAt || a.completedAt || a.createdAt || 0);
  });
  return matching[0] || null;
}

export async function buildCompanionSnapshot(tabId) {
  const [resources, tasks] = await Promise.all([getResourcesByTab(tabId), getTasks()]);
  const task = selectTabTask(tasks, tabId);
  return {
    tabId,
    resourceCount: resources.length,
    resourceEvent: false,
    ...(task ? getTaskPresentation(task) : getTaskPresentation()),
  };
}

async function sendSnapshot(tabId, snapshot) {
  if (!Number.isInteger(tabId) || tabId < 0) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'COMPANION_STATE', snapshot }, { frameId: 0 });
  } catch {
    // 页面可能尚未加载 content script，或是 chrome:// 等不可注入页面。
  }
}

export async function publishResourceCount(tabId, count, options = {}) {
  const tasks = await getTasks();
  const task = selectTabTask(tasks, tabId);
  await sendSnapshot(tabId, {
    tabId,
    resourceCount: Math.max(0, Number(count) || 0),
    resourceEvent: options.found === true,
    ...(task ? getTaskPresentation(task) : getTaskPresentation()),
  });
}

export async function publishTaskState(task) {
  const tabId = Number(task?.tabId);
  if (!Number.isInteger(tabId) || tabId < 0) return;
  const resources = await getResourcesByTab(tabId);
  await sendSnapshot(tabId, {
    tabId,
    resourceCount: resources.length,
    resourceEvent: false,
    ...getTaskPresentation(task),
  });
}
