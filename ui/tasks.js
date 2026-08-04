/**
 * 任务面板 —— 显示下载任务列表、进度、操作按钮
 *
 * 通过 window.webgrabTasks 暴露 API：
 *   - init(container, { onSwitchToResources })
 *   - refresh()                主动从 SW 拉取任务列表
 *   - upsertTask(task)         增量更新单个任务
 *   - show() / hide()
 *
 * 任务状态：pending / downloading / extracting / writing / done / failed / canceled
 */

(function () {
  'use strict';

  const isNestedFrame = window.self !== window.top;
  const NESTED_RETRY_GUIDANCE = '重试需要重新选择保存位置，悬浮窗里无法弹出选择框，请用工具栏图标或侧边栏打开 WebGrab。';

  /** @type {Map<string, Object>} taskId → task */
  const tasks = new Map();
  /** @type {Map<string, string>} taskId → 用户可见的操作提示 */
  const taskNotices = new Map();

  // ─── handle-store 动态加载 ──────────────────────────────
  // tasks.js 是普通 script（非 ES module），用动态 import() 加载
  // FileSystemFileHandle 必须通过 IndexedDB 跨上下文传递
  let _handleStorePromise = null;
  function getHandleStore() {
    if (!_handleStorePromise) {
      _handleStorePromise = import('../lib/handle-store.js');
    }
    return _handleStorePromise;
  }
  /** @type {HTMLElement|null} */
  let container = null;
  /** @type {HTMLElement|null} */
  let listEl = null;
  /** @type {HTMLElement|null} */
  let emptyEl = null;
  /** @type {HTMLElement|null} */
  let summaryEl = null;
  /** @type {(() => void)|null} */
  let onSwitchToResources = null;
  /** @type {((count: number) => void)|null} */
  let onActiveCountChange = null;
  /** @type {number} */
  let refreshTimer = null;

  /** 与 popup.js 工具栏徽章共用同一份"进行中"判定，两处不再各算一套 */
  const ACTIVE_STATUSES = ['pending', 'downloading', 'writing', 'extracting', 'packing'];

  const STATUS_LABEL = {
    pending: '排队中',
    downloading: '下载中',
    extracting: '提取中',
    writing: '写盘中',
    packing: '打包中',
    done: '已完成',
    failed: '失败',
    canceled: '已取消',
  };

  const STATUS_ICON_PATHS = {
    pending: '<circle cx="12" cy="12" r="8"/><path d="M12 7v5l3 2"/>',
    downloading: '<path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/>',
    extracting: '<path d="M4 5.5A3.5 3.5 0 0 1 7.5 2H11v17H7.5A3.5 3.5 0 0 0 4 22zM20 5.5A3.5 3.5 0 0 0 16.5 2H13v17h3.5A3.5 3.5 0 0 1 20 22z"/>',
    writing: '<path d="M5 3h12l2 2v16H5zM8 3v6h8V3M8 21v-7h8v7"/>',
    packing: '<path d="M4 7h16v14H4zM7 3h10v4M9 11h6"/>',
    done: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
    failed: '<circle cx="12" cy="12" r="9"/><path d="m9 9 6 6m0-6-6 6"/>',
    canceled: '<circle cx="12" cy="12" r="9"/><path d="M8 12h8"/>',
  };

  function statusIconSvg(status) {
    const path = STATUS_ICON_PATHS[status] || STATUS_ICON_PATHS.pending;
    return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
  }

  // ─── 初始化 ──────────────────────────────────────────────

  /**
   * 初始化任务面板
   * @param {HTMLElement} root - 任务面板根容器
   * @param {{ onSwitchToResources?: () => void }} [callbacks]
   */
  function init(root, callbacks) {
    container = root;
    onSwitchToResources = callbacks?.onSwitchToResources || null;
    onActiveCountChange = callbacks?.onActiveCountChange || null;

    // 构建面板骨架
    container.innerHTML = `
      <div class="task-summary" id="task-summary">
        <span class="task-summary-text" id="task-summary-text">共 0 个任务</span>
        <button class="task-clear-done" id="task-clear-done" title="清空已完成/已取消">清空</button>
      </div>
      <div class="task-list" id="task-list"></div>
      <div class="task-empty" id="task-empty">
        <svg width="48" height="48" viewBox="0 0 48 48" fill="none" opacity="0.3">
          <path d="M24 6v24m0 0l8-8m-8 8l-8-8M8 38h32" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <p>暂无任务</p>
        <p class="hint">下载与正文提取任务会显示在这里</p>
      </div>
    `;

    listEl = document.getElementById('task-list');
    emptyEl = document.getElementById('task-empty');
    summaryEl = document.getElementById('task-summary-text');

    document.getElementById('task-clear-done').addEventListener('click', clearFinished);

    // 监听 SW 广播
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'TASK_BROADCAST' && message.task) {
        upsertTask(message.task);
      }
    });

    // 首次拉取
    refresh();
    // 定时兜底刷新（避免遗漏广播）
    refreshTimer = setInterval(refresh, 3000);
  }

  /**
   * 销毁面板
   */
  function destroy() {
    if (refreshTimer) {
      clearInterval(refreshTimer);
      refreshTimer = null;
    }
  }

  // ─── 数据 ──────────────────────────────────────────────

  /**
   * 从 SW 拉取所有任务
   */
  async function refresh() {
    try {
      const response = await chrome.runtime.sendMessage({ type: 'GET_TASKS' });
      if (response && response.ok && response.data) {
        const list = response.data.tasks || [];
        tasks.clear();
        for (const t of list) {
          tasks.set(t.id, t);
        }
        render();
      }
    } catch (err) {
      console.warn('[WebGrab/TaskPanel] 拉取任务失败:', err);
    }
  }

  /**
   * 增量更新单个任务
   * @param {Object} task
   */
  function upsertTask(task) {
    if (!task || !task.id) return;
    const existing = tasks.get(task.id);
    tasks.set(task.id, { ...(existing || {}), ...task });
    renderItem(task.id);
    updateSummary();
  }

  function showTaskNotice(taskId, message) {
    if (!taskId || !message) return;
    taskNotices.set(taskId, message);
    renderItem(taskId);
  }

  // ─── 操作 ──────────────────────────────────────────────

  /**
   * 取消任务
   * @param {string} taskId
   */
  async function cancelTask(taskId) {
    try {
      await chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId });
    } catch (err) {
      console.warn('[WebGrab/TaskPanel] 取消失败:', err);
    }
  }

  /**
   * 删除任务记录
   * @param {string} taskId
   */
  async function deleteTask(taskId) {
    try {
      await chrome.runtime.sendMessage({ type: 'DELETE_TASK', taskId });
      tasks.delete(taskId);
      taskNotices.delete(taskId);
      render();
    } catch (err) {
      console.warn('[WebGrab/TaskPanel] 删除失败:', err);
    }
  }

  /**
   * 重试任务（重新发起下载）
   *
   * 手势保护：showSaveFilePicker 必须在用户手势内调用，
   * 因此点击"重试"按钮后立即调用，再连同 fileHandle 发给 SW。
   *
   * @param {Object} task
   */
  async function retryTask(task) {
    if (isNestedFrame) {
      showTaskNotice(task.id, NESTED_RETRY_GUIDANCE);
      return;
    }
    try {
      // 1. 立即在用户手势内选择文件位置
      const suggestedName = task.fileName || 'download';
      let fileHandle = null;
      let conflictStrategy = task.conflictStrategy || 'uniquify';

      if (typeof window.showDirectoryPicker === 'function') {
        const directoryHandle = await window.showDirectoryPicker();
        const [{ resolveFilePath }, { loadPathSettings }] = await Promise.all([
          import('../lib/file-system-path.js'),
          import('../lib/path-settings.js'),
        ]);
        const settings = await loadPathSettings();
        conflictStrategy = settings.conflictStrategy;
        const resolved = await resolveFilePath(directoryHandle, suggestedName, conflictStrategy);
        if (resolved.skipped) return;
        fileHandle = resolved.fileHandle;
      } else if (typeof window.showSaveFilePicker === 'function') {
        fileHandle = await pickSaveFile(suggestedName);
        if (!fileHandle) return;
      }

      // 2. 把句柄存入 IndexedDB，消息只传 key
      let fileHandleKey = null;
      if (fileHandle) {
        const hs = await getHandleStore();
        fileHandleKey = crypto.randomUUID();
        await hs.putHandle(fileHandleKey, fileHandle);
      }

      // 3. 删除旧的失败任务
      if (task.id) {
        try {
          await chrome.runtime.sendMessage({ type: 'DELETE_TASK', taskId: task.id });
        } catch {}
        tasks.delete(task.id);
      }

      // 4. 连同 fileHandleKey 一起发起新的下载
      const response = await chrome.runtime.sendMessage({
        type: 'START_DOWNLOAD',
        tabId: task.tabId,
        resource: {
          url: task.url,
          kind: task.kind,
          ext: (task.fileName || '').split('.').pop(),
          title: task.fileName || '',
          size: task.size || -1,
          organizedPath: task.fileName || suggestedName,
          conflictStrategy,
        },
        fileHandleKey,
      });

      if (response && response.ok) {
        refresh();
      }
    } catch (err) {
      console.warn('[WebGrab/TaskPanel] 重试失败:', err);
    }
  }

  /**
   * 只重试批量任务里失败的文件（跳过已成功的），而不是把整批重新下载一遍。
   *
   * 失败文件列表来自 task.diagnostics（offscreen 逐条记录，含 url/fileName），
   * 反查 task.streamMeta.resources 拿回完整资源对象（kind/ext/mime/pageUrl）；
   * 找不到时退化成用 diagnostics 里的 url/fileName 拼一个最小资源对象。
   *
   * @param {Object} task
   */
  async function retryBatchFailures(task) {
    if (isNestedFrame) {
      showTaskNotice(task.id, NESTED_RETRY_GUIDANCE);
      return;
    }
    const originalResources = task.streamMeta?.resources || [];
    const byUrl = new Map(originalResources.map((res) => [res.url, res]));
    const failedUrls = [...new Set((task.diagnostics || []).map((item) => item.url).filter(Boolean))];
    if (failedUrls.length === 0) return;

    const resources = failedUrls.map((url) => {
      const original = byUrl.get(url);
      if (original) return original;
      const diagnostic = (task.diagnostics || []).find((item) => item.url === url);
      return { url, title: diagnostic?.fileName || extractFileName(url), ext: (diagnostic?.fileName || '').split('.').pop() || '' };
    });

    if (typeof window.showDirectoryPicker !== 'function') {
      showTaskNotice(task.id, '浏览器不支持目录选择 API，无法重新选择保存位置。');
      return;
    }
    try {
      const directoryHandle = await window.showDirectoryPicker();
      const hs = await getHandleStore();
      const dirHandleKey = crypto.randomUUID();
      await hs.putHandle(dirHandleKey, directoryHandle);

      const response = await chrome.runtime.sendMessage({
        type: 'START_BATCH_DOWNLOAD',
        tabId: task.tabId,
        resources,
        dirHandleKey,
      });
      if (response?.ok) refresh();
    } catch (err) {
      if (err?.name !== 'AbortError') console.warn('[WebGrab/TaskPanel] 重试失败项失败:', err);
    }
  }

  /**
   * 清空已完成/已取消/失败的任务
   */
  async function clearFinished() {
    const toRemove = [];
    for (const [id, t] of tasks) {
      if (['done', 'failed', 'canceled'].includes(t.status)) {
        toRemove.push(id);
      }
    }
    for (const id of toRemove) {
      try {
        await chrome.runtime.sendMessage({ type: 'DELETE_TASK', taskId: id });
        tasks.delete(id);
        taskNotices.delete(id);
      } catch {}
    }
    render();
  }

  // ─── 渲染 ──────────────────────────────────────────────

  function render() {
    if (!listEl) return;
    const list = Array.from(tasks.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    listEl.innerHTML = '';

    if (list.length === 0) {
      emptyEl.style.display = 'flex';
      listEl.style.display = 'none';
      updateSummary();
      return;
    }

    emptyEl.style.display = 'none';
    listEl.style.display = 'block';

    const fragment = document.createDocumentFragment();
    for (const t of list) {
      fragment.appendChild(createItem(t));
    }
    listEl.appendChild(fragment);
    updateSummary();
  }

  /**
   * 单条任务增量刷新
   * @param {string} taskId
   */
  function renderItem(taskId) {
    const task = tasks.get(taskId);
    if (!task) return;

    const existing = listEl?.querySelector(`[data-task-id="${taskId}"]`);
    if (!existing) {
      // 新任务，追加到列表
      if (listEl && emptyEl) {
        emptyEl.style.display = 'none';
        listEl.style.display = 'block';
        listEl.insertBefore(createItem(task), listEl.firstChild);
      }
      updateSummary();
      return;
    }

    // 已存在，更新内容
    const newItem = createItem(task);
    existing.replaceWith(newItem);
    updateSummary();
  }

  /**
   * 创建单个任务 DOM
   * @param {Object} task
   * @returns {HTMLElement}
   */
  function createItem(task) {
    const item = document.createElement('div');
    item.className = 'task-item';
    item.dataset.taskId = task.id;
    item.dataset.status = task.status;

    // 第一行：图标 + 名称 + 操作
    const row = document.createElement('div');
    row.className = 'task-row';

    const icon = document.createElement('span');
    icon.className = 'task-icon';
    icon.innerHTML = statusIconSvg(task.status);
    row.appendChild(icon);

    const info = document.createElement('div');
    info.className = 'task-info';

    const name = document.createElement('div');
    name.className = 'task-name';
    name.textContent = task.fileName || extractFileName(task.url);
    name.title = task.url || '';
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'task-meta';
    meta.appendChild(buildMeta(task));
    info.appendChild(meta);

    row.appendChild(info);

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'task-actions';

    const isActive = ['pending', 'downloading', 'writing', 'extracting', 'packing'].includes(task.status);

    if (isActive) {
      const cancelBtn = document.createElement('button');
      cancelBtn.className = 'task-btn task-btn-cancel';
      cancelBtn.title = '取消';
      cancelBtn.textContent = '取消';
      cancelBtn.addEventListener('click', () => cancelTask(task.id));
      actions.appendChild(cancelBtn);
    } else {
      const isBatch = task.streamMeta?.kind === 'batch';
      const failedCount = isBatch ? new Set((task.diagnostics || []).map((item) => item.url).filter(Boolean)).size : 0;

      if (isBatch && failedCount > 0) {
        const retryFailedBtn = document.createElement('button');
        retryFailedBtn.className = 'task-btn task-btn-retry';
        retryFailedBtn.title = '只重新下载失败的文件，跳过已成功的';
        retryFailedBtn.textContent = `重试失败项 (${failedCount})`;
        retryFailedBtn.addEventListener('click', () => retryBatchFailures(task));
        actions.appendChild(retryFailedBtn);
      } else if ((task.status === 'failed' || task.status === 'canceled') &&
          !['novel', 'comic-package', 'epub-package'].includes(task.kind) && !isBatch) {
        const retryBtn = document.createElement('button');
        retryBtn.className = 'task-btn task-btn-retry';
        retryBtn.title = '重试';
        retryBtn.textContent = '重试';
        retryBtn.addEventListener('click', () => retryTask(task));
        actions.appendChild(retryBtn);
      }
      const delBtn = document.createElement('button');
      delBtn.className = 'task-btn task-btn-delete';
      delBtn.title = '删除';
      delBtn.textContent = '删除';
      delBtn.addEventListener('click', () => deleteTask(task.id));
      actions.appendChild(delBtn);
    }

    row.appendChild(actions);
    item.appendChild(row);

    // 第二行：进度条（仅活跃状态显示）
    if (isActive) {
      const progressWrap = document.createElement('div');
      progressWrap.className = 'task-progress';

      const bar = document.createElement('div');
      bar.className = 'task-progress-bar';

      const fill = document.createElement('div');
      fill.className = 'task-progress-fill';
      const pct = computePercent(task);
      fill.style.width = pct + '%';
      bar.appendChild(fill);

      const pctLabel = document.createElement('span');
      pctLabel.className = 'task-progress-pct';
      pctLabel.textContent = pct + '%';

      progressWrap.appendChild(bar);
      progressWrap.appendChild(pctLabel);
      item.appendChild(progressWrap);
    } else if (task.error) {
      // 终态错误默认折叠，避免任务列表被长错误文本挤满。
      const errorBlock = document.createElement('div');
      errorBlock.className = 'task-error-block';
      const errorId = `task-error-${String(task.id || '').replace(/[^a-z0-9_-]/gi, '-')}`;
      const errorToggle = document.createElement('button');
      errorToggle.type = 'button';
      errorToggle.className = 'task-error-toggle';
      errorToggle.textContent = '查看原因';
      errorToggle.setAttribute('aria-expanded', 'false');
      errorToggle.setAttribute('aria-controls', errorId);
      const errorDetail = document.createElement('div');
      errorDetail.id = errorId;
      errorDetail.className = task.status === 'done'
        ? 'task-error task-error-warning'
        : 'task-error';
      errorDetail.textContent = task.error;
      errorDetail.hidden = true;
      errorToggle.addEventListener('click', () => {
        const expanded = errorToggle.getAttribute('aria-expanded') === 'true';
        errorToggle.setAttribute('aria-expanded', String(!expanded));
        errorToggle.textContent = expanded ? '查看原因' : '收起原因';
        errorDetail.hidden = expanded;
      });
      errorBlock.append(errorToggle, errorDetail);
      item.appendChild(errorBlock);
    }

    if (taskNotices.has(task.id)) {
      const notice = document.createElement('div');
      notice.className = 'task-action-notice';
      notice.setAttribute('role', 'status');
      notice.textContent = taskNotices.get(task.id);
      item.appendChild(notice);
    }

    return item;
  }

  /**
   * 构建 meta 文本
   * @param {Object} task
   * @returns {DocumentFragment}
   */
  function buildMeta(task) {
    const frag = document.createDocumentFragment();

    const statusSpan = document.createElement('span');
    // done 状态但有 error → 部分完成，用不同的样式和文案
    if (task.status === 'done' && task.error) {
      statusSpan.className = 'task-status status-partial';
      statusSpan.textContent = '部分完成';
    } else {
      statusSpan.className = `task-status status-${task.status}`;
      statusSpan.textContent = STATUS_LABEL[task.status] || task.status;
    }
    frag.appendChild(statusSpan);

    // 大小信息
    if (['novel', 'comic-package', 'epub-package'].includes(task.kind) && task.total > 0) {
      frag.appendChild(sep());
      const countSpan = document.createElement('span');
      const unit = task.kind === 'epub-package' || task.kind === 'novel' ? '章' : '页';
      countSpan.textContent = `${task.downloaded || 0} / ${task.total} ${unit}`;
      if (Number.isFinite(task.failureCount) && task.failureCount > 0) {
        countSpan.textContent += `，缺失 ${task.failureCount}`;
      }
      frag.appendChild(countSpan);
    } else if (task.total > 0) {
      frag.appendChild(sep());
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = `${formatSize(task.downloaded || 0)} / ${formatSize(task.total)}`;
      frag.appendChild(sizeSpan);
    } else if (task.downloaded > 0) {
      frag.appendChild(sep());
      const sizeSpan = document.createElement('span');
      sizeSpan.textContent = formatSize(task.downloaded);
      frag.appendChild(sizeSpan);
    }

    // 速度 + ETA（仅下载中）
    if (task.status === 'downloading' && task.speed > 0) {
      frag.appendChild(sep());
      const speedSpan = document.createElement('span');
      speedSpan.textContent = formatSize(task.speed) + '/s';
      frag.appendChild(speedSpan);

      if (task.eta > 0) {
        frag.appendChild(sep());
        const etaSpan = document.createElement('span');
        etaSpan.textContent = '剩余 ' + formatEta(task.eta);
        frag.appendChild(etaSpan);
      }
    }

    // 完成时间
    if (task.status === 'done' && task.completedAt) {
      frag.appendChild(sep());
      const timeSpan = document.createElement('span');
      timeSpan.textContent = formatTime(task.completedAt);
      frag.appendChild(timeSpan);
    }

    return frag;
  }

  function sep() {
    const s = document.createElement('span');
    s.className = 'task-sep';
    s.textContent = '·';
    return s;
  }

  /**
   * 更新顶部摘要
   */
  function updateSummary() {
    let active = 0;
    let done = 0;
    let failed = 0;
    for (const t of tasks.values()) {
      if (ACTIVE_STATUSES.includes(t.status)) active++;
      else if (t.status === 'done') done++;
      else if (t.status === 'failed') failed++;
    }
    // 工具栏徽章订阅同一次统计结果，不再由 popup.js 独立发 GET_TASKS 重新计算一遍。
    onActiveCountChange?.(active);
    if (!summaryEl) return;
    const parts = [];
    if (active > 0) parts.push(`${active} 进行中`);
    if (done > 0) parts.push(`${done} 已完成`);
    if (failed > 0) parts.push(`${failed} 失败`);
    summaryEl.textContent = parts.length > 0 ? `共 ${tasks.size} 个任务（${parts.join('，')}）` : `共 ${tasks.size} 个任务`;
  }

  // ─── 辅助函数 ──────────────────────────────────────────

  /**
   * 计算进度百分比
   * @param {Object} task
   * @returns {number}
   */
  function computePercent(task) {
    if (task.total > 0 && task.downloaded >= 0) {
      return Math.min(100, Math.max(0, Math.round((task.downloaded / task.total) * 100)));
    }
    if (task.status === 'done') return 100;
    return 0;
  }

  /**
   * 格式化文件大小
   * @param {number} bytes
   * @returns {string}
   */
  function formatSize(bytes) {
    if (bytes < 0 || !bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /**
   * 格式化剩余时间
   * @param {number} seconds
   * @returns {string}
   */
  function formatEta(seconds) {
    if (seconds < 60) return seconds + 's';
    if (seconds < 3600) return Math.floor(seconds / 60) + 'm' + (seconds % 60) + 's';
    return Math.floor(seconds / 3600) + 'h' + Math.floor((seconds % 3600) / 60) + 'm';
  }

  /**
   * 格式化时间戳
   * @param {number} ts
   * @returns {string}
   */
  function formatTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
  }

  /**
   * 从 URL 提取文件名
   * @param {string} url
   * @returns {string}
   */
  function extractFileName(url) {
    if (!url) return 'unknown';
    try {
      const u = new URL(url);
      const path = u.pathname;
      const slash = path.lastIndexOf('/');
      return slash !== -1 ? path.slice(slash + 1) : path;
    } catch {
      return url.split('/').pop() || url;
    }
  }

  /**
   * 调用 showSaveFilePicker 选择保存位置
   * @param {string} suggestedName
   * @returns {Promise<FileSystemFileHandle|null>}
   */
  async function pickSaveFile(suggestedName) {
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggestedName || 'download',
      });
      return handle;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.warn('[WebGrab/TaskPanel] 选择文件失败:', err);
      return null;
    }
  }

  /**
   * 当前"进行中"任务数——与 updateSummary() 内部统计口径完全一致。
   * 供 popup.js 在注册 onActiveCountChange 之前渲染徽章初值。
   * @returns {number}
   */
  function getActiveCount() {
    let active = 0;
    for (const t of tasks.values()) {
      if (ACTIVE_STATUSES.includes(t.status)) active++;
    }
    return active;
  }

  // ─── 暴露 API ──────────────────────────────────────────
  window.webgrabTasks = {
    init,
    destroy,
    refresh,
    upsertTask,
    pickSaveFile,
    getActiveCount,
  };
})();
