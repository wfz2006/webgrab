export const RESOURCE_FILTER_KEY = 'webgrab_resource_filters';

export const DEFAULT_RESOURCE_FILTERS = Object.freeze({
  extBlacklist: Object.freeze([]),
  mimeBlacklist: Object.freeze([]),
  minSizeBytes: Object.freeze({ image: 0, video: 0, audio: 0 }),
  urlBlacklistPatterns: Object.freeze([]),
  showHookResources: true,
});

function normalizeStringList(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item ?? '').trim()).filter(Boolean))];
}

function normalizeMinSize(value) {
  const source = value && typeof value === 'object' ? value : {};
  const pick = (key) => {
    const number = Number(source[key]);
    return Number.isFinite(number) && number >= 0 ? Math.floor(number) : 0;
  };
  return { image: pick('image'), video: pick('video'), audio: pick('audio') };
}

export function normalizeResourceFilters(value = {}) {
  return {
    extBlacklist: normalizeStringList(value.extBlacklist).map((ext) => ext.replace(/^\.+/, '').toLowerCase()),
    mimeBlacklist: normalizeStringList(value.mimeBlacklist).map((mime) => mime.toLowerCase()),
    minSizeBytes: normalizeMinSize(value.minSizeBytes),
    urlBlacklistPatterns: normalizeStringList(value.urlBlacklistPatterns),
    showHookResources: value.showHookResources !== false,
  };
}

function defaultStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error('chrome.storage.local is unavailable');
  return globalThis.chrome.storage.local;
}

export async function loadResourceFilters(storage = defaultStorage()) {
  const result = await storage.get(RESOURCE_FILTER_KEY);
  return normalizeResourceFilters(result?.[RESOURCE_FILTER_KEY]);
}

export async function saveResourceFilters(value, storage = defaultStorage()) {
  const filters = normalizeResourceFilters(value);
  await storage.set({ [RESOURCE_FILTER_KEY]: filters });
  return filters;
}

export function watchResourceFilters(callback, storageEvents = globalThis.chrome?.storage?.onChanged) {
  if (!storageEvents?.addListener) return () => {};
  const listener = (changes, areaName) => {
    if (areaName !== 'local' || !changes?.[RESOURCE_FILTER_KEY]) return;
    callback(normalizeResourceFilters(changes[RESOURCE_FILTER_KEY].newValue));
  };
  storageEvents.addListener(listener);
  return () => storageEvents.removeListener?.(listener);
}
