import { DEFAULT_PATH_TEMPLATES } from './path-planner.js';

export const PATH_SETTINGS_KEY = 'webgrab_path_settings';
export const PATH_PREVIEW_CONTEXT_KEY = 'webgrab_path_preview_context';
export const CONFLICT_STRATEGIES = Object.freeze(['uniquify', 'skip', 'overwrite']);

export const DEFAULT_PATH_SETTINGS = Object.freeze({
  enabled: true,
  conflictStrategy: 'uniquify',
  templates: Object.freeze({ ...DEFAULT_PATH_TEMPLATES }),
});

export function mergePathSettings(value = {}) {
  const conflictStrategy = CONFLICT_STRATEGIES.includes(value.conflictStrategy)
    ? value.conflictStrategy
    : DEFAULT_PATH_SETTINGS.conflictStrategy;
  const templates = { ...DEFAULT_PATH_SETTINGS.templates };
  for (const type of Object.keys(templates)) {
    const template = value.templates?.[type];
    if (typeof template === 'string' && template.trim()) templates[type] = template.trim();
  }
  return {
    enabled: value.enabled !== false,
    conflictStrategy,
    templates,
  };
}

function defaultStorage() {
  if (!globalThis.chrome?.storage?.local) throw new Error('chrome.storage.local is unavailable');
  return globalThis.chrome.storage.local;
}

export async function loadPathSettings(storage = defaultStorage()) {
  const result = await storage.get(PATH_SETTINGS_KEY);
  return mergePathSettings(result?.[PATH_SETTINGS_KEY]);
}

export async function savePathSettings(value, storage = defaultStorage()) {
  const normalized = mergePathSettings(value);
  await storage.set({ [PATH_SETTINGS_KEY]: normalized });
  return normalized;
}

export async function savePreviewContext(context, storage = defaultStorage()) {
  await storage.set({ [PATH_PREVIEW_CONTEXT_KEY]: context || null });
}

export async function loadPreviewContext(storage = defaultStorage()) {
  const result = await storage.get(PATH_PREVIEW_CONTEXT_KEY);
  return result?.[PATH_PREVIEW_CONTEXT_KEY] || null;
}
