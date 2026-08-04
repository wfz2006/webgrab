const DIGIT_RE = /(\d+)/g;
const WINDOWS_RESERVED_RE = /[<>:"/\\|?*\u0000-\u001f]+/g;
const WINDOWS_DEVICE_RE = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;
const MAX_PACKAGE_CODE_POINTS = 120;
const MAX_WINDOWS_SEGMENT_BYTES = 255;

function utf8ByteLength(value) {
  return new TextEncoder().encode(value).byteLength;
}

function truncateUtf8(value, maxBytes) {
  if (utf8ByteLength(value) <= maxBytes) return value;
  let result = '';
  let used = 0;
  for (const character of String(value)) {
    const bytes = utf8ByteLength(character);
    if (used + bytes > maxBytes) break;
    result += character;
    used += bytes;
  }
  return result;
}

function splitExtension(value) {
  const dotIndex = value.lastIndexOf('.');
  if (dotIndex <= 0 || dotIndex === value.length - 1) return { base: value, extension: '' };
  return { base: value.slice(0, dotIndex), extension: value.slice(dotIndex) };
}

export function naturalCompare(left, right) {
  return String(left || '').localeCompare(String(right || ''), undefined, {
    numeric: true,
    sensitivity: 'base',
  });
}

function resourceSortLabel(resource) {
  return resource?.title || resource?.fileName || resource?.url || '';
}

export function sortComicResources(resources) {
  return (Array.isArray(resources) ? resources : [])
    .map((resource, inputIndex) => ({ resource, inputIndex }))
    .sort((a, b) => {
      const ai = Number.isFinite(a.resource?.domIndex) ? a.resource.domIndex : null;
      const bi = Number.isFinite(b.resource?.domIndex) ? b.resource.domIndex : null;
      if (ai !== null && bi !== null && ai !== bi) return ai - bi;
      if (ai !== null && bi === null) return -1;
      if (ai === null && bi !== null) return 1;
      const labelResult = naturalCompare(resourceSortLabel(a.resource), resourceSortLabel(b.resource));
      return labelResult || a.inputIndex - b.inputIndex;
    })
    .map(({ resource }) => resource);
}

export function normalizeImageExtension(extension, mime = '') {
  let ext = String(extension || '').trim().replace(/^\.+/, '').toLowerCase();
  if (ext === 'jpeg') ext = 'jpg';
  if (!ext && mime.startsWith('image/')) ext = mime.slice(6).split(';')[0];
  if (ext === 'jpeg') ext = 'jpg';
  if (!/^[a-z0-9]{2,5}$/.test(ext)) ext = 'jpg';
  return ext;
}

export function fixedPageName(index, total, extension, mime = '') {
  const width = Math.max(3, String(Math.max(1, Number(total) || 1)).length);
  return `${String(Math.max(1, Number(index) || 1)).padStart(width, '0')}.${normalizeImageExtension(extension, mime)}`;
}

export function sanitizePackageName(value) {
  let cleaned = String(value || '')
    .replace(WINDOWS_RESERVED_RE, '_')
    .replace(/[.\s]+$/g, '')
    .trim();
  if (!cleaned || /^\.+$/.test(cleaned)) return 'WebGrab';

  let { base, extension } = splitExtension(cleaned);
  const deviceDot = base.indexOf('.');
  const deviceStem = (deviceDot >= 0 ? base.slice(0, deviceDot) : base).replace(/[.\s]+$/g, '');
  if (WINDOWS_DEVICE_RE.test(deviceStem)) {
    base = `${deviceStem}_${deviceDot >= 0 ? base.slice(deviceDot) : ''}`;
  }

  const maxBaseCodePoints = Math.max(1, MAX_PACKAGE_CODE_POINTS - Array.from(extension).length);
  base = Array.from(base).slice(0, maxBaseCodePoints).join('');
  extension = Array.from(extension).slice(0, MAX_PACKAGE_CODE_POINTS - Array.from(base).length).join('');

  const extensionBytes = utf8ByteLength(extension);
  if (extensionBytes >= MAX_WINDOWS_SEGMENT_BYTES) {
    extension = truncateUtf8(extension, Math.floor(MAX_WINDOWS_SEGMENT_BYTES / 2));
  }
  base = truncateUtf8(base, MAX_WINDOWS_SEGMENT_BYTES - utf8ByteLength(extension));
  cleaned = `${base}${extension}`.replace(/[.\s]+$/g, '');
  return cleaned && !/^\.+$/.test(cleaned) ? cleaned : 'WebGrab';
}

export function escapeXml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function extensionFromResource(resource, contentType = '') {
  if (resource?.ext) return normalizeImageExtension(resource.ext, contentType);
  try {
    const pathname = new URL(resource?.url || '').pathname;
    const match = pathname.match(/\.([a-z0-9]{2,5})$/i);
    if (match) return normalizeImageExtension(match[1], contentType);
  } catch {}
  return normalizeImageExtension('', contentType);
}
