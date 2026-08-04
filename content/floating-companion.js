(async function webgrabFloatingCompanion() {
  'use strict';

  if (window.top !== window || !/^https?:$/.test(location.protocol)) return;
  if (window.__webgrabFloatingCompanionInstalled) return;
  window.__webgrabFloatingCompanionInstalled = true;

  const [{ validateCharacterManifest, resolveCharacterState }, positionApi, settingsApi] = await Promise.all([
    import(chrome.runtime.getURL('lib/character-manifest.js')),
    import(chrome.runtime.getURL('lib/companion-position.js')),
    import(chrome.runtime.getURL('lib/companion-settings.js')),
  ]);
  const { clampCompanionPosition, repairCompanionPosition, snapCompanionPosition } = positionApi;
  const {
    COMPANION_SETTINGS_KEY,
    getCompanionOrigin,
    isCompanionVisible,
    loadCompanionSettings,
    saveCompanionSettings,
    setOriginDisabled,
    withStoredPosition,
  } = settingsApi;

  const HOST_ID = 'webgrab-floating-companion';
  const SAFE_MARGIN = 8;
  const SNAP_THRESHOLD = 28;
  const extensionOrigin = new URL(chrome.runtime.getURL('/')).origin;
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');

  let settings = await loadCompanionSettings();
  let snapshot = { resourceCount: 0, phase: 'scanning', progress: 0, error: '' };
  let manifest = null;
  let manifestRoot = '';
  let host = null;
  let shadow = null;
  let shell = null;
  let trigger = null;
  let sprite = null;
  let badge = null;
  let progressRing = null;
  let toast = null;
  let errorButton = null;
  let panelShell = null;
  let panelFrame = null;
  let transientTimer = null;
  let panelOpen = false;
  let suppressClick = false;
  let position = null;
  let viewport = readViewport();

  function readViewport() {
    return { width: window.innerWidth, height: window.innerHeight };
  }

  function characterSize() {
    return { width: manifest?.width || 120, height: manifest?.height || 160 };
  }

  async function loadManifest() {
    const root = settings.characterRoot.replace(/\/+$/, '');
    if (manifest && manifestRoot === root) return manifest;
    const response = await fetch(chrome.runtime.getURL(`${root}/manifest.json`), { cache: 'no-cache' });
    if (!response.ok) throw new Error(`角色 manifest 加载失败: ${response.status}`);
    manifest = validateCharacterManifest(await response.json());
    manifestRoot = root;
    return manifest;
  }

  function shellStyles() {
    return `
      :host { all: initial; color-scheme: light dark; }
      *, *::before, *::after { box-sizing: border-box; }
      .wg-shell {
        position: relative; width: var(--character-width); height: var(--character-height);
        font-family: Inter, "Segoe UI", system-ui, sans-serif; color: #eaf8ff;
        user-select: none; -webkit-user-select: none; touch-action: none;
        filter: drop-shadow(0 16px 28px rgba(4, 18, 33, .34));
        transform-origin: 50% 72%; will-change: transform;
        animation: webgrab-breathe 2600ms ease-in-out infinite;
      }
      @keyframes webgrab-breathe {
        0%, 100% { transform: translate3d(0, 0, 0); }
        50% { transform: translate3d(0, -3px, 0); }
      }
      .wg-shell:hover, .wg-shell:focus-within { animation-play-state: paused; }
      @keyframes webgrab-error-shake {
        0%, 100% { transform: translate3d(0, 0, 0); }
        20% { transform: translate3d(-2px, -1px, 0); }
        40% { transform: translate3d(2px, 0, 0); }
        60% { transform: translate3d(-1px, -2px, 0); }
        80% { transform: translate3d(1px, 0, 0); }
      }
      .wg-shell[data-phase="error"] {
        animation: webgrab-error-shake 360ms ease-out 1,
          webgrab-breathe 2600ms ease-in-out 360ms infinite;
      }
      .wg-trigger {
        all: unset; position: relative; display: block; width: 100%; height: 100%; cursor: grab;
        border-radius: 28px 28px 38px 38px; overflow: hidden; isolation: isolate;
        outline: 1px solid rgba(145, 236, 255, .72); outline-offset: 3px;
        background: linear-gradient(155deg, rgba(13, 37, 57, .34), rgba(5, 20, 32, .7));
      }
      .wg-trigger:active { cursor: grabbing; }
      .wg-trigger:focus-visible { outline: 3px solid #ffe47a; outline-offset: 5px; }
      .wg-trigger::before {
        content: ""; position: absolute; inset: 0; z-index: 2; pointer-events: none;
        background: linear-gradient(120deg, rgba(255,255,255,.2), transparent 32%),
          radial-gradient(circle at 50% 105%, rgba(74,220,255,.34), transparent 46%);
        box-shadow: inset 0 0 0 1px rgba(255,255,255,.12), inset 0 -22px 34px rgba(2,16,27,.3);
      }
      .wg-shell[data-phase="error"] .wg-trigger::before {
        background: linear-gradient(rgba(174, 32, 52, .2), rgba(103, 12, 30, .16));
        box-shadow: inset 0 0 0 1px rgba(255, 136, 151, .42), inset 0 -22px 34px rgba(79, 8, 23, .24);
      }
      .wg-sprite {
        position: absolute; inset: 0; width: 100%; height: 100%; z-index: 1;
        background-repeat: no-repeat; background-position: 0 0;
        image-rendering: auto; will-change: background-position;
      }
      @keyframes webgrab-sprite { from { background-position: 0 0; } to { background-position: calc(-1px * var(--sheet-width)) 0; } }
      .wg-badge {
        position: absolute; z-index: 5; inset-block-start: -9px; inset-inline-end: -9px;
        min-width: 30px; height: 30px; padding: 0 8px; border-radius: 999px;
        display: grid; place-items: center; background: #ffcf4d; color: #19212a;
        border: 2px solid rgba(255,255,255,.95); font: 800 12px/1 "Segoe UI", sans-serif;
        box-shadow: 0 6px 16px rgba(26,35,43,.3);
      }
      .wg-progress {
        position: absolute; z-index: 4; inset: -6px; border-radius: 34px; pointer-events: none;
        background: conic-gradient(#61ecff calc(var(--progress) * 1turn), rgba(98,220,255,.15) 0);
        mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
        -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 4px), #000 0);
        opacity: 0; transition: opacity .18s ease;
      }
      .wg-shell[data-phase="downloading"] .wg-progress { opacity: 1; }
      .wg-controls { position: absolute; z-index: 8; inset-block-end: 7px; inset-inline-end: 7px; opacity: 0; transition: opacity .16s ease; }
      .wg-shell:hover .wg-controls, .wg-controls:focus-within { opacity: 1; }
      .wg-hide {
        all: unset; display: grid; place-items: center; width: 28px; height: 28px; border-radius: 9px;
        cursor: pointer; background: rgba(3,18,29,.78); color: #dcf8ff; outline: 1px solid rgba(143,233,255,.48);
        font: 700 15px/1 sans-serif;
      }
      .wg-hide:focus-visible { outline: 2px solid #ffe47a; }
      .wg-toast, .wg-error {
        position: absolute; z-index: 9; inset-inline-end: 0; inset-block-end: calc(100% + 10px);
        width: max-content; max-width: 260px; padding: 9px 12px; border-radius: 12px;
        background: rgba(4,24,38,.94); color: #f4fbff; border: 1px solid rgba(119,226,255,.45);
        box-shadow: 0 12px 28px rgba(0,0,0,.24); font: 650 12px/1.45 "Segoe UI", sans-serif;
      }
      .wg-toast[hidden], .wg-error[hidden] { display: none; }
      .wg-error { all: unset; position: absolute; z-index: 9; inset-inline-end: 0; inset-block-end: calc(100% + 10px);
        box-sizing: border-box; width: max-content; max-width: 280px; padding: 9px 12px; border-radius: 12px;
        cursor: pointer; background: rgba(80,18,28,.95); color: #fff1f3; border: 1px solid rgba(255,139,151,.7);
        box-shadow: 0 12px 28px rgba(0,0,0,.24); font: 650 12px/1.45 "Segoe UI", sans-serif; }
      .wg-panel {
        position: absolute; z-index: 12; inset-block-start: 0; inset-inline-start: 0; width: min(440px, calc(100vw - 32px));
        height: min(700px, calc(100vh - 32px)); border-radius: 22px; overflow: hidden;
        background: #081623; border: 1px solid rgba(132,229,255,.6); box-shadow: 0 28px 70px rgba(0,0,0,.42);
        transform: translate3d(var(--panel-offset-x), var(--panel-offset-y), 0);
        transform-origin: center; animation: wg-panel-in .18s cubic-bezier(.2,.75,.25,1);
      }
      .wg-panel[hidden] { display: none; }
      .wg-panel iframe { display: block; width: 100%; height: 100%; border: 0; background: #f4f7f8; }
      @keyframes wg-panel-in {
        from { opacity: 0; transform: translate3d(var(--panel-offset-x), calc(var(--panel-offset-y) + 8px), 0) scale(.98); }
        to { opacity: 1; transform: translate3d(var(--panel-offset-x), var(--panel-offset-y), 0) scale(1); }
      }
      @media (prefers-reduced-motion: reduce) {
        .wg-shell { animation: none !important; transform: none !important; }
        .wg-sprite { animation: none !important; background-position: 0 0 !important; }
        .wg-panel, .wg-controls, .wg-progress { animation: none !important; transition: none !important; }
      }
    `;
  }

  function buildShadowDom() {
    host = document.createElement('webgrab-companion-host');
    host.id = HOST_ID;
    host.style.cssText = 'all:initial;position:fixed;left:0;top:0;z-index:2147483646;display:block;contain:layout style;isolation:isolate;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = shellStyles();
    shell = document.createElement('div');
    shell.className = 'wg-shell';
    shell.innerHTML = `
      <button class="wg-trigger" type="button" aria-label="打开 WebGrab 资源嗅探面板" aria-expanded="false">
        <span class="wg-sprite" aria-hidden="true"></span>
      </button>
      <span class="wg-progress" aria-hidden="true"></span>
      <span class="wg-badge" aria-label="已发现 0 个资源">0</span>
      <span class="wg-toast" role="status" aria-live="polite" hidden></span>
      <button class="wg-error" type="button" aria-label="查看下载失败原因" hidden></button>
      <span class="wg-controls"><button class="wg-hide" type="button" title="在本站不显示" aria-label="在本站不显示 WebGrab 悬浮窗">×</button></span>
      <section class="wg-panel" data-side="left" hidden aria-label="WebGrab 资源面板">
        <iframe title="WebGrab 资源嗅探页面" src="${chrome.runtime.getURL('ui/panel.html')}"></iframe>
      </section>`;
    shadow.append(style, shell);
    trigger = shadow.querySelector('.wg-trigger');
    sprite = shadow.querySelector('.wg-sprite');
    badge = shadow.querySelector('.wg-badge');
    progressRing = shadow.querySelector('.wg-progress');
    toast = shadow.querySelector('.wg-toast');
    errorButton = shadow.querySelector('.wg-error');
    panelShell = shadow.querySelector('.wg-panel');
    panelFrame = shadow.querySelector('iframe');
    shell.style.setProperty('--character-width', `${manifest.width}px`);
    shell.style.setProperty('--character-height', `${manifest.height}px`);
    bindInteractions();
  }

  function applyTransform(nextPosition) {
    position = clampCompanionPosition(nextPosition, readViewport(), characterSize(), SAFE_MARGIN);
    host.style.transform = `translate3d(${position.x}px, ${position.y}px, 0)`;
    const midpoint = position.x + manifest.width / 2;
    panelShell.dataset.side = midpoint > window.innerWidth / 2 ? 'left' : 'right';
    const panelWidth = Math.max(0, Math.min(440, window.innerWidth - 32));
    const panelHeight = Math.max(0, Math.min(700, window.innerHeight - 32));
    const preferredX = midpoint > window.innerWidth / 2
      ? position.x - panelWidth - 14
      : position.x + manifest.width + 14;
    const panelX = Math.min(window.innerWidth - panelWidth - 16, Math.max(16, preferredX));
    const panelY = Math.min(window.innerHeight - panelHeight - 16, Math.max(16, position.y));
    shell.style.setProperty('--panel-offset-x', `${Math.round(panelX - position.x)}px`);
    shell.style.setProperty('--panel-offset-y', `${Math.round(panelY - position.y)}px`);
  }

  function initialPosition() {
    const saved = settings.positions[getCompanionOrigin(location.href)];
    return saved || { x: window.innerWidth - manifest.width - 24, y: Math.max(24, window.innerHeight - manifest.height - 64) };
  }

  async function persistPosition() {
    settings = withStoredPosition(settings, location.href, position);
    await saveCompanionSettings(settings);
  }

  function bindInteractions() {
    let drag = null;
    trigger.addEventListener('pointerdown', (event) => {
      if (event.button !== 0) return;
      drag = { pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, origin: { ...position }, moved: false };
      trigger.setPointerCapture(event.pointerId);
    });
    trigger.addEventListener('pointermove', (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const dx = event.clientX - drag.startX;
      const dy = event.clientY - drag.startY;
      if (Math.hypot(dx, dy) >= 4) drag.moved = true;
      if (drag.moved) applyTransform({ x: drag.origin.x + dx, y: drag.origin.y + dy });
    });
    const endDrag = (event) => {
      if (!drag || drag.pointerId !== event.pointerId) return;
      const moved = drag.moved;
      drag = null;
      try { trigger.releasePointerCapture(event.pointerId); } catch {}
      if (moved) {
        suppressClick = true;
        applyTransform(snapCompanionPosition(position, readViewport(), characterSize(), { margin: SAFE_MARGIN, threshold: SNAP_THRESHOLD }));
        persistPosition().catch(() => {});
        queueMicrotask(() => { suppressClick = false; });
      }
    };
    trigger.addEventListener('pointerup', endDrag);
    trigger.addEventListener('pointercancel', endDrag);
    trigger.addEventListener('click', () => { if (!suppressClick) togglePanel(); });
    shadow.querySelector('.wg-hide').addEventListener('click', async (event) => {
      event.stopPropagation();
      settings = setOriginDisabled(settings, location.href, true);
      await saveCompanionSettings(settings);
      syncVisibility();
    });
    errorButton.addEventListener('click', openPanel);
    panelFrame.addEventListener('load', postPanelContext);
  }

  function syncVisibility() {
    if (!host) return;
    const visible = isCompanionVisible(settings, location.href, snapshot.resourceCount) && !document.fullscreenElement;
    host.hidden = !visible;
    host.style.display = visible ? 'block' : 'none';
    if (!visible) closePanel(false);
  }

  function showToast(message, duration = 1800) {
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    window.setTimeout(() => { if (toast) toast.hidden = true; }, duration);
  }

  function applyCharacterState(requestedState) {
    if (!sprite || !manifest) return;
    clearTimeout(transientTimer);
    const state = resolveCharacterState(manifest, requestedState, chrome.runtime.getURL(`${manifestRoot}/`));
    shell.dataset.phase = state.name;
    sprite.style.backgroundImage = `url("${state.sheetUrl.replaceAll('"', '%22')}")`;
    sprite.style.backgroundSize = `${state.backgroundWidth}px ${state.height}px`;
    sprite.style.setProperty('--sheet-width', String(state.backgroundWidth));
    sprite.style.animation = reducedMotion.matches || state.frames === 1
      ? 'none'
      : `webgrab-sprite ${state.animation.durationMs}ms steps(${state.animation.steps}) ${state.animation.iterationCount}`;
    if (!state.loop && ['found', 'done'].includes(state.name)) {
      const visibleDuration = state.frames === 1 ? 900 : state.animation.durationMs + 80;
      transientTimer = window.setTimeout(() => applyCharacterState('idle'), visibleDuration);
    }
  }

  function applySnapshot(next) {
    const previousCount = snapshot.resourceCount || 0;
    snapshot = { ...snapshot, ...(next || {}) };
    if (!host && isCompanionVisible(settings, location.href, snapshot.resourceCount)) {
      ensureMounted().catch((error) => console.warn('[WebGrab/Companion] 初始化失败:', error));
      return;
    }
    if (!host) return;
    badge.textContent = snapshot.resourceCount > 999 ? '999+' : String(snapshot.resourceCount || 0);
    badge.setAttribute('aria-label', `已发现 ${snapshot.resourceCount || 0} 个资源`);
    shell.style.setProperty('--progress', String(Math.max(0, Math.min(1, snapshot.progress || 0))));
    progressRing.setAttribute('aria-label', `下载进度 ${Math.round((snapshot.progress || 0) * 100)}%`);
    errorButton.hidden = snapshot.phase !== 'error';
    if (snapshot.phase === 'error') {
      const reason = snapshot.error || '下载失败，点击查看任务详情';
      errorButton.textContent = `下载失败：${reason}`;
      errorButton.title = reason;
    }
    const phase = snapshot.resourceEvent || snapshot.resourceCount > previousCount ? 'found' : (snapshot.phase || 'idle');
    applyCharacterState(phase);
    if (phase === 'found') showToast(`发现 ${snapshot.resourceCount} 个资源`);
    if (phase === 'done') showToast('下载完成');
    syncVisibility();
  }

  async function ensureMounted() {
    if (host) return;
    if (!isCompanionVisible(settings, location.href, snapshot.resourceCount)) return;
    await loadManifest();
    if (document.getElementById(HOST_ID)) return;
    buildShadowDom();
    (document.documentElement || document.body).append(host);
    applyTransform(initialPosition());
    applySnapshot(snapshot);
  }

  function postPanelContext() {
    if (!panelFrame?.contentWindow) return;
    panelFrame.contentWindow.postMessage({
      source: 'webgrab-host', type: 'WEBGRAB_PANEL_CONTEXT', pageUrl: location.href,
      resourceCount: snapshot.resourceCount, error: snapshot.error || '',
    }, extensionOrigin);
  }

  function openPanel() {
    if (!panelShell || panelOpen) return;
    panelOpen = true;
    panelShell.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    postPanelContext();
    panelFrame.focus();
  }

  function closePanel(restoreFocus = true) {
    if (!panelShell || !panelOpen) return;
    panelOpen = false;
    panelShell.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    if (restoreFocus && !host.hidden) trigger.focus();
  }

  function togglePanel() {
    if (panelOpen) closePanel(); else openPanel();
  }

  function onResize() {
    if (!host) return;
    const nextViewport = readViewport();
    applyTransform(repairCompanionPosition(position, viewport, nextViewport, characterSize(), SAFE_MARGIN));
    viewport = nextViewport;
    persistPosition().catch(() => {});
  }

  chrome.runtime.onMessage.addListener((message) => {
    if (message?.type === 'COMPANION_STATE') applySnapshot(message.snapshot);
  });
  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== 'local' || !changes[COMPANION_SETTINGS_KEY]) return;
    settings = settingsApi.mergeCompanionSettings(changes[COMPANION_SETTINGS_KEY].newValue);
    if (host && manifestRoot !== settings.characterRoot) {
      manifest = null;
      loadManifest().then(() => {
        shell.style.setProperty('--character-width', `${manifest.width}px`);
        shell.style.setProperty('--character-height', `${manifest.height}px`);
        applyCharacterState(snapshot.phase || 'idle');
        onResize();
      }).catch((error) => console.warn('[WebGrab/Companion] 角色切换失败:', error));
    }
    if (!host && isCompanionVisible(settings, location.href, snapshot.resourceCount)) {
      ensureMounted().catch((error) => console.warn('[WebGrab/Companion] 设置生效后初始化失败:', error));
      return;
    }
    syncVisibility();
  });
  window.addEventListener('message', (event) => {
    if (event.origin !== extensionOrigin || event.source !== panelFrame?.contentWindow) return;
    if (event.data?.source !== 'webgrab-panel') return;
    if (event.data.type === 'WEBGRAB_PANEL_CLOSE') closePanel();
    if (event.data.type === 'WEBGRAB_PANEL_READY') postPanelContext();
  });
  document.addEventListener('keydown', (event) => { if (event.key === 'Escape' && panelOpen) closePanel(); }, true);
  document.addEventListener('fullscreenchange', syncVisibility);
  window.addEventListener('resize', onResize, { passive: true });
  reducedMotion.addEventListener?.('change', () => { if (sprite) applyCharacterState(snapshot.phase || 'idle'); });

  try {
    const response = await chrome.runtime.sendMessage({ type: 'COMPANION_GET_STATE' });
    if (response?.ok && response.data) applySnapshot(response.data);
  } catch {
    // SW 重启或页面卸载时不显示即可。
  }
})();
