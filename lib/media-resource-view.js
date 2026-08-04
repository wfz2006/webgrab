const STREAM_MANIFEST_EXTENSIONS = new Set(['m3u8', 'mpd']);
const STREAM_SEGMENT_EXTENSIONS = new Set(['ts', 'm4s']);

function normalizedExtension(resource) {
  return String(resource?.ext || '').replace(/^\.+/, '').toLowerCase();
}

/**
 * 播放列表已经存在时，TS/m4s 是播放器内部的原始分片，不是可直接观看的成品。
 * 保留底层资源表用于诊断，只在面向用户的列表中隐藏；如果没有捕获到播放列表，
 * 仍保留分片作为故障排查入口。
 * @param {Array<Object>} resources
 * @returns {Array<Object>}
 */
export function suppressRedundantStreamSegments(resources) {
  // MediaSource blob 只在创建它的页面上下文内有效，既不是 HLS 清单，也不能由
  // offscreen/chrome.downloads 跨上下文重新读取，因此不提供误导性的下载入口。
  const list = (Array.isArray(resources) ? resources : []).filter((resource) => (
    !String(resource?.url || '').toLowerCase().startsWith('blob:')
  ));
  const hasPrimaryVideo = list.some((resource) => (
    resource?.isPrimaryMedia === true && resource?.kind === 'video'
  ));
  if (hasPrimaryVideo) {
    return list.filter((resource) => (
      resource?.kind !== 'video'
      && resource?.kind !== 'stream'
    ) || resource?.isPrimaryMedia === true);
  }
  const hasManifest = list.some((resource) => (
    resource?.kind === 'stream' && STREAM_MANIFEST_EXTENSIONS.has(normalizedExtension(resource))
  ));
  if (!hasManifest) return [...list];
  return list.filter((resource) => !STREAM_SEGMENT_EXTENSIONS.has(normalizedExtension(resource)));
}

const DIRECT_VIDEO_EXTENSIONS = new Set(['mp4', 'webm', 'mov', 'mkv']);

function isMediaCandidate(resource) {
  return resource?.kind === 'video' || resource?.kind === 'stream';
}

function mediaCandidateScore(resource) {
  const ext = normalizedExtension(resource);
  const size = Number(resource?.size);
  let score = 0;

  // 播放清单明确描述了一套可合并的完整媒体，优先级高于网页自身的小型 MP4 动效。
  // 对普通直链视频仍用文件大小区分主内容与辅助素材。
  if (STREAM_MANIFEST_EXTENSIONS.has(ext)) score += 80;
  if (DIRECT_VIDEO_EXTENSIONS.has(ext)) score += 40;
  if (Number.isFinite(size) && size > 0) score += Math.log2(size);
  if (resource?.source === 'hook') score += 2;
  if (Number(resource?.width) > 0 && Number(resource?.height) > 0) score += 2;
  if (Number(resource?.duration) > 0) score += 1;
  return score;
}

function pickRecommendedCandidate(candidates) {
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (const candidate of candidates) {
    const score = mediaCandidateScore(candidate);
    const isNewerTie = score === bestScore
      && Number(candidate?.discoveredAt || 0) > Number(best?.discoveredAt || 0);
    if (best === null || score > bestScore || isNewerTie) {
      best = candidate;
      bestScore = score;
    }
  }
  return best;
}

/**
 * 面向用户整理媒体候选，但不修改底层资源表：
 * - 站点探针给出的 isPrimaryMedia 是权威主视频，只展示这一项；
 * - 没有权威结果时，只把格式/大小最可信的一项标为推荐候选，其余默认折叠；
 * - showSecondary 可展开全部候选，推荐标记仍保留。
 *
 * @param {Array<Object>} resources
 * @param {{showSecondary?: boolean}} [options]
 * @returns {{resources:Array<Object>, mode:'none'|'primary'|'recommended', hiddenCount:number}}
 */
export function buildMediaCandidateView(resources, { showSecondary = false } = {}) {
  const prepared = suppressRedundantStreamSegments(resources);
  const primary = prepared.find((resource) => (
    resource?.isPrimaryMedia === true && resource?.kind === 'video'
  ));

  if (primary) {
    return {
      resources: prepared.map((resource) => (
        resource === primary ? { ...resource, mediaCandidateRole: 'primary' } : resource
      )),
      mode: 'primary',
      hiddenCount: 0,
    };
  }

  const candidates = prepared.filter(isMediaCandidate);
  if (candidates.length === 0) {
    return { resources: prepared, mode: 'none', hiddenCount: 0 };
  }

  const recommended = pickRecommendedCandidate(candidates);
  const annotated = prepared.map((resource) => (
    resource === recommended ? { ...resource, mediaCandidateRole: 'recommended' } : resource
  ));
  const visible = showSecondary
    ? annotated
    : annotated.filter((resource) => !isMediaCandidate(resource) || resource.url === recommended.url);

  return {
    resources: visible,
    mode: 'recommended',
    hiddenCount: Math.max(0, candidates.length - 1),
  };
}
