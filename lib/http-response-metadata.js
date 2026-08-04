const MIME_EXTENSIONS = Object.freeze({
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'video/x-flv': 'flv',
  'audio/mp4': 'm4a',
  'audio/mpeg': 'mp3',
  'audio/aac': 'aac',
  'application/vnd.apple.mpegurl': 'm3u8',
  'application/x-mpegurl': 'm3u8',
  'application/dash+xml': 'mpd',
});

export function inferMediaExtension(mime) {
  const normalized = String(mime || '').split(';')[0].trim().toLowerCase();
  return MIME_EXTENSIONS[normalized] || '';
}

export function parseResponseMetadata(responseHeaders) {
  let contentType = '';
  let contentLength = -1;
  let contentRange = '';

  for (const header of Array.isArray(responseHeaders) ? responseHeaders : []) {
    const name = String(header?.name || '').toLowerCase();
    const value = String(header?.value || '');
    if (name === 'content-type') contentType = value.split(';')[0].trim().toLowerCase();
    else if (name === 'content-length') {
      const parsed = Number.parseInt(value, 10);
      if (Number.isSafeInteger(parsed) && parsed >= 0) contentLength = parsed;
    } else if (name === 'content-range') {
      contentRange = value.trim();
    }
  }

  const rangeMatch = contentRange.match(/^bytes\s+\d+-\d+\/(\d+|\*)$/i);
  const rangeTotal = rangeMatch && rangeMatch[1] !== '*'
    ? Number.parseInt(rangeMatch[1], 10)
    : -1;

  return {
    contentType,
    contentLength,
    totalLength: Number.isSafeInteger(rangeTotal) && rangeTotal >= 0 ? rangeTotal : contentLength,
    isPartial: Boolean(rangeMatch),
    inferredExt: inferMediaExtension(contentType),
  };
}
