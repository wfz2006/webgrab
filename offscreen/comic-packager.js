import { StreamingZipWriter } from './archive-writer.js';
import { buildGalleryIndex } from '../lib/gallery-index.js';
import {
  escapeXml,
  extensionFromResource,
  fixedPageName,
  sanitizePackageName,
  sortComicResources,
} from '../lib/package-utils.js';
import { resolveDirectoryPath, resolveFilePath } from '../lib/file-system-path.js';
import { DEFAULT_DOWNLOAD_SETTINGS } from '../lib/download-settings.js';
import { runBoundedConcurrent } from '../lib/bounded-concurrency.js';

const encoder = new TextEncoder();

function abortError() {
  return new DOMException('任务已取消', 'AbortError');
}

async function writeFile(directory, name, bytes) {
  const handle = await directory.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  try {
    await writable.write(bytes);
    await writable.close();
  } catch (error) {
    await writable.abort?.(error).catch?.(() => {});
    throw error;
  }
}

function ascii(bytes, start, length) {
  return String.fromCharCode(...bytes.slice(start, start + length));
}

function hasRecognizedImageStructure(bytes) {
  if (bytes.length >= 4 && bytes[0] === 0xff && bytes[1] === 0xd8) {
    return bytes.at(-2) === 0xff && bytes.at(-1) === 0xd9;
  }
  if (bytes.length >= 20 && ascii(bytes, 1, 3) === 'PNG') {
    return ascii(bytes, bytes.length - 8, 4) === 'IEND';
  }
  if (bytes.length >= 10 && (ascii(bytes, 0, 6) === 'GIF87a' || ascii(bytes, 0, 6) === 'GIF89a')) {
    return bytes.at(-1) === 0x3b;
  }
  if (bytes.length >= 12 && ascii(bytes, 0, 4) === 'RIFF' && ascii(bytes, 8, 4) === 'WEBP') return true;
  if (bytes.length >= 12 && ascii(bytes, 4, 4) === 'ftyp' && /^(avif|avis)$/.test(ascii(bytes, 8, 4))) return true;
  if (bytes.length >= 2 && ascii(bytes, 0, 2) === 'BM') return true;
  if (bytes.length >= 4 && bytes[0] === 0 && bytes[1] === 0 && bytes[2] === 1 && bytes[3] === 0) return true;
  const prefix = new TextDecoder().decode(bytes.slice(0, Math.min(bytes.length, 1024))).trimStart();
  return /^(?:<\?xml[^>]*>\s*)?<svg\b/i.test(prefix) && /<\/svg>\s*$/i.test(new TextDecoder().decode(bytes));
}

function validateImage(bytes, contentType) {
  if (!bytes?.length) throw new Error('图片是 0 字节');
  if (contentType && !contentType.toLowerCase().startsWith('image/')) {
    throw new Error(`响应不是图片: ${contentType}`);
  }
  if (!hasRecognizedImageStructure(bytes)) throw new Error('图片结构不完整或格式不受支持');
}

function comicInfo({ title, source, pageCount, missingCount }) {
  return `<?xml version="1.0" encoding="utf-8"?>
<ComicInfo xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <Title>${escapeXml(title)}</Title>
  <PageCount>${pageCount}</PageCount>
  <Web>${escapeXml(source || '')}</Web>
  <Notes>${missingCount ? `WebGrab 打包，缺失 ${missingCount} 页` : 'WebGrab 打包'}</Notes>
</ComicInfo>`;
}

export async function packageComic(options) {
  const {
    resources,
    mode,
    directoryHandle,
    title,
    source,
    signal,
    onProgress = () => {},
    fetchImpl = globalThis.fetch,
    organizedPath,
    conflictStrategy = 'uniquify',
    concurrency = DEFAULT_DOWNLOAD_SETTINGS.segmentConcurrency,
  } = options;
  if (!directoryHandle) throw new Error('漫画打包缺少目录句柄');
  if (!['cbz', 'folder', 'both'].includes(mode)) throw new Error('不支持的漫画输出格式');

  const safeTitle = sanitizePackageName(title || 'WebGrab 漫画');
  const ordered = sortComicResources(resources).filter((item) => item?.url);
  const wantCbz = mode === 'cbz' || mode === 'both';
  const wantFolder = mode === 'folder' || mode === 'both';
  let archive = null;
  let folder = null;
  let successCount = 0;
  let failureCount = 0;
  let canceled = false;
  let completedCount = 0;
  const failures = [];
  const pageNames = [];

  try {
    if (wantCbz) {
      const cbzPath = organizedPath || `${safeTitle}.cbz`;
      const resolved = await resolveFilePath(directoryHandle, cbzPath, conflictStrategy);
      if (!resolved.skipped) {
        archive = new StreamingZipWriter(resolved.fileHandle);
        await archive.open();
      }
    }
    if (wantFolder) {
      const folderPath = String(organizedPath || safeTitle).replace(/\.cbz$/i, '');
      const resolved = await resolveDirectoryPath(directoryHandle, folderPath, conflictStrategy);
      if (!resolved.skipped) folder = resolved.directoryHandle;
    }
    if (!archive && !folder) {
      return { successCount: 0, failureCount: 0, failures: [], canceled: false, skipped: true, total: ordered.length };
    }

    const processPage = async (index) => {
      const resource = ordered[index];
      if (signal?.aborted) { canceled = true; return; }
      try {
        const response = await fetchImpl(resource.url, { signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = response.headers.get('content-type') || resource.mime || '';
        const bytes = new Uint8Array(await response.arrayBuffer());
        validateImage(bytes, contentType);
        const pageName = fixedPageName(index + 1, ordered.length, extensionFromResource(resource, contentType), contentType);
        if (archive) await archive.addStored(pageName, bytes);
        if (folder) await writeFile(folder, pageName, bytes);
        pageNames[index] = pageName;
        successCount++;
      } catch (error) {
        if (error?.name === 'AbortError' || signal?.aborted) { canceled = true; return; }
        failureCount++;
        if (failures.length < 20) failures.push({ url: resource.url, error: error?.message || String(error) });
      }
      completedCount++;
      onProgress({ completed: completedCount, total: ordered.length, successCount, failureCount });
    };

    await runBoundedConcurrent(ordered.length, concurrency, processPage, signal);
    if (signal?.aborted) canceled = true;

    if (successCount === 0) throw new Error(`没有可写入的有效图片（失败 ${failureCount} 页）`);
    if (archive) {
      await archive.addDeflated('ComicInfo.xml', encoder.encode(comicInfo({
        title: safeTitle, source, pageCount: successCount, missingCount: failureCount,
      })));
      await archive.close();
      archive = null;
    }
    if (folder) {
      const indexHtml = buildGalleryIndex({
        title: safeTitle,
        source,
        pages: pageNames.filter(Boolean),
        missingCount: failureCount,
      });
      await writeFile(folder, 'index.html', encoder.encode(indexHtml));
    }
    return { successCount, failureCount, failures, canceled, total: ordered.length };
  } catch (error) {
    await archive?.abort(error);
    throw error;
  }
}
