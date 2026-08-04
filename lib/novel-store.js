/**
 * P4-1 小说内部书库。
 *
 * 独立数据库避免升级既有 webgrab/fileHandles 数据库时被旧连接阻塞。
 * 正文按章节分开保存，book 元数据只包含轻量计划、计数和失败摘要。
 */

const DB_NAME = 'webgrab_novels';
const DB_VERSION = 1;
const BOOKS = 'books';
const CHAPTERS = 'chapters';
const MAX_FAILURES = 100;

let dbPromise = null;

function requestResult(request) {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error('IndexedDB 请求失败'));
  });
}

function transactionDone(transaction) {
  return new Promise((resolve, reject) => {
    transaction.oncomplete = () => resolve();
    transaction.onabort = () => reject(transaction.error || new Error('IndexedDB 事务已中止'));
    transaction.onerror = () => reject(transaction.error || new Error('IndexedDB 事务失败'));
  });
}

export function openNovelDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(BOOKS)) {
        const books = db.createObjectStore(BOOKS, { keyPath: 'id' });
        books.createIndex('source', 'source', { unique: false });
        books.createIndex('updatedAt', 'updatedAt', { unique: false });
      }
      if (!db.objectStoreNames.contains(CHAPTERS)) {
        const chapters = db.createObjectStore(CHAPTERS, { keyPath: ['bookId', 'index'] });
        chapters.createIndex('bookId', 'bookId', { unique: false });
      }
    };
    request.onsuccess = () => {
      const db = request.result;
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      resolve(db);
    };
    request.onerror = () => {
      dbPromise = null;
      reject(request.error || new Error('无法打开小说数据库'));
    };
    request.onblocked = () => {
      dbPromise = null;
      reject(new Error('小说数据库被旧连接阻塞，请重载扩展后重试'));
    };
  });
  return dbPromise;
}

export function createBookId(prefix = 'novel') {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

export async function createPreparedBook(input) {
  const now = Date.now();
  const book = {
    id: input.id || createBookId(),
    kind: 'novel',
    title: input.title || '未命名小说',
    author: input.author || null,
    source: input.source,
    catalogUrl: input.catalogUrl || input.source,
    status: input.status || 'prepared',
    plan: Array.isArray(input.plan) ? input.plan : [],
    detectedCount: input.detectedCount ?? input.plan?.length ?? 0,
    plannedCount: input.plannedCount ?? input.plan?.length ?? 0,
    completedCount: 0,
    successCount: 0,
    failureCount: 0,
    skippedExternalCount: input.skippedExternalCount || 0,
    skippedExternal: (input.skippedExternal || []).slice(0, 50),
    failures: [],
    truncated: Boolean(input.truncated),
    estimatedDelayMinutes: input.estimatedDelayMinutes || { min: 0, max: 0 },
    currentIndex: null,
    currentTitle: null,
    createdAt: now,
    updatedAt: now,
    completedAt: null,
  };
  const db = await openNovelDb();
  const transaction = db.transaction(BOOKS, 'readwrite');
  transaction.objectStore(BOOKS).put(book);
  await transactionDone(transaction);
  return book;
}

export async function getBook(bookId) {
  const db = await openNovelDb();
  return requestResult(db.transaction(BOOKS, 'readonly').objectStore(BOOKS).get(bookId));
}

export async function getLatestBookBySource(source) {
  const db = await openNovelDb();
  const books = await requestResult(
    db.transaction(BOOKS, 'readonly').objectStore(BOOKS).index('source').getAll(source)
  );
  return books.sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
}

export async function updateBook(bookId, patch) {
  const db = await openNovelDb();
  const transaction = db.transaction(BOOKS, 'readwrite');
  const store = transaction.objectStore(BOOKS);
  const book = await requestResult(store.get(bookId));
  if (!book) {
    transaction.abort();
    throw new Error(`小说记录不存在: ${bookId}`);
  }
  const updated = { ...book, ...patch, id: bookId, updatedAt: Date.now() };
  store.put(updated);
  await transactionDone(transaction);
  return updated;
}

export async function markExtracting(bookId) {
  return updateBook(bookId, {
    status: 'extracting',
    currentIndex: null,
    currentTitle: null,
    completedAt: null,
  });
}

export async function setCurrentChapter(bookId, index, title) {
  return updateBook(bookId, { currentIndex: index, currentTitle: title });
}

export async function recordChapterSuccess(bookId, chapter) {
  const db = await openNovelDb();
  const transaction = db.transaction([BOOKS, CHAPTERS], 'readwrite');
  const books = transaction.objectStore(BOOKS);
  const stored = await requestResult(books.get(bookId));
  if (!stored) {
    transaction.abort();
    throw new Error(`小说记录不存在: ${bookId}`);
  }
  const now = Date.now();
  transaction.objectStore(CHAPTERS).put({
    bookId,
    index: chapter.index,
    title: chapter.title,
    html: chapter.html,
    text: chapter.text,
    url: chapter.url,
    createdAt: now,
  });
  books.put({
    ...stored,
    completedCount: stored.completedCount + 1,
    successCount: stored.successCount + 1,
    currentIndex: chapter.index,
    currentTitle: chapter.title,
    updatedAt: now,
  });
  await transactionDone(transaction);
}

export async function recordChapterFailure(bookId, chapter, error) {
  const book = await getBook(bookId);
  if (!book) throw new Error(`小说记录不存在: ${bookId}`);
  const failure = {
    index: chapter.index,
    title: chapter.title,
    url: chapter.url,
    error: error?.message || String(error),
  };
  return updateBook(bookId, {
    completedCount: book.completedCount + 1,
    failureCount: book.failureCount + 1,
    failures: [...(book.failures || []), failure].slice(0, MAX_FAILURES),
    currentIndex: chapter.index,
    currentTitle: chapter.title,
  });
}

export async function markBookTerminal(bookId, status, error = null) {
  const patch = {
    status,
    currentIndex: null,
    currentTitle: null,
    completedAt: Date.now(),
  };
  if (error) patch.error = error?.message || String(error);
  return updateBook(bookId, patch);
}

export async function saveSingleChapter(chapter, source) {
  const book = await createPreparedBook({
    id: createBookId('chapter'),
    title: chapter.title,
    author: chapter.byline || null,
    source,
    catalogUrl: source,
    plan: [{ index: 0, title: chapter.title, url: chapter.url }],
    detectedCount: 1,
    plannedCount: 1,
  });
  await markExtracting(book.id);
  await recordChapterSuccess(book.id, { ...chapter, index: 0 });
  return markBookTerminal(book.id, 'done');
}

export async function getNovel(bookId) {
  const db = await openNovelDb();
  const transaction = db.transaction([BOOKS, CHAPTERS], 'readonly');
  const book = await requestResult(transaction.objectStore(BOOKS).get(bookId));
  if (!book) return null;
  const chapters = await requestResult(
    transaction.objectStore(CHAPTERS).index('bookId').getAll(bookId)
  );
  await transactionDone(transaction);
  return {
    kind: 'novel',
    title: book.title,
    author: book.author || null,
    source: book.source,
    chapters: chapters
      .sort((a, b) => a.index - b.index)
      .map(({ index, title, html, text, url }) => ({ index, title, html, text, url })),
  };
}

export async function deleteBook(bookId) {
  const db = await openNovelDb();
  const transaction = db.transaction([BOOKS, CHAPTERS], 'readwrite');
  transaction.objectStore(BOOKS).delete(bookId);
  const chapterStore = transaction.objectStore(CHAPTERS);
  const keys = await requestResult(chapterStore.index('bookId').getAllKeys(bookId));
  keys.forEach((key) => chapterStore.delete(key));
  await transactionDone(transaction);
}

export const NOVEL_DB_INFO = Object.freeze({
  name: DB_NAME,
  version: DB_VERSION,
  booksStore: BOOKS,
  chaptersStore: CHAPTERS,
});
