(function () {
  'use strict';

  function t(key, fallback) {
    return chrome.i18n?.getMessage?.(key) || fallback;
  }

  document.getElementById('onboarding-title').textContent = t('onboardingTitle', '欢迎使用 WebGrab');
  document.getElementById('step1-title').textContent = t('onboardingStep1Title', '1. 嗅探资源');
  document.getElementById('step1-body').textContent = t('onboardingStep1Body', '打开任意网页，播放视频或滚动图片列表，WebGrab 会自动在后台捕获可下载的媒体资源。');
  document.getElementById('step2-title').textContent = t('onboardingStep2Title', '2. 下载');
  document.getElementById('step2-body').textContent = t('onboardingStep2Body', '点击工具栏图标查看资源列表，单个下载或多选批量下载，支持整理成漫画 CBZ / 小说 EPUB。');
  document.getElementById('step3-title').textContent = t('onboardingStep3Title', '3. 悬浮入口');
  document.getElementById('step3-body').textContent = t('onboardingStep3Body', '有资源时页面右下角会出现悬浮角色，点击可直接打开资源面板，无需先点工具栏图标。');

  const dismissBtn = document.getElementById('dismiss-btn');
  dismissBtn.textContent = t('onboardingDismiss', '知道了，开始使用');
  dismissBtn.addEventListener('click', () => window.close());
})();
