export const DOWNLOAD_SETTINGS_KEY = 'webgrab_download_settings';

export const DEFAULT_DOWNLOAD_SETTINGS = Object.freeze({
  segmentConcurrency: 6,
  retryCount: 0,
});

function clampInt(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

export function normalizeDownloadSettings(value = {}) {
  return {
    segmentConcurrency: clampInt(value.segmentConcurrency, 1, 8, DEFAULT_DOWNLOAD_SETTINGS.segmentConcurrency),
    retryCount: clampInt(value.retryCount, 0, 5, DEFAULT_DOWNLOAD_SETTINGS.retryCount),
  };
}

function defaultStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error('chrome.storage.local is unavailable');
  return globalThis.chrome.storage.local;
}

export async function loadDownloadSettings(storage = defaultStorage()) {
  const result = await storage.get(DOWNLOAD_SETTINGS_KEY);
  return normalizeDownloadSettings(result?.[DOWNLOAD_SETTINGS_KEY]);
}

export async function saveDownloadSettings(value, storage = defaultStorage()) {
  const settings = normalizeDownloadSettings(value);
  await storage.set({ [DOWNLOAD_SETTINGS_KEY]: settings });
  return settings;
}

export function watchDownloadSettings(callback, storageEvents = globalThis.chrome?.storage?.onChanged) {
  if (!storageEvents?.addListener) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes?.[DOWNLOAD_SETTINGS_KEY]) return;
    callback(normalizeDownloadSettings(changes[DOWNLOAD_SETTINGS_KEY].newValue));
  };
  storageEvents.addListener(listener);
  return () => storageEvents.removeListener?.(listener);
}
