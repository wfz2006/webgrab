/**
 * FileSystemFileHandle 的 IndexedDB 存取
 *
 * 为什么需要这一层：
 *   chrome.runtime.sendMessage 是 JSON 序列化，不是结构化克隆。
 *   FileSystemFileHandle 经 JSON 序列化后会变成空对象 {}（原型方法全丢，
 *   但仍为 truthy），下游调用 createWritable() 会抛 TypeError。
 *
 *   FileSystemFileHandle 是可结构化克隆的，能存进 IndexedDB。
 *   popup 和 offscreen 同属扩展 origin（chrome-extension://<id>/），
 *   共享同一个 IndexedDB，因此可作为跨上下文传递句柄的中转站。
 *
 * 传递路径：
 *   popup 拿到 handle → putHandle(key, handle) → 消息只传 key 字符串
 *   → offscreen getHandle(key) 取出真 handle → createWritable()
 *
 * 使用约定：
 *   - key 用 crypto.randomUUID() 生成
 *   - 任务进入终态（done/failed/canceled）后必须调 deleteHandle(key) 清理
 */

const DB_NAME = 'webgrab';
const DB_VERSION = 1;
const STORE_NAME = 'fileHandles';

/** @type {Promise<IDBDatabase>|null} 缓存的 DB 连接 */
let dbPromise = null;

/**
 * 打开并缓存 IndexedDB 连接
 * @returns {Promise<IDBDatabase>}
 */
function getDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME);
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

/**
 * 存入 FileSystemFileHandle
 * @param {string} key
 * @param {FileSystemFileHandle} handle
 * @returns {Promise<void>}
 */
export async function putHandle(key, handle) {
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(handle, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

/**
 * 取出 FileSystemFileHandle
 * @param {string} key
 * @returns {Promise<FileSystemFileHandle|null>}
 */
export async function getHandle(key) {
  if (!key) return null;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readonly');
    const req = tx.objectStore(STORE_NAME).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/**
 * 删除 FileSystemFileHandle（任务终态后清理）
 * @param {string} key
 * @returns {Promise<void>}
 */
export async function deleteHandle(key) {
  if (!key) return;
  const db = await getDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).delete(key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
