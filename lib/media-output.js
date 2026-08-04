const ADAPTIVE_MANIFEST_EXTENSIONS = new Set(['m3u8', 'm3u', 'mpd']);

function normalizedExtension(resource) {
  return String(resource?.ext || '')
    .trim()
    .replace(/^\.+/, '')
    .toLowerCase();
}

function replaceKnownExtension(value, extension) {
  const text = String(value || '');
  if (!text) return text;
  if (/\.(?:m3u8?|mpd)$/i.test(text)) {
    return text.replace(/\.(?:m3u8?|mpd)$/i, `.${extension}`);
  }
  return text;
}

/** 是否为需要解析并合并分片的 HLS/DASH 清单资源。 */
export function isAdaptiveStreamResource(resource) {
  return resource?.kind === 'stream' || ADAPTIVE_MANIFEST_EXTENSIONS.has(normalizedExtension(resource));
}

/**
 * Split a mixed batch before it reaches the generic file downloader.
 * Adaptive manifests describe many media segments; they are not media files themselves.
 */
export function partitionAdaptiveStreamResources(resources) {
  const adaptive = [];
  const ordinary = [];
  for (const resource of Array.isArray(resources) ? resources : []) {
    (isAdaptiveStreamResource(resource) ? adaptive : ordinary).push(resource);
  }
  return { adaptive, ordinary };
}

/**
 * 返回清单对应的实际输出资源描述。
 * offscreen 的 HLS/DASH 三条合并路径最终都产出 MP4，不能把清单扩展名沿用到成品。
 */
export function normalizeAdaptiveStreamOutput(resource) {
  if (!isAdaptiveStreamResource(resource)) return { ...resource };
  return {
    ...resource,
    ext: 'mp4',
    title: replaceKnownExtension(resource?.title, 'mp4'),
    ...(resource?.organizedPath
      ? { organizedPath: replaceKnownExtension(resource.organizedPath, 'mp4') }
      : {}),
  };
}

/** 根据原始清单扩展名选择解析器；MPD 必须优先于通用 kind=stream 判定。 */
export function adaptiveStreamType(resource) {
  const ext = normalizedExtension(resource);
  if (ext === 'mpd') return 'dash';
  if (ext === 'm3u8' || ext === 'm3u' || resource?.kind === 'stream') return 'hls';
  return null;
}
