(function () {
  'use strict';

  const closeButton = document.getElementById('panel-close');
  const popupFrame = document.getElementById('popup-frame');
  const extensionOrigin = location.origin;
  let hostOrigin = '';

  async function initializeTheme() {
    try {
      const settingsApi = await import('../lib/ui-settings.js');
      settingsApi.applyTheme(document.documentElement, await settingsApi.loadUiSettings());
      settingsApi.watchUiSettings((settings) => settingsApi.applyTheme(document.documentElement, settings));
    } catch (error) {
      console.warn('[WebGrab] 资源面板主题读取失败', error);
    }
  }

  function notifyHost(type) {
    if (!hostOrigin) return;
    window.parent.postMessage({ source: 'webgrab-panel', type }, hostOrigin);
  }

  function requestClose() {
    notifyHost('WEBGRAB_PANEL_CLOSE');
  }

  closeButton.addEventListener('click', requestClose);
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      requestClose();
    }
  });

  window.addEventListener('message', (event) => {
    if (event.data?.source === 'webgrab-host' && event.data.type === 'WEBGRAB_PANEL_CONTEXT') {
      if (event.source !== window.parent) return;
      let claimedOrigin = '';
      try { claimedOrigin = new URL(event.data.pageUrl).origin; } catch { return; }
      if (claimedOrigin !== event.origin || !/^https?:$/.test(new URL(event.data.pageUrl).protocol)) return;
      hostOrigin = event.origin;
      closeButton.focus({ preventScroll: true });
      notifyHost('WEBGRAB_PANEL_READY');
      return;
    }

    if (event.source === popupFrame.contentWindow && event.origin === extensionOrigin && event.data?.source === 'webgrab-popup') {
      if (event.data.type === 'WEBGRAB_POPUP_ESCAPE') requestClose();
    }
  });

  initializeTheme();
})();
