export const REQUIRED_CHARACTER_STATES = Object.freeze([
  'idle', 'scanning', 'found', 'downloading', 'done', 'error',
]);

const SAFE_SHEET_PATH = /^(?![a-z][a-z\d+.-]*:)(?!\/\/)(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[\w./-]+$/i;

function positiveNumber(value, label, { integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0 || (integer && !Number.isInteger(number))) {
    throw new TypeError(`character manifest ${label} must be a positive${integer ? ' integer' : ''}`);
  }
  return number;
}

export function buildSpriteAnimation(state) {
  const frames = positiveNumber(state?.frames, 'frames', { integer: true });
  const fps = positiveNumber(state?.fps, 'fps');
  return {
    steps: frames,
    durationMs: Math.round((frames / fps) * 1000),
    iterationCount: state?.loop === true ? 'infinite' : 1,
  };
}

export function validateCharacterManifest(value) {
  if (!value || typeof value !== 'object') throw new TypeError('character manifest must be an object');
  const width = positiveNumber(value.width, 'width', { integer: true });
  const height = positiveNumber(value.height, 'height', { integer: true });
  const name = typeof value.name === 'string' && value.name.trim() ? value.name.trim() : 'WebGrab 角色';
  const states = {};
  for (const stateName of REQUIRED_CHARACTER_STATES) {
    const source = value.states?.[stateName];
    if (!source || typeof source !== 'object') throw new TypeError(`character manifest missing state: ${stateName}`);
    const sheet = typeof source.sheet === 'string' ? source.sheet.trim() : '';
    if (!sheet || !SAFE_SHEET_PATH.test(sheet)) throw new TypeError(`character manifest ${stateName}.sheet is unsafe`);
    const frames = positiveNumber(source.frames, `${stateName}.frames`, { integer: true });
    const fps = positiveNumber(source.fps, `${stateName}.fps`);
    states[stateName] = Object.freeze({ sheet, frames, fps, loop: source.loop === true });
  }
  return Object.freeze({ name, width, height, states: Object.freeze(states) });
}

export function resolveCharacterState(manifestValue, requestedState, baseUrl) {
  const manifest = validateCharacterManifest(manifestValue);
  const name = REQUIRED_CHARACTER_STATES.includes(requestedState) ? requestedState : 'idle';
  const state = manifest.states[name];
  const root = String(baseUrl || '').endsWith('/') ? String(baseUrl || '') : `${String(baseUrl || '')}/`;
  return Object.freeze({
    name,
    sheetUrl: new URL(state.sheet, root).href,
    frames: state.frames,
    fps: state.fps,
    loop: state.loop,
    width: manifest.width,
    height: manifest.height,
    backgroundWidth: manifest.width * state.frames,
    animation: Object.freeze(buildSpriteAnimation(state)),
  });
}
