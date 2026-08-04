export const PACKAGE_PREFERENCE_KEY = 'webgrab_package_preference';
export const DEFAULT_PACKAGE_PREFERENCE = 'cbz';

const VALID_MODES = new Set(['cbz', 'folder', 'both']);

export function normalizePackagePreference(value) {
  return VALID_MODES.has(value) ? value : DEFAULT_PACKAGE_PREFERENCE;
}

function defaultStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error('chrome.storage.local is unavailable');
  return globalThis.chrome.storage.local;
}

export async function loadPackagePreference(storage = defaultStorage()) {
  const result = await storage.get(PACKAGE_PREFERENCE_KEY);
  return normalizePackagePreference(result?.[PACKAGE_PREFERENCE_KEY]);
}

export async function savePackagePreference(value, storage = defaultStorage()) {
  const mode = normalizePackagePreference(value);
  await storage.set({ [PACKAGE_PREFERENCE_KEY]: mode });
  return mode;
}
