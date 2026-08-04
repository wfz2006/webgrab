import { escapeXml } from './package-utils.js';

export const EPUB_MIMETYPE = 'application/epub+zip';

export const EPUB_CSS = `
html { color: #1f1f1f; background: #fff; }
body {
  margin: 5%;
  font-family: "Songti SC", "Noto Serif CJK SC", "STSong", serif;
  line-height: 1.8;
  text-align: justify;
}
h1 { font-size: 1.45em; line-height: 1.4; margin: 0 0 1.5em; text-align: center; }
p { margin: 0.5em 0; text-indent: 2em; }
blockquote { margin: 1em 2em; }
`.trim();

function isoModified(date = new Date()) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function createEpubMetadata(book, options = {}) {
  const randomId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return {
    title: book?.title || '未命名小说',
    author: book?.author || null,
    source: book?.source || '',
    language: options.language || 'zh-CN',
    identifier: options.identifier || `urn:uuid:${randomId}`,
    modified: options.modified || isoModified(),
  };
}

export function buildContainerXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml" />
  </rootfiles>
</container>`;
}

export function buildContentOpf(meta, chapters) {
  const creator = meta.author ? `\n    <dc:creator>${escapeXml(meta.author)}</dc:creator>` : '';
  const source = meta.source ? `\n    <dc:source>${escapeXml(meta.source)}</dc:source>` : '';
  const manifest = chapters.map((chapter) =>
    `    <item id="${escapeXml(chapter.id)}" href="${escapeXml(chapter.path)}" media-type="application/xhtml+xml" />`
  ).join('\n');
  const spine = chapters.map((chapter) => `    <itemref idref="${escapeXml(chapter.id)}" />`).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="${escapeXml(meta.language)}">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${escapeXml(meta.identifier)}</dc:identifier>
    <dc:title>${escapeXml(meta.title)}</dc:title>${creator}
    <dc:language>${escapeXml(meta.language)}</dc:language>${source}
    <meta property="dcterms:modified">${escapeXml(meta.modified)}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav" />
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml" />
    <item id="css" href="styles/book.css" media-type="text/css" />
${manifest}
  </manifest>
  <spine toc="ncx">
${spine}
  </spine>
</package>`;
}

export function buildNavXhtml(meta, chapters) {
  const items = chapters.map((chapter) =>
    `      <li><a href="${escapeXml(chapter.path)}">${escapeXml(chapter.title)}</a></li>`
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="${escapeXml(meta.language)}">
<head><meta charset="UTF-8" /><title>目录</title><link rel="stylesheet" type="text/css" href="styles/book.css" /></head>
<body><nav epub:type="toc" id="toc"><h1>${escapeXml(meta.title)}</h1><ol>
${items}
    </ol></nav></body>
</html>`;
}

export function buildTocNcx(meta, chapters) {
  const points = chapters.map((chapter, index) => `
    <navPoint id="navPoint-${index + 1}" playOrder="${index + 1}">
      <navLabel><text>${escapeXml(chapter.title)}</text></navLabel>
      <content src="${escapeXml(chapter.path)}" />
    </navPoint>`).join('');
  return `<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="${escapeXml(meta.identifier)}" /></head>
  <docTitle><text>${escapeXml(meta.title)}</text></docTitle>
  <navMap>${points}
  </navMap>
</ncx>`;
}

export function buildChapterXhtml(title, serializedBody) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN">
<head><meta charset="UTF-8" /><title>${escapeXml(title)}</title><link rel="stylesheet" type="text/css" href="../styles/book.css" /></head>
<body><h1>${escapeXml(title)}</h1>${serializedBody}</body>
</html>`;
}

const ALLOWED_TAGS = new Set([
  'P', 'BR', 'HR', 'H2', 'H3', 'H4', 'BLOCKQUOTE', 'UL', 'OL', 'LI',
  'EM', 'STRONG', 'I', 'B', 'U', 'S', 'SUB', 'SUP', 'DIV', 'SECTION', 'SPAN',
]);

export function normalizeChapterBody(html) {
  if (!globalThis.DOMParser || !globalThis.XMLSerializer) {
    throw new Error('当前环境无法生成合法 XHTML');
  }
  const doc = new DOMParser().parseFromString(`<body>${String(html || '')}</body>`, 'text/html');
  const body = doc.body;
  for (const element of [...body.querySelectorAll('*')]) {
    if (!ALLOWED_TAGS.has(element.tagName)) {
      element.replaceWith(...element.childNodes);
      continue;
    }
    for (const attribute of [...element.attributes]) element.removeAttribute(attribute.name);
  }
  const serializer = new XMLSerializer();
  return [...body.childNodes].map((node) => serializer.serializeToString(node)).join('');
}
