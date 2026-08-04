export const COMPANION_SETTINGS_KEY = 'webgrab_companion_settings';

export const DEFAULT_COMPANION_SETTINGS = Object.freeze({
  enabled: true,
  characterRoot: 'assets/character/detective-girl',
  disabledOrigins: Object.freeze([]),
  positions: Object.freeze({}),
});

const SAFE_CHARACTER_ROOT = /^(?![a-z][a-z\d+.-]*:)(?!\/\/)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/i;

export function getCompanionOrigin(url) {
  try {
    const parsed = new URL(url);
    return /^https?:$/.test(parsed.protocol) ? parsed.origin : '';
  } catch {
    return '';
  }
}

export function mergeCompanionSettings(value = {}) {
  const disabledOrigins = [...new Set((Array.isArray(value.disabledOrigins) ? value.disabledOrigins : [])
    .map(getCompanionOrigin).filter(Boolean))];
  const positions = {};
  if (value.positions && typeof value.positions === 'object') {
    for (const [originValue, position] of Object.entries(value.positions)) {
      const origin = getCompanionOrigin(originValue);
      const x = Number(position?.x);
      const y = Number(position?.y);
      if (origin && Number.isFinite(x) && Number.isFinite(y)) positions[origin] = { x: Math.round(x), y: Math.round(y) };
    }
  }
  const characterRoot = typeof value.characterRoot === 'string' && SAFE_CHARACTER_ROOT.test(value.characterRoot.trim())
    ? value.characterRoot.trim().replace(/\/+$/, '')
    : DEFAULT_COMPANION_SETTINGS.characterRoot;
  return { enabled: value.enabled !== false, characterRoot, disabledOrigins, positions };
}

export function isCompanionVisible(settingsValue, pageUrl, resourceCount) {
  const settings = mergeCompanionSettings(settingsValue);
  const origin = getCompanionOrigin(pageUrl);
  return Number(resourceCount) > 0 && settings.enabled && Boolean(origin) && !settings.disabledOrigins.includes(origin);
}

export function setOriginDisabled(settingsValue, pageUrl, disabled) {
  const settings = mergeCompanionSettings(settingsValue);
  const origin = getCompanionOrigin(pageUrl);
  if (!origin) return settings;
  const next = new Set(settings.disabledOrigins);
  if (disabled) next.add(origin); else next.delete(origin);
  return { ...settings, disabledOrigins: [...next] };
}

export function withStoredPosition(settingsValue, pageUrl, position) {
  const settings = mergeCompanionSettings(settingsValue);
  const origin = getCompanionOrigin(pageUrl);
  const x = Number(position?.x);
  const y = Number(position?.y);
  if (!origin || !Number.isFinite(x) || !Number.isFinite(y)) return settings;
  return { ...settings, positions: { ...settings.positions, [origin]: { x: Math.round(x), y: Math.round(y) } } };
}

function defaultStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error('chrome.storage.local is unavailable');
  return globalThis.chrome.storage.local;
}

export async function loadCompanionSettings(storage = defaultStorage()) {
  const result = await storage.get(COMPANION_SETTINGS_KEY);
  return mergeCompanionSettings(result?.[COMPANION_SETTINGS_KEY]);
}

export async function saveCompanionSettings(value, storage = defaultStorage()) {
  const settings = mergeCompanionSettings(value);
  await storage.set({ [COMPANION_SETTINGS_KEY]: settings });
  return settings;
}
