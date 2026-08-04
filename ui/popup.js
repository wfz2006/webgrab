/**
 * Popup 资源列表 UI
 *
 * 功能：
 *   - 列出当前标签页捕获到的资源
 *   - 按类型分 tab（全部 / 视频 / 音频 / 图片 / 其他）
 *   - 关键词筛选 + 按大小排序
 *   - 图片悬停预览
 *   - 复制 URL
 *   - 下载按钮：触发 showSaveFilePicker + offscreen 下载
 *   - 视图切换：资源 / 任务
 */

(function () {
  'use strict';

  const embeddedMode = new URLSearchParams(location.search).get('embedded') === '1';
  // 悬浮窗面板是"内容脚本 Shadow DOM 宿主 → panel.html iframe → popup.html iframe"
  // 两层跨域嵌套；File System Access API（showDirectoryPicker/showSaveFilePicker）
  // 在这种嵌套 iframe 里会被浏览器直接拒绝，原生 <select> 弹层也有已知的展示问题。
  // 工具栏弹窗和侧边栏都是真正的顶层文档（window === window.top），不受影响，
  // 所以不能只看 embeddedMode（侧边栏也用同一个 ?embedded=1，但它没有这个限制）。
  const isNestedFrame = window.self !== window.top;
  if (embeddedMode) {
    document.documentElement.classList.add('embedded-mode');
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        window.parent.postMessage({ source: 'webgrab-popup', type: 'WEBGRAB_POPUP_ESCAPE' }, location.origin);
      }
    });
  }

  // ─── 状态 ──────────────────────────────────────────────
  /** @type {any[]} 当前所有资源 */
  let allResources = [];
  /** @type {string} 当前激活的类型 tab */
  let activeKind = 'all';
  /** @type {string} 筛选关键词 */
  let filterText = '';
  /** @type {string} 排序方式 */
  let sortMode = 'time-desc';
  /** @type {boolean} 是否展开没有被站点确认的次要视频候选 */
  let showSecondaryMediaCandidates = false;
  /** @type {Set<string>} 批量下载选中的资源 URL 集合 */
  const selectedUrls = new Set();
  /** @type {number} 当前标签页 ID */
  let currentTabId = -1;
  /** @type {string} 当前视图：resources | tasks */
  let activeView = 'resources';
  /** @type {number} 活跃任务数（用于 badge） */
  let activeTaskCount = 0;
  let uiSettingsApi = null;

  async function initializeTheme() {
    try {
      uiSettingsApi = await import('../lib/ui-settings.js');
      uiSettingsApi.applyTheme(document.documentElement, await uiSettingsApi.loadUiSettings());
      uiSettingsApi.watchUiSettings((settings) => uiSettingsApi.applyTheme(document.documentElement, settings));
    } catch (error) {
      console.warn('[WebGrab] 读取界面主题失败，继续跟随系统', error);
    }
  }

  // ─── P4-1 小说文本状态 ─────────────────────────────────
  let novelDetection = null;
  let novelDetectionLoaded = false;
  let preparedNovel = null;
  let currentNovelTask = null;
  let exportableNovel = null;

  // ─── B 站状态 ──────────────────────────────────────────
  /** @type {Object|null} B 站 extract 数据 */
  let biliData = null;
  /** @type {string} 当前页面 URL（B 站检测用） */
  let currentPageUrl = '';
  let currentPageTitle = '';
  /** @type {Object|null} 当前选中的 video 变体 */
  let selectedVariant = null;
  /** @type {Object|null} 当前选定的音频选项 */
  let selectedAudioOption = null;
  /** @type {number} 当前选中的分 P 索引 */
  let selectedPartIndex = 0;
  /** @type {number|null} 当前选中的质量码 */
  let selectedQualityId = null;
  /** @type {string|null} 当前选中的编码组（avc1/hev1/av01） */
  let selectedCodecGroup = null;

  // ─── 分 P 切换状态 ──────────────────────────────────────
  /** @type {number} 切换请求自增计数器，用于竞态控制 */
  let switchRequestId = 0;
  /** @type {{requestId: number, targetPartIndex: number}|null} 当前正在进行的切换 */
  let switchingPart = null;

  // ─── handle-store 动态加载 ──────────────────────────────
  // popup.js 是普通 script（非 ES module），用动态 import() 加载
  // FileSystemFileHandle 必须通过 IndexedDB 跨上下文传递（不能过 JSON 序列化）
  let _handleStorePromise = null;
  function getHandleStore() {
    if (!_handleStorePromise) {
      _handleStorePromise = import('../lib/handle-store.js');
    }
    return _handleStorePromise;
  }

  let _pathToolsPromise = null;
  function getPathTools() {
    if (!_pathToolsPromise) {
      _pathToolsPromise = Promise.all([
        import('../lib/path-planner.js'),
        import('../lib/path-settings.js'),
        import('../lib/file-system-path.js'),
        import('../lib/media-output.js'),
      ]).then(([planner, settings, fileSystem, mediaOutput]) => ({ planner, settings, fileSystem, mediaOutput }));
    }
    return _pathToolsPromise;
  }

  function resourcePathType(resource, override) {
    if (override) return override;
    if (resource?.kind === 'stream') return 'video';
    return ['video', 'audio', 'image'].includes(resource?.kind) ? resource.kind : 'other';
  }

  function extensionForResource(resource, fallback = 'bin') {
    const explicit = String(resource?.ext || '').replace(/^\.+/, '');
    if (explicit) return explicit;
    const name = resource?.title || extractFileName(resource?.url || '');
    const match = String(name).match(/\.([a-z0-9]{2,8})$/i);
    return match ? match[1].toLowerCase() : fallback;
  }

  function titleWithoutExtension(value) {
    return String(value || 'download').replace(/\.[a-z0-9]{2,8}$/i, '');
  }

  function inferPageWorkChapter() {
    const parts = String(currentPageTitle || '')
      .split(/\s+(?:[-|–—])\s+/)
      .map((part) => part.trim())
      .filter(Boolean);
    if (parts.length >= 2) return { chapter: parts[0], work: parts[1] };
    return { work: currentPageTitle || '未命名作品', chapter: currentPageTitle || '未命名章节' };
  }

  async function planResourcePath(resource, overrides = {}) {
    const { planner, settings, mediaOutput } = await getPathTools();
    const outputResource = mediaOutput.normalizeAdaptiveStreamOutput(resource);
    const pathSettings = await settings.loadPathSettings();
    const type = resourcePathType(outputResource, overrides.type);
    const title = titleWithoutExtension(overrides.title || outputResource?.title || extractFileName(outputResource?.url || ''));
    const context = planner.createPathContext({
      type,
      url: outputResource?.url,
      pageUrl: outputResource?.pageUrl || currentPageUrl,
      source: overrides.source || currentPageUrl,
      ...(overrides.site !== undefined ? { site: overrides.site } : {}),
      work: overrides.work,
      chapter: overrides.chapter,
      sequence: overrides.sequence ?? (Number.isFinite(outputResource?.domIndex) ? outputResource.domIndex + 1 : ''),
      title,
      date: overrides.date,
      ext: overrides.ext || extensionForResource(outputResource),
    });
    return {
      organizedPath: planner.buildOrganizedPath(context, pathSettings),
      conflictStrategy: pathSettings.conflictStrategy,
      context,
      outputResource,
    };
  }

  async function rememberPreviewResource(resource, overrides = {}) {
    try {
      const plan = await planResourcePath(resource, overrides);
      const { settings } = await getPathTools();
      await settings.savePreviewContext(plan.context);
    } catch {}
  }

  // ─── DOM 引用 ──────────────────────────────────────────
  const listContainer = document.getElementById('list-container');
  const emptyState = document.getElementById('empty-state');
  const emptyRefresh = document.getElementById('empty-refresh');
  const filterInput = document.getElementById('filter-input');
  const sortSelect = document.getElementById('sort-select');
  const mediaCandidateBar = document.getElementById('media-candidate-bar');
  const mediaCandidateText = document.getElementById('media-candidate-text');
  const mediaCandidateToggle = document.getElementById('media-candidate-toggle');
  const statusText = document.getElementById('status-text');
  const sourceStats = document.getElementById('source-stats');
  const btnRefresh = document.getElementById('btn-refresh');
  const btnClear = document.getElementById('btn-clear');
  const btnSettings = document.getElementById('btn-settings');
  const btnSidepanel = document.getElementById('btn-sidepanel');
  const viewResources = document.getElementById('view-resources');
  const viewTasks = document.getElementById('view-tasks');
  const taskBadge = document.getElementById('task-badge');
  const viewBilibili = document.getElementById('view-bilibili');
  const biliContainer = document.getElementById('bili-container');
  const biliTab = document.querySelector('.view-tab-bili');
  const batchBar = document.getElementById('batch-bar');
  const selectAllCheckbox = document.getElementById('select-all-checkbox');
  const batchCountEl = document.getElementById('batch-count');
  const batchDownloadBtn = document.getElementById('batch-download-btn');
  const comicModeSelect = document.getElementById('comic-mode-select');
  const comicPackageBtn = document.getElementById('comic-package-btn');
  const batchCancel = document.getElementById('batch-cancel');
  const viewText = document.getElementById('view-text');
  const novelPageTitle = document.getElementById('novel-page-title');
  const novelDetectionDetail = document.getElementById('novel-detection-detail');
  const novelExtractChapterBtn = document.getElementById('novel-extract-chapter');
  const novelPrepareFullBtn = document.getElementById('novel-prepare-full');
  const novelSingleResult = document.getElementById('novel-single-result');
  const novelConfirm = document.getElementById('novel-confirm');
  const novelConfirmSummary = document.getElementById('novel-confirm-summary');
  const novelEstimate = document.getElementById('novel-estimate');
  const novelConfirmStartBtn = document.getElementById('novel-confirm-start');
  const novelConfirmCancelBtn = document.getElementById('novel-confirm-cancel');
  const novelProgressCard = document.getElementById('novel-progress-card');
  const novelProgressTitle = document.getElementById('novel-progress-title');
  const novelProgressStatus = document.getElementById('novel-progress-status');
  const novelCurrentChapter = document.getElementById('novel-current-chapter');
  const novelProgress = document.getElementById('novel-progress');
  const novelProgressCount = document.getElementById('novel-progress-count');
  const novelSuccessCount = document.getElementById('novel-success-count');
  const novelFailureCount = document.getElementById('novel-failure-count');
  const novelFailureSummary = document.getElementById('novel-failure-summary');
  const novelCancelTaskBtn = document.getElementById('novel-cancel-task');
  const novelExportCard = document.getElementById('novel-export-card');
  const novelExportTitle = document.getElementById('novel-export-title');
  const novelExportEpubBtn = document.getElementById('novel-export-epub');

  // ─── 缩略图与类型图标 ──────────────────────────────────
  const thumbnailStates = new Map();
  let thumbnailObserver = null;

  // ─── 虚拟滚动 ──────────────────────────────────────────
  // 资源条目固定 64px 高（对应 popup.css 的 .resource-item height），
  // 只把视口附近的条目创建成真实 DOM 节点，避免上千条资源时卡顿。
  const ROW_HEIGHT = 64;
  let computeVisibleRange = null;
  let currentFilteredResources = [];
  let currentDisplayResources = [];
  let suppressRedundantStreamSegments = (resources) => [...resources];
  let buildMediaCandidateView = (resources) => ({
    resources: suppressRedundantStreamSegments(resources),
    mode: 'none',
    hiddenCount: 0,
  });
  let listSizer = null;
  let scrollRafId = null;
  let listResizeObserver = null;

  function ensureListSizer() {
    if (listSizer && listSizer.parentElement === listContainer) return listSizer;
    listContainer.innerHTML = '';
    listSizer = document.createElement('div');
    listSizer.className = 'list-sizer';
    listContainer.appendChild(listSizer);
    return listSizer;
  }

  function renderWindow() {
    if (!computeVisibleRange || currentFilteredResources.length === 0) return;
    const sizer = ensureListSizer();
    const range = computeVisibleRange({
      scrollTop: listContainer.scrollTop,
      viewportHeight: listContainer.clientHeight || 600,
      rowHeight: ROW_HEIGHT,
      itemCount: currentFilteredResources.length,
      overscan: 6,
    });
    sizer.style.height = `${range.totalHeight}px`;
    sizer.innerHTML = '';
    const fragment = document.createDocumentFragment();
    for (let i = range.startIndex; i < range.endIndex; i++) {
      const res = currentFilteredResources[i];
      const item = createResourceItem(res);
      item.style.transform = `translateY(${i * ROW_HEIGHT}px)`;
      fragment.appendChild(item);
    }
    sizer.appendChild(fragment);
  }

  function scheduleRenderWindow() {
    if (scrollRafId) return;
    scrollRafId = requestAnimationFrame(() => {
      scrollRafId = null;
      renderWindow();
    });
  }

  const KIND_ICON_PATHS = {
    video: '<rect x="3" y="4" width="13" height="12" rx="2"/><path d="m16 8 5-3v10l-5-3"/>',
    audio: '<path d="M9 18V5l10-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="16" cy="16" r="3"/>',
    image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="m4 17 5-5 4 4 3-3 4 4"/>',
    stream: '<path d="M8 9a5 5 0 0 0 0 6M5 6a9 9 0 0 0 0 12M16 9a5 5 0 0 1 0 6M19 6a9 9 0 0 1 0 12"/><circle cx="12" cy="12" r="2"/>',
    subtitle: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M6 14h5M13 14h5M6 10h8"/>',
    other: '<path d="M7 3h7l5 5v13H7z"/><path d="M14 3v5h5"/>',
  };

  function ensureThumbnailObserver() {
    if (thumbnailObserver) return thumbnailObserver;
    if (typeof IntersectionObserver !== 'function') return null;
    thumbnailObserver = new IntersectionObserver((entries, observer) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const thumb = entry.target;
        observer.unobserve(thumb);
        if (thumb.dataset.src && !thumb.src) thumb.src = thumb.dataset.src;
      }
    }, { root: listContainer, rootMargin: '96px 0px', threshold: 0.01 });
    return thumbnailObserver;
  }

  // ─── 初始化 ────────────────────────────────────────────
  async function init() {
    await initializeTheme();
    const [virtualList, mediaResourceView] = await Promise.all([
      import('../lib/virtual-list.js'),
      import('../lib/media-resource-view.js'),
    ]);
    computeVisibleRange = virtualList.computeVisibleRange;
    suppressRedundantStreamSegments = mediaResourceView.suppressRedundantStreamSegments;
    buildMediaCandidateView = mediaResourceView.buildMediaCandidateView;
    listContainer.addEventListener('scroll', scheduleRenderWindow, { passive: true });
    if (typeof ResizeObserver === 'function') {
      listResizeObserver = new ResizeObserver(() => renderWindow());
      listResizeObserver.observe(listContainer);
    }
    // 获取当前活动标签页
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab) {
      currentTabId = tab.id;
      currentPageUrl = tab.url || '';
      currentPageTitle = tab.title || '';
    }

    // 绑定事件
    bindEvents();
    bindNovelEvents();

    // 初始化任务面板
    // 徽章计数通过 onActiveCountChange 订阅 tasks.js 内部统计，不再自己发 GET_TASKS
    // 重新拉取一遍——两处各算一套曾经是徽章数字和面板任务数对不上的根源。
    if (window.webgrabTasks) {
      window.webgrabTasks.init(viewTasks, {
        onSwitchToResources: () => switchView('resources'),
        onActiveCountChange: renderTaskBadge,
      });
    }

    // 监听任务广播（仅用于小说任务的额外 UI 联动，徽章已由上面的回调驱动）
    chrome.runtime.onMessage.addListener((message) => {
      if (message.type === 'TASK_BROADCAST' && message.task) {
        if (message.task.kind === 'novel' || message.task.streamMeta?.kind === 'novel') {
          handleNovelTaskBroadcast(message.task);
        }
      }
    });

    // 检测 B 站页面：显示 B 站 tab 并预加载数据
    if (isBilibiliPage(currentPageUrl)) {
      biliTab.style.display = '';
      fetchBiliData();
    }

    // 打包格式偏好（P4-6 设置页可配置默认值，这里只用作初始选中项）
    try {
      const { loadPackagePreference } = await import('../lib/package-preference.js');
      comicModeSelect.value = await loadPackagePreference();
    } catch (error) {
      console.warn('[WebGrab] 读取打包格式偏好失败，使用页面默认值', error);
    }

    // 加载数据
    await loadResources();
    // tasks.js 的 init() 内部会异步 refresh() 一次并回调 onActiveCountChange，
    // 这里用当前已知值先渲染一次，避免徽章在那次回调落地前短暂空白。
    if (window.webgrabTasks) renderTaskBadge(window.webgrabTasks.getActiveCount());

    // 定时刷新（popup 打开期间持续更新；任务徽章由广播 + tasks.js 内部兜底轮询驱动，不再单独轮询）
    setInterval(loadResources, 2000);
  }

  const RESOURCE_RENDER_FIELDS = Object.freeze([
    'id', 'url', 'kind', 'ext', 'mime', 'size', 'title', 'width', 'height',
    'source', 'domIndex', 'discoveredAt', 'pageUrl', 'isPrimaryMedia', 'mediaId', 'duration',
  ]);

  function hasResourceListChanged(previous, next) {
    if (previous.length !== next.length) return true;
    for (let index = 0; index < next.length; index++) {
      const before = previous[index] || {};
      const after = next[index] || {};
      for (const field of RESOURCE_RENDER_FIELDS) {
        if (before[field] !== after[field]) return true;
      }
    }
    return false;
  }

  /**
   * 从 SW 加载当前标签页的资源
   */
  async function loadResources() {
    if (currentTabId < 0) return;

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_RESOURCES',
        tabId: currentTabId,
      });

      if (response && response.ok && response.data) {
        const nextResources = response.data.resources || [];
        if (!hasResourceListChanged(allResources, nextResources)) return;
        allResources = nextResources;
        const availableUrls = new Set(allResources.map((resource) => resource.url));
        for (const url of selectedUrls) {
          if (!availableUrls.has(url)) selectedUrls.delete(url);
        }
        render();
      }
    } catch (err) {
      statusText.textContent = '加载失败: ' + (err.message || err);
    }
  }

  async function refreshCurrentPage() {
    if (currentTabId < 0) return;
    btnRefresh.disabled = true;
    statusText.textContent = '正在清空旧结果并重载页面…';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'CLEAR_TAB',
        tabId: currentTabId,
      });
      if (!response?.ok) throw new Error(response?.error || '清空旧结果失败');

      allResources = [];
      selectedUrls.clear();
      showSecondaryMediaCandidates = false;
      render();
      await chrome.tabs.reload(currentTabId, { bypassCache: true });
      statusText.textContent = '页面已重载，正在重新嗅探…';
    } catch (error) {
      statusText.textContent = `重新嗅探失败: ${error?.message || error}`;
    } finally {
      btnRefresh.disabled = false;
    }
  }

  // ─── 事件绑定 ──────────────────────────────────────────
  function bindEvents() {
    if (!embeddedMode && chrome.sidePanel?.open && btnSidepanel) {
      btnSidepanel.hidden = false;
      btnSidepanel.addEventListener('click', async () => {
        try {
          await chrome.sidePanel.open({ tabId: currentTabId });
          window.close();
        } catch (error) {
          console.warn('[WebGrab] 打开侧边栏失败:', error);
        }
      });
    }

    btnSettings?.addEventListener('click', async () => {
      const selected = allResources.find((resource) => selectedUrls.has(resource.url)) || allResources[0];
      if (selected) await rememberPreviewResource(selected);
      await chrome.runtime.openOptionsPage();
    });

    // Tab 切换
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
        tab.classList.add('active');
        activeKind = tab.dataset.kind;
        render();
      });
    });

    // 视图切换
    document.querySelectorAll('.view-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        switchView(tab.dataset.view);
      });
    });

    // 筛选
    filterInput.addEventListener('input', () => {
      filterText = filterInput.value.toLowerCase().trim();
      render();
    });

    // 排序
    sortSelect.addEventListener('change', () => {
      sortMode = sortSelect.value;
      render();
    });

    // 刷新
    btnRefresh.addEventListener('click', refreshCurrentPage);
    emptyRefresh?.addEventListener('click', () => btnRefresh.click());

    mediaCandidateToggle?.addEventListener('click', () => {
      showSecondaryMediaCandidates = !showSecondaryMediaCandidates;
      render();
    });

    // 清空
    btnClear.addEventListener('click', async () => {
      if (currentTabId < 0) return;
      await chrome.runtime.sendMessage({
        type: 'CLEAR_TAB',
        tabId: currentTabId,
      });
      allResources = [];
      selectedUrls.clear();
      showSecondaryMediaCandidates = false;
      render();
      statusText.textContent = '已清空';
      setTimeout(() => (statusText.textContent = '就绪'), 1500);
    });
  }

  // ─── 筛选 + 排序 ──────────────────────────────────────
  function getFilteredResources(resources = suppressRedundantStreamSegments(allResources)) {
    let result = [...resources];

    // 类型筛选
    if (activeKind !== 'all') {
      if (activeKind === 'other') {
        result = result.filter(
          (r) => !['video', 'audio', 'image', 'stream'].includes(r.kind)
        );
      } else if (activeKind === 'video') {
        // 视频分类包含 stream（MediaSource blob URL），与 updateTabCounts 计数逻辑一致
        result = result.filter((r) => r.kind === 'video' || r.kind === 'stream');
      } else {
        result = result.filter((r) => r.kind === activeKind);
      }
    }

    // 关键词筛选
    if (filterText) {
      result = result.filter((r) => {
        const name = (r.title || r.url || '').toLowerCase();
        const url = (r.url || '').toLowerCase();
        const ext = (r.ext || '').toLowerCase();
        return name.includes(filterText) || url.includes(filterText) || ext.includes(filterText);
      });
    }

    // 排序
    result.sort((a, b) => {
      switch (sortMode) {
        case 'time-desc':
          return b.discoveredAt - a.discoveredAt;
        case 'time-asc':
          return a.discoveredAt - b.discoveredAt;
        case 'size-desc':
          return (b.size || -1) - (a.size || -1);
        case 'size-asc':
          return (a.size || -1) - (b.size || -1);
        default:
          return 0;
      }
    });

    return result;
  }

  // ─── 渲染 ──────────────────────────────────────────────
  function renderMediaCandidateBar(candidateView) {
    const isMediaView = activeKind === 'all' || activeKind === 'video';
    if (!isMediaView || candidateView.mode === 'none') {
      mediaCandidateBar.hidden = true;
      return;
    }

    mediaCandidateBar.hidden = false;
    if (candidateView.mode === 'primary') {
      mediaCandidateText.textContent = '已从站点数据识别主视频，并隐藏分片和页面辅助视频。';
      mediaCandidateToggle.hidden = true;
      return;
    }

    mediaCandidateText.textContent = candidateView.hiddenCount > 0
      ? '未确认站点主视频；“推荐候选”仅按格式和文件大小推测。'
      : '未确认站点主视频；当前仅有一个推荐候选。';
    mediaCandidateToggle.hidden = candidateView.hiddenCount === 0;
    if (!mediaCandidateToggle.hidden) {
      mediaCandidateToggle.textContent = showSecondaryMediaCandidates
        ? '收起其他候选'
        : `显示其他候选 ${candidateView.hiddenCount}`;
    }
  }

  function render() {
    const candidateView = buildMediaCandidateView(allResources, {
      showSecondary: showSecondaryMediaCandidates,
    });
    currentDisplayResources = candidateView.resources;
    renderMediaCandidateBar(candidateView);
    const displayUrls = new Set(currentDisplayResources.map((resource) => resource.url));
    for (const url of selectedUrls) {
      if (!displayUrls.has(url)) selectedUrls.delete(url);
    }
    currentFilteredResources = getFilteredResources(currentDisplayResources);
    if (thumbnailObserver) thumbnailObserver.disconnect();
    thumbnailObserver = null;

    // 更新 Tab 计数
    updateTabCounts();

    // 更新来源统计
    updateSourceStats();

    // 渲染列表（虚拟滚动：只创建视口附近的行）
    if (currentFilteredResources.length === 0) {
      listContainer.innerHTML = '';
      listContainer.appendChild(emptyState);
      emptyState.style.display = 'flex';
      updateBatchBar();
      return;
    }

    emptyState.style.display = 'none';
    renderWindow();

    // 更新批量操作栏状态（复选框/计数/按钮）
    updateBatchBar();
  }

  /**
   * 创建资源条目 DOM
   * @param {any} res
   * @returns {HTMLElement}
   */
  function resourceDisplayName(resource) {
    const title = String(resource?.title || '').trim();
    if (title) return title;
    const fileName = String(extractFileName(resource?.url || '') || '').trim();
    if (fileName) return fileName;
    if (resource?.mediaCandidateRole === 'primary') return '主视频';
    if (resource?.mediaCandidateRole === 'recommended') return '推荐视频候选';
    if (resource?.kind === 'video' || resource?.kind === 'stream') return '视频候选';
    return '未命名资源';
  }

  function createResourceItem(res) {
    const item = document.createElement('div');
    item.className = 'resource-item';

    // 复选框（用于批量下载）
    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.className = 'resource-checkbox';
    checkbox.checked = selectedUrls.has(res.url);
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) {
        selectedUrls.add(res.url);
        rememberPreviewResource(res);
      } else {
        selectedUrls.delete(res.url);
      }
      updateBatchBar();
    });
    // 阻止 checkbox 点击冒泡到 item（如果未来有 item 点击行为）
    checkbox.addEventListener('click', (e) => e.stopPropagation());
    item.appendChild(checkbox);

    // 缩略图 / 图标：先渲染稳定占位，进入视口附近后才发起图片请求。
    const visual = document.createElement('div');
    visual.className = 'resource-visual';
    visual.appendChild(createKindIcon(res.kind));
    if (res.kind === 'image' && res.url && thumbnailStates.get(res.url) !== 'error') {
      const thumb = document.createElement('img');
      thumb.className = 'resource-thumb';
      thumb.dataset.src = res.url;
      thumb.alt = '';
      thumb.loading = 'lazy';
      thumb.decoding = 'async';
      thumb.addEventListener('load', () => {
        thumbnailStates.set(res.url, 'loaded');
        thumb.classList.add('is-loaded');
        attachPreview(thumb, res.url);
      }, { once: true });
      thumb.addEventListener('error', () => {
        thumbnailStates.set(res.url, 'error');
        thumbnailObserver?.unobserve(thumb);
        thumb.remove();
      }, { once: true });
      visual.appendChild(thumb);
      if (thumbnailStates.get(res.url) === 'loaded') {
        thumb.src = thumb.dataset.src;
        thumb.classList.add('is-loaded');
        attachPreview(thumb, res.url);
      } else {
        const observer = ensureThumbnailObserver();
        if (observer) thumbnailObserver.observe(thumb);
        else thumb.src = thumb.dataset.src;
      };
    }
    item.appendChild(visual);

    // 信息区
    const info = document.createElement('div');
    info.className = 'resource-info';

    const name = document.createElement('div');
    name.className = 'resource-name';
    name.textContent = resourceDisplayName(res);
    name.title = res.url;
    info.appendChild(name);

    const meta = document.createElement('div');
    meta.className = 'resource-meta';

    // 扩展名
    if (res.ext) {
      const extSpan = document.createElement('span');
      extSpan.className = 'ext';
      extSpan.textContent = res.ext;
      meta.appendChild(extSpan);
    }

    // 大小
    if (res.size && res.size > 0) {
      const sizeSpan = document.createElement('span');
      sizeSpan.className = 'size';
      sizeSpan.textContent = formatSize(res.size);
      meta.appendChild(sizeSpan);
    }

    if (res.width && res.height) {
      const dimensionSpan = document.createElement('span');
      dimensionSpan.className = 'dimension';
      dimensionSpan.textContent = `${res.width}×${res.height}`;
      meta.appendChild(dimensionSpan);
    }

    if (res.mediaCandidateRole) {
      const candidateBadge = document.createElement('span');
      candidateBadge.className = `media-role-badge media-role-${res.mediaCandidateRole}`;
      candidateBadge.textContent = res.mediaCandidateRole === 'primary' ? '主视频' : '推荐候选';
      candidateBadge.title = res.mediaCandidateRole === 'primary'
        ? '由站点结构化数据确认的完整视频'
        : '仅按格式和文件大小推测，请在不确定时重新嗅探';
      meta.appendChild(candidateBadge);
    }

    // 来源层
    const sourceBadge = document.createElement('span');
    sourceBadge.className = `source-badge source-${res.source}`;
    sourceBadge.textContent = res.source;
    meta.appendChild(sourceBadge);

    info.appendChild(meta);
    item.appendChild(info);

    // 操作按钮
    const actions = document.createElement('div');
    actions.className = 'resource-actions';

    // 复制 URL
    const copyBtn = document.createElement('button');
    copyBtn.className = 'action-btn';
    copyBtn.title = '复制 URL';
    copyBtn.innerHTML = copyIconSvg();
    copyBtn.addEventListener('click', () => copyUrl(res.url, copyBtn));
    actions.appendChild(copyBtn);

    // 下载
    const dlBtn = document.createElement('button');
    dlBtn.className = 'action-btn';
    dlBtn.title = '下载';
    dlBtn.innerHTML = downloadIconSvg();
    dlBtn.addEventListener('click', () => startDownload(res, dlBtn));
    actions.appendChild(dlBtn);

    item.appendChild(actions);

    return item;
  }

  /**
   * 创建类型图标
   * @param {string} kind
   * @returns {HTMLElement}
   */
  function createKindIcon(kind) {
    const icon = document.createElement('div');
    icon.className = `resource-icon kind-${kind || 'video'}`;
    icon.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${KIND_ICON_PATHS[kind] || KIND_ICON_PATHS.other}</svg>`;
    return icon;
  }

  // ─── 视图切换 ──────────────────────────────────────────

  /**
   * 切换视图
   * @param {string} view - 'resources' | 'text' | 'tasks' | 'bilibili'
   */
  function switchView(view) {
    activeView = view;
    document.querySelectorAll('.view-tab').forEach((tab) => {
      tab.classList.toggle('active', tab.dataset.view === view);
    });
    viewResources.classList.toggle('active', view === 'resources');
    viewText.classList.toggle('active', view === 'text');
    viewTasks.classList.toggle('active', view === 'tasks');
    viewBilibili.classList.toggle('active', view === 'bilibili');

    if (view === 'tasks' && window.webgrabTasks) {
      window.webgrabTasks.refresh();
    }
    if (view === 'bilibili' && biliData === null && isBilibiliPage(currentPageUrl)) {
      // 用户切到 B 站 tab 但数据还没加载完，再触发一次
      fetchBiliData();
    }
    if (view === 'text') loadNovelView();
  }

  // ─── P4-1 小说 / 长文本 ────────────────────────────────

  function bindNovelEvents() {
    novelExtractChapterBtn.addEventListener('click', extractCurrentChapter);
    novelPrepareFullBtn.addEventListener('click', prepareFullNovel);
    novelConfirmStartBtn.addEventListener('click', startPreparedNovel);
    novelConfirmCancelBtn.addEventListener('click', discardPreparedNovel);
    novelCancelTaskBtn.addEventListener('click', cancelNovelTask);
    novelExportEpubBtn.addEventListener('click', exportNovelEpub);
  }

  async function loadNovelView() {
    if (!novelDetectionLoaded) {
      novelDetectionLoaded = true;
      novelPageTitle.textContent = '正在检测当前页面…';
      novelDetectionDetail.textContent = '只读取标题、段落长度和链接结构，不保存正文。';
      try {
        const response = await chrome.runtime.sendMessage({
          type: 'NOVEL_DETECT',
          tabId: currentTabId,
        });
        if (!response?.ok) throw new Error(response?.error || '检测失败');
        novelDetection = response.data;
        renderNovelDetection();
      } catch (error) {
        novelPageTitle.textContent = '当前页面无法检测';
        novelDetectionDetail.textContent = error.message || String(error);
      }
    }
    await restoreNovelState();
  }

  function renderNovelDetection() {
    if (!novelDetection?.detected) {
      novelPageTitle.textContent = novelDetection?.title || '未检测到文章或章节正文';
      novelDetectionDetail.textContent = '未检测到明显的文章或章节正文，未运行 Readability。';
      novelExtractChapterBtn.disabled = true;
      novelPrepareFullBtn.disabled = true;
      return;
    }
    novelPageTitle.textContent = novelDetection.title || '检测到可提取正文';
    novelDetectionDetail.textContent = `约 ${novelDetection.textLength || 0} 字，${novelDetection.paragraphCount || 0} 个候选段落。${novelDetection.catalogUrl ? '已找到目录候选。' : '未找到目录页。'}`;
    novelExtractChapterBtn.disabled = false;
    novelPrepareFullBtn.disabled = !novelDetection.catalogUrl;
  }

  async function extractCurrentChapter() {
    novelExtractChapterBtn.disabled = true;
    novelExtractChapterBtn.textContent = '提取中…';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NOVEL_EXTRACT_CHAPTER',
        tabId: currentTabId,
        pageUrl: currentPageUrl,
      });
      if (!response?.ok) throw new Error(response?.error || '正文提取失败');
      const result = response.data;
      const paginationWarning = result.warning || (result.hasMorePages
        ? '检测到本章还有更多分页未提取，仅显示当前页内容'
        : '');
      setExportableNovel({
        bookId: result.bookId,
        title: result.title,
        source: result.source || currentPageUrl,
        chapterCount: 1,
      });
      novelSingleResult.hidden = false;
      novelSingleResult.innerHTML = `
        <h2>${escapeHtml(result.title)}</h2>
        <p>${result.wordCount} 字 · ${result.paragraphCount} 段</p>
        <p>${escapeHtml(result.preview)}${result.wordCount > result.preview.length ? '…' : ''}</p>
        ${paginationWarning ? `<p class="novel-pagination-warning"><strong>${escapeHtml(paginationWarning)}</strong></p>` : ''}
        <p><strong>已保存到内部书库，P4-1 不生成文件。</strong></p>`;
    } catch (error) {
      novelSingleResult.hidden = false;
      novelSingleResult.innerHTML = `<h2>提取失败</h2><p>${escapeHtml(error.message || String(error))}</p>`;
    } finally {
      novelExtractChapterBtn.disabled = false;
      novelExtractChapterBtn.textContent = '提取本章';
    }
  }

  async function prepareFullNovel() {
    if (!novelDetection?.catalogUrl) return;
    novelPrepareFullBtn.disabled = true;
    novelPrepareFullBtn.textContent = '识别目录中…';
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NOVEL_PREPARE_FULL',
        tabId: currentTabId,
        pageUrl: currentPageUrl,
        pageTitle: novelDetection.title,
        catalogUrl: novelDetection.catalogUrl,
        // 阅读页自带选章列表时（catalogReason === 'current-page'），带上已经在真实
        // 渲染后 DOM 上识别出的章节列表，让准备阶段跳过对同一 URL 的静态重新抓取。
        catalogChapters: novelDetection.catalogChapters || null,
      });
      if (!response?.ok) throw new Error(response?.error || '目录识别失败');
      preparedNovel = response.data;
      await chrome.storage.local.set({ webgrab_novel_prepared_book_id: preparedNovel.id });
      renderPreparedNovel();
    } catch (error) {
      novelSingleResult.hidden = false;
      novelSingleResult.innerHTML = `<h2>全本准备失败</h2><p>${escapeHtml(error.message || String(error))}</p>`;
    } finally {
      novelPrepareFullBtn.disabled = !novelDetection?.catalogUrl;
      novelPrepareFullBtn.textContent = '提取全本';
    }
  }

  function renderPreparedNovel() {
    if (!preparedNovel) return;
    novelConfirm.hidden = false;
    novelConfirmSummary.innerHTML = `
      <p><strong>${escapeHtml(preparedNovel.title)}</strong>${preparedNovel.author ? ` · ${escapeHtml(preparedNovel.author)}` : ''}</p>
      <ul>
        <li>共识别 ${preparedNovel.detectedCount} 章，本次提取 ${preparedNovel.plannedCount} 章</li>
        ${preparedNovel.truncated ? '<li>500 章是硬上限，本次只提取前 500 章</li>' : ''}
        <li>外域链接跳过 ${preparedNovel.skippedExternalCount || 0} 条，不自动访问</li>
      </ul>`;
    const estimate = preparedNovel.estimatedDelayMinutes || { min: 0, max: 0 };
    novelEstimate.textContent = `预计等待 ${estimate.min}–${estimate.max} 分钟，不含网络响应时间。`;
  }

  async function startPreparedNovel() {
    if (!preparedNovel?.id) return;
    novelConfirmStartBtn.disabled = true;
    try {
      const response = await chrome.runtime.sendMessage({
        type: 'NOVEL_START_FULL',
        bookId: preparedNovel.id,
        tabId: currentTabId,
      });
      if (!response?.ok) throw new Error(response?.error || '任务启动失败');
      currentNovelTask = {
        id: response.data.taskId,
        kind: 'novel',
        status: 'pending',
        downloaded: 0,
        total: preparedNovel.plannedCount,
        successCount: 0,
        failureCount: 0,
        streamMeta: { kind: 'novel', bookId: preparedNovel.id },
      };
      await chrome.storage.local.remove('webgrab_novel_prepared_book_id');
      novelConfirm.hidden = true;
      renderNovelProgress(currentNovelTask, preparedNovel);
    } catch (error) {
      novelEstimate.textContent = error.message || String(error);
    } finally {
      novelConfirmStartBtn.disabled = false;
    }
  }

  async function discardPreparedNovel() {
    if (preparedNovel?.id) {
      await chrome.runtime.sendMessage({
        type: 'NOVEL_DISCARD_PREPARED',
        bookId: preparedNovel.id,
      }).catch(() => {});
    }
    preparedNovel = null;
    novelConfirm.hidden = true;
    await chrome.storage.local.remove('webgrab_novel_prepared_book_id');
  }

  async function cancelNovelTask() {
    if (!currentNovelTask?.id) return;
    novelCancelTaskBtn.disabled = true;
    await chrome.runtime.sendMessage({ type: 'CANCEL_TASK', taskId: currentNovelTask.id });
  }

  async function handleNovelTaskBroadcast(task) {
    currentNovelTask = task;
    let book = null;
    const bookId = task.streamMeta?.bookId;
    if (bookId) {
      const response = await chrome.runtime.sendMessage({
        type: 'NOVEL_GET_BOOK_STATUS',
        bookId,
      }).catch(() => null);
      book = response?.ok ? response.data : null;
    }
    renderNovelProgress(task, book);
  }

  async function restoreNovelState() {
    const taskResponse = await chrome.runtime.sendMessage({ type: 'GET_TASKS' }).catch(() => null);
    const novelTasks = taskResponse?.ok
      ? (taskResponse.data.tasks || []).filter((task) => task.kind === 'novel')
      : [];
    if (novelTasks.length) {
      await handleNovelTaskBroadcast(novelTasks[0]);
      return;
    }
    const stored = await chrome.storage.local.get('webgrab_novel_prepared_book_id');
    const bookId = stored.webgrab_novel_prepared_book_id;
    if (!bookId) return;
    const response = await chrome.runtime.sendMessage({
      type: 'NOVEL_GET_BOOK_STATUS',
      bookId,
    }).catch(() => null);
    if (response?.ok && response.data?.status === 'prepared') {
      preparedNovel = response.data;
      renderPreparedNovel();
    } else {
      await chrome.storage.local.remove('webgrab_novel_prepared_book_id');
    }
  }

  function renderNovelProgress(task, book) {
    novelProgressCard.hidden = false;
    novelProgressTitle.textContent = book?.title || task.fileName || '正文提取任务';
    const statusLabels = {
      pending: '准备中',
      extracting: '提取中',
      done: '已完成',
      failed: '失败',
      canceled: '已取消（已提取章节已保留）',
    };
    novelProgressStatus.textContent = statusLabels[task.status] || task.status;
    novelCurrentChapter.textContent = task.currentTitle
      ? `正在处理：${task.currentTitle}`
      : ['done', 'failed', 'canceled'].includes(task.status)
        ? '任务已结束'
        : '等待下一章…';
    novelProgress.max = Math.max(1, task.total || book?.plannedCount || 1);
    novelProgress.value = task.downloaded || book?.completedCount || 0;
    novelProgressCount.textContent = `第 ${novelProgress.value}/${novelProgress.max} 章`;
    novelSuccessCount.textContent = `成功 ${task.successCount ?? book?.successCount ?? 0}`;
    novelFailureCount.textContent = `失败 ${task.failureCount ?? book?.failureCount ?? 0}`;
    const failures = book?.failurePreview || [];
    novelFailureSummary.hidden = failures.length === 0;
    novelFailureSummary.innerHTML = failures.length
      ? `<strong>失败摘要</strong><ul>${failures.map((failure) => `<li>${escapeHtml(failure.title)}：${escapeHtml(failure.error)}</li>`).join('')}</ul>`
      : '';
    const terminal = ['done', 'failed', 'canceled'].includes(task.status);
    novelCancelTaskBtn.hidden = terminal;
    novelCancelTaskBtn.disabled = terminal;
    if (terminal && (task.successCount ?? book?.successCount ?? 0) > 0 && task.streamMeta?.bookId) {
      setExportableNovel({
        bookId: task.streamMeta.bookId,
        title: book?.title || task.fileName || '小说',
        source: book?.source || task.url || currentPageUrl,
        chapterCount: task.successCount ?? book?.successCount ?? 0,
      });
    }
  }

  function setExportableNovel(novel) {
    if (!novel?.bookId) return;
    exportableNovel = novel;
    novelExportCard.hidden = false;
    novelExportTitle.textContent = `导出《${novel.title || '小说'}》为 EPUB 3`;
  }

  async function exportNovelEpub() {
    if (!exportableNovel?.bookId || typeof window.showDirectoryPicker !== 'function') return;
    if (isNestedFrame) {
      novelDetectionDetail.textContent = '导出 EPUB 需要选择保存目录，悬浮窗里无法弹出选择框，请用工具栏图标或侧边栏打开 WebGrab。';
      return;
    }
    let directoryHandle;
    try {
      directoryHandle = await window.showDirectoryPicker();
    } catch (error) {
      if (error.name === 'AbortError') return;
      throw error;
    }
    novelExportEpubBtn.disabled = true;
    novelExportEpubBtn.textContent = '准备打包…';
    try {
      const pathPlan = await planResourcePath(
        { kind: 'other', title: exportableNovel.title, pageUrl: exportableNovel.source, ext: 'epub' },
        { type: 'novel', work: exportableNovel.title, title: exportableNovel.title, source: exportableNovel.source, ext: 'epub' }
      );
      const { fileSystem } = await getPathTools();
      const resolved = await fileSystem.resolveFilePath(directoryHandle, pathPlan.organizedPath, pathPlan.conflictStrategy);
      if (resolved.skipped) {
        novelDetectionDetail.textContent = '同名 EPUB 已存在，已按设置跳过。';
        return;
      }
      const hs = await getHandleStore();
      const fileHandleKey = crypto.randomUUID();
      await hs.putHandle(fileHandleKey, resolved.fileHandle);
      const response = await chrome.runtime.sendMessage({
        type: 'START_EPUB_PACKAGE',
        tabId: currentTabId,
        bookId: exportableNovel.bookId,
        fileHandleKey,
        title: exportableNovel.title,
        source: exportableNovel.source,
        chapterCount: exportableNovel.chapterCount,
        organizedPath: resolved.relativePath,
        conflictStrategy: pathPlan.conflictStrategy,
      });
      if (!response?.ok) throw new Error(response?.error || 'EPUB 打包任务启动失败');
      switchView('tasks');
    } catch (error) {
      novelDetectionDetail.textContent = `EPUB 打包失败：${error.message || error}`;
    } finally {
      novelExportEpubBtn.disabled = false;
      novelExportEpubBtn.textContent = '导出 EPUB';
    }
  }

  // ─── 批量下载 ──────────────────────────────────────────

  /**
   * 更新批量操作栏状态
   * 根据当前筛选后的资源列表和已选集合，更新全选复选框、计数和按钮
   */
  function updateBatchBar() {
    const filtered = getFilteredResources();
    const filteredUrls = new Set(filtered.map((r) => r.url));
    const selectedInFilter = [...selectedUrls].filter((u) => filteredUrls.has(u));

    batchCountEl.textContent = `已选 ${selectedInFilter.length} 项`;
    batchBar.hidden = selectedInFilter.length === 0;
    batchDownloadBtn.disabled = selectedInFilter.length === 0;
    const selectedImages = filtered.filter((resource) => selectedUrls.has(resource.url) && resource.kind === 'image');
    comicPackageBtn.disabled = selectedImages.length === 0;

    // 更新全选复选框状态
    if (selectedInFilter.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
    } else if (selectedInFilter.length === filtered.length) {
      selectAllCheckbox.checked = true;
      selectAllCheckbox.indeterminate = false;
    } else {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = true;
    }
  }

  /**
   * 切换全选/全不选（作用于当前筛选后的资源列表）
   */
  function toggleSelectAll() {
    const filtered = getFilteredResources();
    const filteredUrls = filtered.map((r) => r.url);

    if (selectAllCheckbox.checked) {
      // 全选：把当前筛选结果加入已选集合
      for (const url of filteredUrls) {
        selectedUrls.add(url);
      }
    } else {
      // 取消全选：把当前筛选结果从已选集合移除
      for (const url of filteredUrls) {
        selectedUrls.delete(url);
      }
    }
    // 重新渲染列表以更新复选框状态
    render();
    updateBatchBar();
  }

  /**
   * 批量下载选中的资源
   *
   * 流程：
   *   1. 收集选中的资源
   *   2. showDirectoryPicker() 选一次目录（一次用户授权）
   *   3. 目录句柄存 IndexedDB
   *   4. 发 START_BATCH_DOWNLOAD 给 SW
   *   5. offscreen 逐个 fetch + 写入目录
   */
  async function batchDownload() {
    const filtered = getFilteredResources();
    const selected = filtered.filter((r) => selectedUrls.has(r.url));

    if (selected.length === 0) return;

    batchDownloadBtn.disabled = true;
    batchDownloadBtn.classList.add('loading');

    try {
      // 选目录（必须在用户手势内调用）
      let dirHandle = null;
      if (isNestedFrame) {
        statusText.textContent = '批量下载需要选择保存目录，悬浮窗里无法弹出选择框，请用工具栏图标或侧边栏打开 WebGrab';
        setTimeout(() => (statusText.textContent = '就绪'), 3000);
        return;
      } else if (typeof window.showDirectoryPicker === 'function') {
        statusText.textContent = '选择保存目录…';
        try {
          dirHandle = await window.showDirectoryPicker();
        } catch (err) {
          if (err.name === 'AbortError') {
            statusText.textContent = '已取消';
            setTimeout(() => (statusText.textContent = '就绪'), 1500);
            return;
          }
          throw err;
        }
      } else {
        statusText.textContent = '浏览器不支持目录选择 API';
        setTimeout(() => (statusText.textContent = '就绪'), 2000);
        return;
      }

      if (!dirHandle) {
        statusText.textContent = '已取消';
        setTimeout(() => (statusText.textContent = '就绪'), 1500);
        return;
      }

      // 目录句柄存 IndexedDB（跟 FileSystemFileHandle 一样走结构化克隆）
      const hs = await getHandleStore();

      // 构建资源数据（只传必要字段）
      const resources = await Promise.all(selected.map(async (r) => {
        const pathPlan = await planResourcePath(r);
        return {
          url: r.url,
          kind: r.kind,
          ext: r.ext,
          mime: r.mime,
          size: r.size,
          title: r.title || extractFileName(r.url),
          pageUrl: r.pageUrl || currentPageUrl || '',
          organizedPath: pathPlan.organizedPath,
          conflictStrategy: pathPlan.conflictStrategy,
        };
      }));

      statusText.textContent = `准备批量下载 ${resources.length} 个文件…`;

      const { fileSystem, mediaOutput } = await getPathTools();
      const { adaptive, ordinary } = mediaOutput.partitionAdaptiveStreamResources(resources);
      let startedCount = 0;
      let skippedCount = 0;

      // HLS/DASH manifests are descriptions, not playable files. Give every stream
      // its own file handle and reuse START_DOWNLOAD so the existing offscreen
      // parser, segment fetcher, decryptor and muxer produce a real MP4.
      for (const streamResource of adaptive) {
        const resolved = await fileSystem.resolveFilePath(
          dirHandle,
          streamResource.organizedPath,
          streamResource.conflictStrategy
        );
        if (resolved.skipped) {
          skippedCount++;
          continue;
        }

        const fileHandleKey = crypto.randomUUID();
        await hs.putHandle(fileHandleKey, resolved.fileHandle);
        let response;
        try {
          response = await chrome.runtime.sendMessage({
            type: 'START_DOWNLOAD',
            tabId: currentTabId,
            resource: streamResource,
            fileHandleKey,
          });
        } catch (error) {
          await hs.deleteHandle(fileHandleKey).catch(() => {});
          throw error;
        }
        if (!response?.ok) {
          await hs.deleteHandle(fileHandleKey).catch(() => {});
          throw new Error(response?.error || 'START_DOWNLOAD 失败');
        }
        startedCount++;
      }

      // Ordinary files keep the bounded-concurrency batch path. Store a directory
      // handle only when a batch task will actually consume and clean it up.
      if (ordinary.length > 0) {
        const dirHandleKey = crypto.randomUUID();
        await hs.putHandle(dirHandleKey, dirHandle);
        let response;
        try {
          response = await chrome.runtime.sendMessage({
            type: 'START_BATCH_DOWNLOAD',
            tabId: currentTabId,
            resources: ordinary,
            dirHandleKey,
          });
        } catch (error) {
          await hs.deleteHandle(dirHandleKey).catch(() => {});
          throw error;
        }
        if (!response?.ok) {
          await hs.deleteHandle(dirHandleKey).catch(() => {});
          throw new Error(response?.error || 'START_BATCH_DOWNLOAD 失败');
        }
        startedCount += ordinary.length;
      }

      statusText.textContent = skippedCount > 0
        ? `下载已开始（${startedCount} 个，跳过 ${skippedCount} 个已存在文件）`
        : `下载已开始（${startedCount} 个文件）`;
      setTimeout(() => (statusText.textContent = '就绪'), 3000);
      switchView('tasks');

      // 清空选中状态
      selectedUrls.clear();
    } catch (err) {
      console.error('[WebGrab] 批量下载启动失败:', err);
      statusText.textContent = '批量下载失败: ' + (err.message || err);
      setTimeout(() => (statusText.textContent = '就绪'), 3000);
    } finally {
      batchDownloadBtn.classList.remove('loading');
      updateBatchBar();
    }
  }

  async function packageSelectedComic() {
    const selected = getFilteredResources().filter((resource) => selectedUrls.has(resource.url) && resource.kind === 'image');
    if (!selected.length || typeof window.showDirectoryPicker !== 'function') return;
    if (isNestedFrame) {
      statusText.textContent = '打包漫画需要选择保存目录，悬浮窗里无法弹出选择框，请用工具栏图标或侧边栏打开 WebGrab';
      setTimeout(() => (statusText.textContent = '就绪'), 3000);
      return;
    }
    comicPackageBtn.disabled = true;
    comicPackageBtn.classList.add('loading');
    try {
      const directoryHandle = await window.showDirectoryPicker();
      const hs = await getHandleStore();
      const dirHandleKey = crypto.randomUUID();
      await hs.putHandle(dirHandleKey, directoryHandle);
      const resources = selected.map((resource) => ({
        url: resource.url,
        kind: resource.kind,
        ext: resource.ext,
        mime: resource.mime,
        size: resource.size,
        title: resource.title || extractFileName(resource.url),
        pageUrl: resource.pageUrl || currentPageUrl || '',
        domIndex: Number.isFinite(resource.domIndex) ? resource.domIndex : null,
      }));
      const pageIdentity = inferPageWorkChapter();
      const packagePlan = await planResourcePath(
        { kind: 'image', title: currentPageTitle || '漫画', pageUrl: currentPageUrl, ext: 'cbz' },
        { type: 'comic', work: pageIdentity.work, chapter: pageIdentity.chapter, title: pageIdentity.chapter, ext: 'cbz' }
      );
      const response = await chrome.runtime.sendMessage({
        type: 'START_COMIC_PACKAGE',
        tabId: currentTabId,
        resources,
        dirHandleKey,
        mode: comicModeSelect.value,
        title: currentPageTitle || 'WebGrab 漫画',
        source: currentPageUrl,
        organizedPath: packagePlan.organizedPath,
        conflictStrategy: packagePlan.conflictStrategy,
      });
      if (!response?.ok) throw new Error(response?.error || '漫画打包任务启动失败');
      statusText.textContent = `漫画打包已开始（${resources.length} 页）`;
      switchView('tasks');
      selectedUrls.clear();
    } catch (error) {
      if (error.name !== 'AbortError') {
        statusText.textContent = `漫画打包失败：${error.message || error}`;
      }
    } finally {
      comicPackageBtn.classList.remove('loading');
      updateBatchBar();
    }
  }

  // 批量操作栏事件
  selectAllCheckbox.addEventListener('change', toggleSelectAll);
  batchDownloadBtn.addEventListener('click', batchDownload);
  comicPackageBtn.addEventListener('click', packageSelectedComic);
  batchCancel.addEventListener('click', () => {
    selectedUrls.clear();
    render();
  });

  /**
   * 渲染任务 badge。
   *
   * 计数来自 tasks.js 统一维护的任务表（TASK_BROADCAST 推送 + 3 秒兜底轮询），
   * 不再单独发 GET_TASKS 重新拉取一遍再自己算一次——徽章数字和任务面板数字
   * 曾经对不上，根因就是两处各自独立轮询、独立判定"进行中"，天然会不同步。
   * @param {number} count
   */
  function renderTaskBadge(count) {
    activeTaskCount = count;
    if (count > 0) {
      taskBadge.textContent = count > 99 ? '99+' : count;
      taskBadge.style.display = 'inline-block';
    } else {
      taskBadge.style.display = 'none';
    }
  }

  // ─── 下载流程 ──────────────────────────────────────────

  /**
   * 判断资源是否需要走流式写盘路径（showSaveFilePicker + FileWriter）
   *
   * 视频/流媒体/大文件需要：流式写盘避免内存爆炸
   * 图片/小文件不需要：直接用 chrome.downloads.download() 落地即可
   *
   * @param {Object} resource
   * @returns {boolean}
   */
  function needsFileStreamable(resource) {
    if (resource.kind === 'video' || resource.kind === 'stream') return true;
    if (resource.ext === 'm3u8' || resource.ext === 'm3u' || resource.ext === 'mpd') return true;
    if (resource.size > 50 * 1024 * 1024) return true;
    return false;
  }

  async function startDownload(resource, btn) {
    if (btn) {
      btn.classList.add('loading');
      btn.disabled = true;
    }

    try {
      let fileHandle = null;
      let directoryPromise = null;

      // 目录选择必须在点击事件的用户手势中立刻触发；路径设置读取放在其后。
      // 悬浮窗嵌套 iframe 里这个 API 会被浏览器拒绝，跳过选择器，让 fileHandle 保持 null——
      // 后端 FileWriter 有对应的 Blob 模式兜底（≤50MB 直接存到默认下载目录）。
      if (needsFileStreamable(resource) && typeof window.showDirectoryPicker === 'function' && !isNestedFrame) {
        statusText.textContent = '选择保存根目录…';
        directoryPromise = window.showDirectoryPicker();
      }

      const pathPlan = await planResourcePath(resource);
      const outputResource = pathPlan.outputResource;

      // 只有需要流式写盘的资源才弹原生保存对话框
      // 图片等小文件直接走 chrome.downloads.download()，不弹任何对话框
      if (needsFileStreamable(resource)) {
        // 立即在用户手势内选择文件位置（不等任何 await）
        // showSaveFilePicker 要求 transient user activation，中间的消息往返可能耗尽手势窗口
        const suggestedName = buildSuggestedName(outputResource);

        if (directoryPromise) {
          const directoryHandle = await directoryPromise;
          const { fileSystem } = await getPathTools();
          const resolved = await fileSystem.resolveFilePath(
            directoryHandle,
            pathPlan.organizedPath,
            pathPlan.conflictStrategy
          );
          if (resolved.skipped) {
            statusText.textContent = '同名文件已存在，已跳过';
            setTimeout(() => (statusText.textContent = '就绪'), 1800);
            return;
          }
          fileHandle = resolved.fileHandle;
        } else if (typeof window.showSaveFilePicker === 'function' && !isNestedFrame) {
          statusText.textContent = '选择保存位置…';
          fileHandle = await pickSaveFile(suggestedName);

          if (!fileHandle) {
            // 用户取消选择文件
            statusText.textContent = '已取消';
            setTimeout(() => (statusText.textContent = '就绪'), 1500);
            return;
          }
        }
      }

      // 2. 把句柄存入 IndexedDB，消息只传 key（FileSystemFileHandle 过不了 JSON 序列化）
      //    popup 和 offscreen 共享扩展 origin 的 IndexedDB
      let fileHandleKey = null;
      if (fileHandle) {
        const hs = await getHandleStore();
        fileHandleKey = crypto.randomUUID();
        await hs.putHandle(fileHandleKey, fileHandle);
      }

      // 3. 把 resource + fileHandleKey 发给 SW
      //    SW 会创建任务、申请 DNR、启动 offscreen 执行
      if (needsFileStreamable(resource) && !fileHandleKey && isNestedFrame) {
        statusText.textContent = '悬浮窗无法选择目录，改存默认下载目录（超过 50MB 会失败）…';
      } else {
        statusText.textContent = '准备下载…';
      }

      // 派发失败时必须把刚存进 IndexedDB 的句柄删掉：没有任何一方会再来收尾，
      // 留下的句柄会一直占着写入授权（与批量/EPUB 路径的处理保持一致）。
      const releaseHandleOnFailure = async () => {
        if (!fileHandleKey) return;
        const hs = await getHandleStore();
        await hs.deleteHandle(fileHandleKey).catch(() => {});
      };

      let response;
      try {
        response = await chrome.runtime.sendMessage({
          type: 'START_DOWNLOAD',
          tabId: currentTabId,
          resource: {
            url: outputResource.url,
            kind: outputResource.kind,
            ext: outputResource.ext,
            mime: outputResource.mime,
            size: outputResource.size,
            title: outputResource.title || extractFileName(outputResource.url),
            backupUrls: Array.isArray(outputResource.backupUrls) ? outputResource.backupUrls : [],
            // 来源页 URL：用于 GenericAdapter 在防盗链失败时注入 Referer 重试
            // resource.pageUrl 由 resource-store 登记时写入；fallback 到当前标签页 URL
            pageUrl: outputResource.pageUrl || currentPageUrl || '',
            organizedPath: pathPlan.organizedPath,
            conflictStrategy: pathPlan.conflictStrategy,
          },
          fileHandleKey, // 可能为 null（API 不可用时或用户未选），SW 据此决定走哪条路径
        });
      } catch (error) {
        await releaseHandleOnFailure();
        throw error;
      }

      if (!response || !response.ok) {
        await releaseHandleOnFailure();
        throw new Error(response?.error || 'START_DOWNLOAD 失败');
      }

      const data = response.data;

      if (data.method === 'skipped') {
        statusText.textContent = '同名文件已存在，已跳过';
        setTimeout(() => (statusText.textContent = '就绪'), 1800);
        switchView('tasks');
        return;
      }

      // 直接下载路径（小文件 + 无 DNR + 无 fileHandle）
      if (data.method === 'direct') {
        statusText.textContent = '已交给浏览器下载';
        setTimeout(() => (statusText.textContent = '就绪'), 2500);
        switchView('tasks');
        return;
      }

      // offscreen 路径（SW 已异步开始执行）
      statusText.textContent = '下载已开始';
      setTimeout(() => (statusText.textContent = '就绪'), 2000);
      switchView('tasks');
    } catch (err) {
      if (err?.name === 'AbortError') {
        statusText.textContent = '已取消';
        setTimeout(() => (statusText.textContent = '就绪'), 1500);
        return;
      }
      console.error('[WebGrab] 下载启动失败:', err);
      statusText.textContent = '下载失败: ' + (err.message || err);
      setTimeout(() => (statusText.textContent = '就绪'), 3000);
    } finally {
      if (btn) {
        btn.classList.remove('loading');
        btn.disabled = false;
      }
    }
  }

  /**
   * 构建建议文件名（用于 showSaveFilePicker）
   * 与 SW 中的 buildFileName 逻辑保持一致，但这里只是建议值
   * @param {Object} resource
   * @returns {string}
   */
  function buildSuggestedName(resource) {
    let name = '';
    if (resource.title && resource.title.trim()) {
      name = resource.title.trim();
    } else {
      name = extractFileName(resource.url) || 'download';
    }
    if (resource.ext && !name.toLowerCase().endsWith('.' + resource.ext.toLowerCase())) {
      name = name + '.' + resource.ext;
    }
    return name;
  }

  /**
   * 调用 showSaveFilePicker 选择保存位置
   * @param {string} suggestedName
   * @returns {Promise<FileSystemFileHandle|null>}
   */
  async function pickSaveFile(suggestedName) {
    if (typeof window.showSaveFilePicker !== 'function') {
      // API 不可用，提示用户
      statusText.textContent = '浏览器不支持文件选择 API';
      return null;
    }
    try {
      const handle = await window.showSaveFilePicker({
        suggestedName: suggestedName || 'download',
      });
      return handle;
    } catch (err) {
      if (err.name === 'AbortError') return null;
      console.warn('[WebGrab] 文件选择失败:', err);
      return null;
    }
  }

  // ─── 图片悬停预览 ──────────────────────────────────────
  let previewEl = null;

  function attachPreview(thumbEl, url) {
    thumbEl.addEventListener('mouseenter', (e) => {
      if (!previewEl) {
        previewEl = document.createElement('div');
        previewEl.className = 'preview-tooltip';
        document.body.appendChild(previewEl);
      }
      previewEl.innerHTML = '';
      const img = document.createElement('img');
      img.src = url;
      previewEl.appendChild(img);
      previewEl.style.display = 'block';

      // 定位
      const rect = thumbEl.getBoundingClientRect();
      const popupWidth = 300;
      let left = rect.right + 8;
      if (left + popupWidth > window.innerWidth) {
        left = rect.left - popupWidth - 8;
      }
      previewEl.style.left = Math.max(4, left) + 'px';
      previewEl.style.top = Math.max(4, rect.top - 100) + 'px';
    });

    thumbEl.addEventListener('mouseleave', () => {
      if (previewEl) {
        previewEl.style.display = 'none';
      }
    });
  }

  // ─── 复制 URL ──────────────────────────────────────────
  async function copyUrl(url, btn) {
    try {
      await navigator.clipboard.writeText(url);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    } catch {
      // 降级方案
      const textarea = document.createElement('textarea');
      textarea.value = url;
      textarea.style.position = 'fixed';
      textarea.style.opacity = '0';
      document.body.appendChild(textarea);
      textarea.select();
      document.execCommand('copy');
      document.body.removeChild(textarea);
      btn.classList.add('copied');
      setTimeout(() => btn.classList.remove('copied'), 1200);
    }
  }

  // ─── Tab 计数更新 ──────────────────────────────────────
  function updateTabCounts() {
    const counts = { all: 0, video: 0, audio: 0, image: 0, other: 0 };
    for (const r of currentDisplayResources) {
      counts.all++;
      if (r.kind === 'video' || r.kind === 'stream') counts.video++;
      else if (r.kind === 'audio') counts.audio++;
      else if (r.kind === 'image') counts.image++;
      else counts.other++;
    }

    for (const [key, val] of Object.entries(counts)) {
      const el = document.querySelector(`[data-count="${key}"]`);
      if (el) el.textContent = val;
    }
  }

  /**
   * 更新底部来源统计
   */
  function updateSourceStats() {
    const sources = { network: 0, dom: 0, hook: 0 };
    for (const r of currentDisplayResources) {
      if (sources[r.source] != null) sources[r.source]++;
    }
    const parts = [];
    if (sources.network) parts.push(`NET ${sources.network}`);
    if (sources.dom) parts.push(`DOM ${sources.dom}`);
    if (sources.hook) parts.push(`HOOK ${sources.hook}`);
    sourceStats.textContent = parts.join(' ');
  }

  // ─── 辅助函数 ──────────────────────────────────────────

  /**
   * 格式化文件大小
   * @param {number} bytes
   * @returns {string}
   */
  function formatSize(bytes) {
    if (bytes < 0) return '?';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
  }

  /**
   * 从 URL 提取文件名
   * @param {string} url
   * @returns {string}
   */
  function extractFileName(url) {
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
   * 复制图标 SVG
   * @returns {string}
   */
  function copyIconSvg() {
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><rect x="5" y="5" width="8" height="8" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M3 11V3a1 1 0 0 1 1-1h7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>';
  }

  /**
   * 下载图标 SVG
   * @returns {string}
   */
  function downloadIconSvg() {
    return '<svg width="14" height="14" viewBox="0 0 16 16" fill="none"><path d="M8 2v8m0 0l3-3m-3 3L5 7M3 13h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  }

  // ─── B 站视图 ──────────────────────────────────────────

  /** 编码组显示名映射 */
  const CODEC_LABELS = {
    avc1: 'AVC (H.264)',
    hev1: 'HEVC (H.265)',
    hvc1: 'HEVC (H.265)',
    av01: 'AV1',
  };

  /** 默认编码优先级（AVC 兼容性最好，remux 最快） */
  const CODEC_PRIORITY = ['avc1', 'hev1', 'hvc1', 'av01'];

  /**
   * 检测 URL 是否为 B 站页面
   * @param {string} url
   * @returns {boolean}
   */
  function isBilibiliPage(url) {
    if (!url) return false;
    return /bilibili\.com\/(video\/BV|bangumi\/play)/.test(url) || /live\.bilibili\.com/.test(url);
  }

  /**
   * 从 SW 获取 B 站提取数据
   */
  async function fetchBiliData() {
    if (!isBilibiliPage(currentPageUrl) || currentTabId < 0) return;

    // 显示加载中
    biliContainer.innerHTML = '';
    const loading = document.createElement('div');
    loading.className = 'bili-loading';
    loading.innerHTML = '<div class="spinner"></div><p>正在读取播放信息…</p>';
    biliContainer.appendChild(loading);

    try {
      const response = await chrome.runtime.sendMessage({
        type: 'GET_EXTRACT',
        tabId: currentTabId,
        pageUrl: currentPageUrl,
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || '获取 B 站数据失败');
      }

      biliData = response.data;
      initBiliSelection();
      renderBiliView();
    } catch (err) {
      biliContainer.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className = 'bili-unsupported';
      errEl.innerHTML = `
        <div class="icon">⚠️</div>
        <div class="title">数据获取失败</div>
        <div class="reason">${escapeHtml(err.message || String(err))}<br>请刷新播放页后重试</div>
      `;
      biliContainer.appendChild(errEl);
    }
  }

  /**
   * 构造目标分 P 的 URL
   *
   * 两种页面类型：
   *   - 普通投稿（/video/BV...）：在 URL 上设置 ?p=partNumber
   *   - 番剧（/bangumi/play/epXXX）：替换路径为 /bangumi/play/ep<目标epId>
   *
   * 两种都是 B 站官方支持的导航方式（用户在地址栏手打也能达到同样效果），
   * 是正常浏览器导航，不是伪造接口请求。
   *
   * @param {string} currentUrl - 当前页面 URL
   * @param {number} partNumber - 分 P 序号（1-based，仅普通投稿用）
   * @param {Object} part - 目标分 P 对象（番剧需要 epId 字段）
   * @returns {string}
   */
  function buildPartUrl(currentUrl, partNumber, part) {
    try {
      const u = new URL(currentUrl);
      // 番剧：用 ep_id 切换
      if (/\/bangumi\/play\/ep/.test(u.pathname)) {
        if (part?.epId) {
          u.pathname = `/bangumi/play/ep${part.epId}`;
          return u.toString();
        }
        // 没拿到 epId 兜底（理论上不会走到，番剧 parts 必含 epId）
        return currentUrl;
      }
      // 普通投稿：用 ?p=N 切换
      u.searchParams.set('p', String(partNumber));
      return u.toString();
    } catch {
      // URL 解析失败兜底（理论上不会走到）
      return currentUrl;
    }
  }

  /**
   * 发起分 P 切换
   *
   * 流程：
   *   1. 设置 switchingPart 状态，立即渲染 UI 显示"正在切换到 P{n}…"
   *   2. 发 SWITCH_BILI_PART 消息给 SW（带递增 requestId 做竞态控制）
   *   3. SW 负责 chrome.tabs.update 导航 + 轮询 probe 等 currentCid 匹配
   *   4. 成功：用新数据替换 biliData，initBiliSelection + renderBiliView
   *   5. 失败/超时：显示错误提示
   *   6. 被覆盖（用户又选了另一个 P）：静默退出，不做任何 UI 更新
   *
   * @param {number} partIndex - 目标分 P 索引（0-based）
   * @param {Object} part - 目标分 P 对象（含 cid）
   */
  async function initiatePartSwitch(partIndex, part) {
    const myRequestId = ++switchRequestId;
    switchingPart = { requestId: myRequestId, targetPartIndex: partIndex };

    // 立即渲染，显示切换中状态
    renderBiliView();

    try {
      const targetUrl = buildPartUrl(currentPageUrl, partIndex + 1, part);
      const targetCid = part.cid;

      const response = await chrome.runtime.sendMessage({
        type: 'SWITCH_BILI_PART',
        tabId: currentTabId,
        targetUrl,
        targetCid,
        requestId: myRequestId,
      });

      // 检查是否被新请求覆盖
      if (!switchingPart || switchingPart.requestId !== myRequestId) {
        // 已被覆盖，静默退出（新请求会负责 UI 更新）
        return;
      }

      if (!response || !response.ok) {
        // 超时或失败：显示错误，保持当前 biliData 不变（用户仍能选回当前 P）
        switchingPart = null;
        const errMsg = response?.error || '切换分 P 失败';
        // 如果是权限受限等导致的新数据无流，adapter.extract 会返回 unsupportedReason
        // 这里展示明确错误提示
        biliContainer.innerHTML = '';
        const errEl = document.createElement('div');
        errEl.className = 'bili-unsupported';
        errEl.innerHTML = `
          <div class="icon">⚠️</div>
          <div class="title">切换分 P 失败</div>
          <div class="reason">${escapeHtml(errMsg)}</div>
        `;
        biliContainer.appendChild(errEl);
        return;
      }

      // 成功：用新数据替换
      // 注意：如果新分 P 权限受限（大会员专享等），adapter.extract 会返回
      // unsupportedReason，此时 biliData 仍然更新（包含 parts 信息），
      // renderBiliView 会显示 unsupportedReason 提示，把错误透传给用户
      biliData = response.data;
      switchingPart = null;
      // currentPageUrl 需要更新为导航后的 URL（避免后续操作用旧 URL）
      currentPageUrl = targetUrl;
      initBiliSelection();
      renderBiliView();
    } catch (err) {
      if (!switchingPart || switchingPart.requestId !== myRequestId) {
        return; // 被覆盖
      }
      switchingPart = null;
      biliContainer.innerHTML = '';
      const errEl = document.createElement('div');
      errEl.className = 'bili-unsupported';
      errEl.innerHTML = `
        <div class="icon">⚠️</div>
        <div class="title">切换分 P 失败</div>
        <div class="reason">${escapeHtml(err.message || String(err))}</div>
      `;
      biliContainer.appendChild(errEl);
    }
  }

  /**
   * 按 qualityId 分组变体
   * @param {Array} variants
   * @returns {Object<number, Array>}
   */
  function groupVariantsByQuality(variants) {
    const groups = {};
    for (const v of variants) {
      if (!groups[v.qualityId]) groups[v.qualityId] = [];
      groups[v.qualityId].push(v);
    }
    return groups;
  }

  /**
   * 对编码组按优先级排序
   * @param {string[]} codecGroups
   */
  function sortCodecGroups(codecGroups) {
    return [...codecGroups].sort((a, b) => {
      const ai = CODEC_PRIORITY.indexOf(a);
      const bi = CODEC_PRIORITY.indexOf(b);
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });
  }

  /**
   * 初始化默认选择（最高质量 + AVC 编码 + 标准音频）
   */
  function initBiliSelection() {
    if (!biliData || !biliData.parts || biliData.parts.length === 0) return;

    // 找当前 P
    const currentPartIndex = biliData.parts.findIndex((p) => p.isCurrent);
    selectedPartIndex = currentPartIndex >= 0 ? currentPartIndex : 0;

    const part = biliData.parts[selectedPartIndex];
    if (!part || part.variants.length === 0) return;

    // 默认选最高质量
    const qualityGroups = groupVariantsByQuality(part.variants);
    const qualityIds = Object.keys(qualityGroups).map(Number).sort((a, b) => b - a);
    selectedQualityId = qualityIds[0];

    // 默认选 AVC（优先级最高）
    const codecs = qualityGroups[selectedQualityId] || [];
    const codecGroups = sortCodecGroups([...new Set(codecs.map((v) => v.codecGroup))]);
    selectedCodecGroup = codecGroups[0];

    updateSelectedVariant();

    // 默认音频选项
    if (biliData.audioOptions && biliData.audioOptions.length > 0) {
      selectedAudioOption = biliData.audioOptions[0];
    } else {
      selectedAudioOption = null;
    }
  }

  /**
   * 更新 selectedVariant
   */
  function updateSelectedVariant() {
    if (!biliData) return;
    const part = biliData.parts[selectedPartIndex];
    if (!part || part.variants.length === 0) {
      selectedVariant = null;
      return;
    }
    selectedVariant = part.variants.find(
      (v) => v.qualityId === selectedQualityId && v.codecGroup === selectedCodecGroup
    ) || null;
  }

  /**
   * 渲染 B 站视图
   */
  function renderBiliView() {
    biliContainer.innerHTML = '';

    if (!biliData) return;

    // 悬浮窗是双层跨域嵌套 iframe：原生 <select> 弹层在这种环境下有已知的展示问题，
    // 且大文件下载需要的目录选择器也会被浏览器直接拒绝。与其让用户点了没反应，
    // 不如直接引导去真正的顶层文档（工具栏弹窗 / 侧边栏）。
    if (isNestedFrame) {
      const el = document.createElement('div');
      el.className = 'bili-unsupported';
      el.innerHTML = `
        <div class="icon">📺</div>
        <div class="title">请用工具栏图标或侧边栏</div>
        <div class="reason">B 站清晰度选择和下载需要浏览器顶层窗口的权限，悬浮窗这层嵌套面板里无法可靠使用。点击浏览器工具栏的 WebGrab 图标，或在 popup 里点"在侧边栏中打开"。</div>
      `;
      biliContainer.appendChild(el);
      return;
    }

    // 不支持的页面
    if (biliData.unsupportedReason) {
      // "未找到可下载的视频流" 常见于页面刚打开、播放数据还没加载完就查询的情况，
      // 属于时序问题而非永久不支持，给出重试入口
      const isRetryable = biliData.unsupportedReason.includes('未找到可下载的视频流');
      const el = document.createElement('div');
      el.className = 'bili-unsupported';
      el.innerHTML = `
        <div class="icon">📺</div>
        <div class="title">暂不支持</div>
        <div class="reason">${escapeHtml(biliData.unsupportedReason)}</div>
        ${isRetryable ? '<div class="reason">如果视频能正常播放，可能是数据还没加载完，等几秒后点下面按钮重试</div><button type="button" class="bili-download-btn bili-retry-btn">重新获取</button>' : ''}
      `;
      if (isRetryable) {
        el.querySelector('.bili-retry-btn')?.addEventListener('click', () => fetchBiliData());
      }
      biliContainer.appendChild(el);
      return;
    }

    // 视频信息头部
    const info = document.createElement('div');
    info.className = 'bili-info';
    const titleEl = document.createElement('div');
    titleEl.className = 'bili-title';
    titleEl.textContent = biliData.title || '未知标题';
    info.appendChild(titleEl);

    if (biliData.uploader || biliData.bvid) {
      const meta = document.createElement('div');
      meta.className = 'bili-meta';
      if (biliData.uploader) {
        const up = document.createElement('span');
        up.className = 'bili-up';
        up.textContent = 'UP: ' + biliData.uploader;
        meta.appendChild(up);
      }
      if (biliData.bvid) {
        const bvid = document.createElement('span');
        bvid.className = 'bili-bvid';
        bvid.textContent = biliData.bvid;
        meta.appendChild(bvid);
      }
      info.appendChild(meta);
    }
    biliContainer.appendChild(info);

    const part = biliData.parts[selectedPartIndex];
    if (!part) return;

    // 分 P 选择（多于 1 个 P 才显示）
    // 注意：必须渲染在 variants 检查之前，这样切换中状态（variants 为空）时
    // 用户仍能通过 partSelect 选另一个 P 来覆盖当前切换
    if (biliData.parts.length > 1) {
      const partField = document.createElement('div');
      partField.className = 'bili-field';
      const partLabel = document.createElement('label');
      partLabel.className = 'bili-field-label';
      partLabel.textContent = '分 P';
      partField.appendChild(partLabel);

      const partSelect = document.createElement('select');
      partSelect.className = 'bili-select';
      biliData.parts.forEach((p, i) => {
        const opt = document.createElement('option');
        opt.value = i;
        opt.textContent = `P${i + 1} ${p.title || ''}`;
        if (i === selectedPartIndex) opt.selected = true;
        partSelect.appendChild(opt);
      });
      partSelect.addEventListener('change', () => {
        selectedPartIndex = parseInt(partSelect.value, 10);
        const newPart = biliData.parts[selectedPartIndex];

        if (newPart && newPart.needSwitch) {
          // 目标分 P 不是当前播放的 P：触发页面导航 + 等待新播放清单
          // 不在此处初始化 quality/codec（等新数据回来后由 initBiliSelection 处理）
          initiatePartSwitch(selectedPartIndex, newPart);
        } else {
          // 当前 P 或已有缓存数据：走原逻辑
          if (newPart && newPart.variants.length > 0) {
            const groups = groupVariantsByQuality(newPart.variants);
            const qids = Object.keys(groups).map(Number).sort((a, b) => b - a);
            selectedQualityId = qids[0];
            const codecs = groups[selectedQualityId] || [];
            const codecGroups = sortCodecGroups([...new Set(codecs.map((v) => v.codecGroup))]);
            selectedCodecGroup = codecGroups[0];
            updateSelectedVariant();
          }
          renderBiliView();
        }
      });
      partField.appendChild(partSelect);
      biliContainer.appendChild(partField);
    }

    // 当前 P 无变体数据（需要先在页面上切换到该 P）
    if (part.variants.length === 0) {
      // 切换中状态：显示进度提示（partSelect 已在上面渲染，用户可覆盖）
      if (switchingPart) {
        const hint = document.createElement('div');
        hint.className = 'bili-switching';
        hint.innerHTML = `<div class="spinner"></div><p>正在切换到 P${switchingPart.targetPartIndex + 1}…</p>`;
        biliContainer.appendChild(hint);
        return;
      }

      // 非切换中：提示手动刷新
      const hint = document.createElement('div');
      hint.className = 'bili-note';
      hint.textContent = '此分 P 尚未加载播放清单。请在页面上播放该分 P，然后点击下方按钮刷新。';
      biliContainer.appendChild(hint);

      const refreshBtn = document.createElement('button');
      refreshBtn.className = 'bili-download-btn';
      refreshBtn.textContent = '刷新播放清单';
      refreshBtn.addEventListener('click', () => fetchBiliData());
      biliContainer.appendChild(refreshBtn);
      return;
    }

    // 清晰度 + 编码（两列网格）
    const qualityGroups = groupVariantsByQuality(part.variants);
    const qualityIds = Object.keys(qualityGroups).map(Number).sort((a, b) => b - a);

    const fields = document.createElement('div');
    fields.className = 'bili-fields';

    // 清晰度下拉
    const qualityField = document.createElement('div');
    qualityField.className = 'bili-field';
    const qualityLabel = document.createElement('label');
    qualityLabel.className = 'bili-field-label';
    qualityLabel.textContent = '清晰度';
    qualityField.appendChild(qualityLabel);

    const qualitySelect = document.createElement('select');
    qualitySelect.className = 'bili-select';
    for (const qid of qualityIds) {
      const label = qualityGroups[qid][0].qualityLabel || String(qid);
      const opt = document.createElement('option');
      opt.value = qid;
      opt.textContent = label;
      if (qid === selectedQualityId) opt.selected = true;
      qualitySelect.appendChild(opt);
    }
    qualitySelect.addEventListener('change', () => {
      selectedQualityId = parseInt(qualitySelect.value, 10);
      // 更新编码下拉为该质量下的可用编码
      const codecs = qualityGroups[selectedQualityId] || [];
      const codecGroups = sortCodecGroups([...new Set(codecs.map((v) => v.codecGroup))]);
      selectedCodecGroup = codecGroups[0] || selectedCodecGroup;
      updateSelectedVariant();
      renderBiliView();
    });
    qualityField.appendChild(qualitySelect);
    fields.appendChild(qualityField);

    // 编码下拉
    const currentCodecs = qualityGroups[selectedQualityId] || [];
    const availableCodecGroups = sortCodecGroups([...new Set(currentCodecs.map((v) => v.codecGroup))]);

    const codecField = document.createElement('div');
    codecField.className = 'bili-field';
    const codecLabel = document.createElement('label');
    codecLabel.className = 'bili-field-label';
    codecLabel.textContent = '编码';
    codecField.appendChild(codecLabel);

    const codecSelect = document.createElement('select');
    codecSelect.className = 'bili-select';
    for (const cg of availableCodecGroups) {
      const opt = document.createElement('option');
      opt.value = cg;
      opt.textContent = CODEC_LABELS[cg] || cg;
      if (cg === selectedCodecGroup) opt.selected = true;
      codecSelect.appendChild(opt);
    }
    codecSelect.addEventListener('change', () => {
      selectedCodecGroup = codecSelect.value;
      updateSelectedVariant();
    });
    codecField.appendChild(codecSelect);
    fields.appendChild(codecField);

    biliContainer.appendChild(fields);

    // 音频选项
    if (biliData.audioOptions && biliData.audioOptions.length > 0) {
      const audioField = document.createElement('div');
      audioField.className = 'bili-field';
      const audioLabel = document.createElement('label');
      audioLabel.className = 'bili-field-label';
      audioLabel.textContent = '音频';
      audioField.appendChild(audioLabel);

      const audioSelect = document.createElement('select');
      audioSelect.className = 'bili-select';
      for (const opt of biliData.audioOptions) {
        const o = document.createElement('option');
        o.value = opt.id;
        const bwStr = opt.bandwidth ? ` (${Math.round(opt.bandwidth / 1000)} kbps)` : '';
        o.textContent = opt.label + bwStr;
        if (selectedAudioOption && opt.id === selectedAudioOption.id) o.selected = true;
        audioSelect.appendChild(o);
      }
      audioSelect.addEventListener('change', () => {
        selectedAudioOption = biliData.audioOptions.find((a) => a.id === audioSelect.value) || null;
      });
      audioField.appendChild(audioSelect);
      biliContainer.appendChild(audioField);
    }

    // 提示信息
    if (biliData.maxQualityNote) {
      const note = document.createElement('div');
      note.className = 'bili-note';
      note.textContent = biliData.maxQualityNote;
      biliContainer.appendChild(note);
    }

    // 下载按钮
    const dlBtn = document.createElement('button');
    dlBtn.className = 'bili-download-btn';
    dlBtn.textContent = '下载 MP4';
    dlBtn.disabled = !selectedVariant;
    dlBtn.addEventListener('click', () => startBilibiliDownload(dlBtn));
    biliContainer.appendChild(dlBtn);
  }

  /**
   * 启动 B 站下载
   *
   * 手势保护：showSaveFilePicker 在点击后立即调用，不等消息往返。
   * @param {HTMLButtonElement} btn
   */
  async function startBilibiliDownload(btn) {
    if (!selectedVariant) return;

    btn.classList.add('loading');
    btn.disabled = true;

    try {
      // 1. 立即在用户手势内选择保存位置
      const part = biliData.parts[selectedPartIndex];
      const partIndex = biliData.parts.length > 1 ? selectedPartIndex + 1 : null;
      const partTitle = biliData.parts.length > 1 ? (part.title || '') : null;
      const suggestedName = buildBiliFileName(biliData, selectedVariant, partIndex, partTitle);

      let fileHandle = null;
      let pathPlan = null;
      // 悬浮窗嵌套 iframe 里这两个 API 都会被拒绝，跳过后靠后端 Blob 模式兜底（≤50MB）。
      if (typeof window.showDirectoryPicker === 'function' && !isNestedFrame) {
        statusText.textContent = '选择保存位置…';
        const directoryHandle = await window.showDirectoryPicker();
        pathPlan = await planResourcePath(
          { kind: 'video', title: suggestedName, pageUrl: currentPageUrl, ext: 'mp4' },
          { type: 'video', site: '哔哩哔哩', work: biliData.title, title: titleWithoutExtension(suggestedName), ext: 'mp4' }
        );
        const { fileSystem } = await getPathTools();
        const resolved = await fileSystem.resolveFilePath(directoryHandle, pathPlan.organizedPath, pathPlan.conflictStrategy);
        if (resolved.skipped) {
          statusText.textContent = '同名文件已存在，已跳过';
          setTimeout(() => (statusText.textContent = '就绪'), 1800);
          return;
        }
        fileHandle = resolved.fileHandle;
        pathPlan.organizedPath = resolved.relativePath;
      } else if (typeof window.showSaveFilePicker === 'function' && !isNestedFrame) {
        fileHandle = await pickSaveFile(suggestedName);
      }

      // 2. 把句柄存入 IndexedDB，消息只传 key（FileSystemFileHandle 过不了 JSON 序列化）
      let fileHandleKey = null;
      if (fileHandle) {
        const hs = await getHandleStore();
        fileHandleKey = crypto.randomUUID();
        await hs.putHandle(fileHandleKey, fileHandle);
      } else if (isNestedFrame) {
        statusText.textContent = '悬浮窗无法选择目录，改存默认下载目录（超过 50MB 会失败）…';
      }

      // 3. 构建变体数据（只传必要字段，避免序列化问题）
      const videoVariant = {
        urls: selectedVariant.urls,
        codecs: selectedVariant.codecs,
        codecGroup: selectedVariant.codecGroup,
        segmentBase: selectedVariant.segmentBase,
        width: selectedVariant.width,
        height: selectedVariant.height,
        bandwidth: selectedVariant.bandwidth,
        qualityLabel: selectedVariant.qualityLabel,
        qualityId: selectedVariant.qualityId,
      };

      const audioVariant = selectedAudioOption
        ? {
            urls: selectedAudioOption.urls,
            codecs: selectedAudioOption.codecs,
            segmentBase: selectedAudioOption.segmentBase,
            bandwidth: selectedAudioOption.bandwidth,
          }
        : null;

      // 4. 发给 SW
      statusText.textContent = '准备下载…';
      const response = await chrome.runtime.sendMessage({
        type: 'START_BILIBILI_DOWNLOAD',
        tabId: currentTabId,
        videoVariant,
        audioVariant,
        fileName: suggestedName,
        fileHandleKey,
        pageUrl: currentPageUrl,
        audioOnly: false,
        organizedPath: pathPlan?.organizedPath || suggestedName,
        conflictStrategy: pathPlan?.conflictStrategy || 'uniquify',
      });

      if (!response || !response.ok) {
        throw new Error(response?.error || 'START_BILIBILI_DOWNLOAD 失败');
      }

      statusText.textContent = 'B 站下载已开始';
      setTimeout(() => (statusText.textContent = '就绪'), 2500);
      switchView('tasks');
    } catch (err) {
      if (err?.name === 'AbortError') {
        statusText.textContent = '已取消';
        setTimeout(() => (statusText.textContent = '就绪'), 1500);
        return;
      }
      console.error('[WebGrab] B 站下载启动失败:', err);
      statusText.textContent = '下载失败: ' + (err.message || err);
      setTimeout(() => (statusText.textContent = '就绪'), 3000);
    } finally {
      btn.classList.remove('loading');
      btn.disabled = false;
    }
  }

  /**
   * 构建 B 站下载文件名
   * @param {Object} meta - biliData
   * @param {Object} variant - 选中的变体
   * @param {number|null} partIndex - 分 P 序号（1-based）
   * @param {string|null} partTitle - 分 P 标题
   * @returns {string}
   */
  function buildBiliFileName(meta, variant, partIndex, partTitle) {
    const codecGroup = variant.codecGroup || (variant.codecs || '').split('.')[0];
    const quality = variant.qualityLabel || 'unknown';
    const tpl = partIndex ? '{title}_P{p}_{partTitle}_{quality}' : '{title}_{quality}';
    let name = tpl
      .replace('{title}', meta.title || 'bilibili')
      .replace('{up}', meta.uploader || '')
      .replace('{bvid}', meta.bvid || '')
      .replace('{quality}', quality)
      .replace('{codec}', codecGroup)
      .replace('{date}', new Date().toISOString().slice(0, 10))
      .replace('{p}', partIndex != null ? String(partIndex) : '')
      .replace('{partTitle}', partTitle || '');
    // 合并连续下划线，去除首尾下划线
    name = name.replace(/_+/g, '_').replace(/^_|_$/g, '');
    // 净化非法字符
    name = name.replace(/[\\/:*?"<>|]/g, '_').replace(/[\x00-\x1f\x7f]/g, '');
    return name + '.mp4';
  }

  /**
   * HTML 转义
   * @param {string} str
   * @returns {string}
   */
  function escapeHtml(str) {
    if (!str) return '';
    return str
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  // ─── 启动 ──────────────────────────────────────────────
  init();
})();
