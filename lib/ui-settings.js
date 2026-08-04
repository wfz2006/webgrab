export const UI_SETTINGS_KEY = 'webgrab_ui_settings';

export const DEFAULT_UI_SETTINGS = Object.freeze({ theme: 'system' });

const ALLOWED_THEMES = new Set(['system', 'dark', 'light']);

export function normalizeUiSettings(value = {}) {
  const theme = ALLOWED_THEMES.has(value?.theme) ? value.theme : DEFAULT_UI_SETTINGS.theme;
  return { theme };
}

export function applyTheme(root, value = DEFAULT_UI_SETTINGS) {
  const { theme } = normalizeUiSettings(value);
  if (theme === 'system') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', theme);
  return theme;
}

function defaultStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error('chrome.storage.local is unavailable');
  return globalThis.chrome.storage.local;
}

export async function loadUiSettings(storage = defaultStorage()) {
  const result = await storage.get(UI_SETTINGS_KEY);
  return normalizeUiSettings(result?.[UI_SETTINGS_KEY]);
}

export async function saveUiSettings(value, storage = defaultStorage()) {
  const settings = normalizeUiSettings(value);
  await storage.set({ [UI_SETTINGS_KEY]: settings });
  return settings;
}

export function watchUiSettings(callback, storageEvents = globalThis.chrome?.storage?.onChanged) {
  if (!storageEvents?.addListener) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes?.[UI_SETTINGS_KEY]) return;
    callback(normalizeUiSettings(changes[UI_SETTINGS_KEY].newValue));
  };
  storageEvents.addListener(listener);
  return () => storageEvents.removeListener?.(listener);
}
