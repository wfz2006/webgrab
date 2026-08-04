import { getNovel } from '../lib/novel-store.js';
import { StreamingZipWriter } from './archive-writer.js';
import {
  EPUB_CSS,
  EPUB_MIMETYPE,
  buildChapterXhtml,
  buildContainerXml,
  buildContentOpf,
  buildNavXhtml,
  buildTocNcx,
  createEpubMetadata,
  normalizeChapterBody,
} from '../lib/epub-builder.js';

const encoder = new TextEncoder();

export async function packageEpub(options) {
  const {
    bookId,
    fileHandle,
    signal,
    onProgress = () => {},
    getNovelImpl = getNovel,
    normalizeBodyImpl = normalizeChapterBody,
  } = options;
  if (!bookId) throw new Error('EPUB 打包缺少 bookId');
  if (!fileHandle) throw new Error('EPUB 打包缺少文件句柄');
  const book = await getNovelImpl(bookId);
  if (!book?.chapters?.length) throw new Error('P4-1 书库中没有可打包的章节');

  const archive = new StreamingZipWriter(fileHandle);
  const metadata = createEpubMetadata(book);
  const successful = [];
  const failures = [];
  let failureCount = 0;
  let canceled = false;

  try {
    await archive.open();
    await archive.addStored('mimetype', encoder.encode(EPUB_MIMETYPE));
    await archive.addDeflated('META-INF/container.xml', encoder.encode(buildContainerXml()));
    await archive.addDeflated('OEBPS/styles/book.css', encoder.encode(EPUB_CSS));

    for (let index = 0; index < book.chapters.length; index++) {
      const chapter = book.chapters[index];
      if (signal?.aborted) { canceled = true; break; }
      try {
        const ordinal = successful.length + 1;
        const id = `chapter-${String(ordinal).padStart(4, '0')}`;
        const path = `text/${id}.xhtml`;
        const body = normalizeBodyImpl(chapter.html || '');
        if (!body || !(chapter.text || '').trim()) throw new Error('章节正文为空');
        const xhtml = buildChapterXhtml(chapter.title || `第 ${index + 1} 章`, body);
        await archive.addDeflated(`OEBPS/${path}`, encoder.encode(xhtml));
        successful.push({ id, path, title: chapter.title || `第 ${index + 1} 章`, sourceIndex: chapter.index });
      } catch (error) {
        failureCount++;
        if (failures.length < 20) {
          failures.push({ index: chapter.index, title: chapter.title, url: chapter.url, error: error?.message || String(error) });
        }
      }
      onProgress({
        completed: index + 1,
        total: book.chapters.length,
        successCount: successful.length,
        failureCount,
        currentTitle: chapter.title || '',
      });
    }

    if (successful.length === 0) throw new Error(`没有可写入 EPUB 的有效章节（失败 ${failureCount} 章）`);
    await archive.addDeflated('OEBPS/nav.xhtml', encoder.encode(buildNavXhtml(metadata, successful)));
    await archive.addDeflated('OEBPS/toc.ncx', encoder.encode(buildTocNcx(metadata, successful)));
    await archive.addDeflated('OEBPS/content.opf', encoder.encode(buildContentOpf(metadata, successful)));
    await archive.close();
    return {
      successCount: successful.length,
      failureCount,
      failures,
      total: book.chapters.length,
      canceled,
      title: book.title,
    };
  } catch (error) {
    await archive.abort(error);
    throw error;
  }
}
