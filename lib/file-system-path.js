import { sanitizePackageName } from './package-utils.js';

const VALID_STRATEGIES = new Set(['uniquify', 'skip', 'overwrite']);

function safeSegments(relativePath) {
  const segments = String(relativePath || '')
    .split(/[\\/]+/)
    .map((segment) => segment.trim())
    .filter((segment) => segment && segment !== '.' && segment !== '..')
    .map(sanitizePackageName);
  if (!segments.length) throw new Error('保存路径不能为空');
  return segments;
}

function suffixName(name, sequence) {
  const dot = name.lastIndexOf('.');
  const base = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  return sanitizePackageName(`${base} (${sequence})${extension}`);
}

async function existingFile(directory, name) {
  try {
    const handle = await directory.getFileHandle(name, { create: false });
    return typeof handle?.name === 'string' ? handle : null;
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

async function existingDirectory(directory, name) {
  try {
    const handle = await directory.getDirectoryHandle(name, { create: false });
    return typeof handle?.name === 'string' ? handle : null;
  } catch (error) {
    if (error?.name === 'NotFoundError') return null;
    throw error;
  }
}

async function walkDirectories(rootHandle, segments) {
  let directory = rootHandle;
  for (const name of segments) {
    directory = await directory.getDirectoryHandle(name, { create: true });
  }
  return directory;
}

export async function resolveFilePath(rootHandle, relativePath, strategy = 'uniquify') {
  if (!rootHandle?.getFileHandle) {
    throw new Error('目录句柄无效');
  }
  const conflictStrategy = VALID_STRATEGIES.has(strategy) ? strategy : 'uniquify';
  const segments = safeSegments(relativePath);
  const requestedName = segments.pop();
  if (segments.length && !rootHandle?.getDirectoryHandle) throw new Error('目录句柄不支持创建子目录');
  const directory = await walkDirectories(rootHandle, segments);
  const existing = await existingFile(directory, requestedName);

  if (existing && conflictStrategy === 'skip') {
    return { fileHandle: null, skipped: true, relativePath: [...segments, requestedName].join('/') };
  }

  let fileName = requestedName;
  if (existing && conflictStrategy === 'uniquify') {
    let sequence = 2;
    while (await existingFile(directory, suffixName(requestedName, sequence))) sequence++;
    fileName = suffixName(requestedName, sequence);
  }

  const fileHandle = existing && conflictStrategy === 'overwrite'
    ? existing
    : await directory.getFileHandle(fileName, { create: true });
  return { fileHandle, skipped: false, relativePath: [...segments, fileName].join('/') };
}

export async function resolveDirectoryPath(rootHandle, relativePath, strategy = 'uniquify') {
  if (!rootHandle?.getDirectoryHandle) throw new Error('目录句柄无效');
  const conflictStrategy = VALID_STRATEGIES.has(strategy) ? strategy : 'uniquify';
  const segments = safeSegments(relativePath);
  const requestedName = segments.pop();
  const parent = await walkDirectories(rootHandle, segments);
  const existing = await existingDirectory(parent, requestedName);

  if (existing && conflictStrategy === 'skip') {
    return { directoryHandle: null, skipped: true, relativePath: [...segments, requestedName].join('/') };
  }

  let directoryName = requestedName;
  if (existing && conflictStrategy === 'uniquify') {
    let sequence = 2;
    while (await existingDirectory(parent, suffixName(requestedName, sequence))) sequence++;
    directoryName = suffixName(requestedName, sequence);
  }
  const directoryHandle = existing && conflictStrategy === 'overwrite'
    ? existing
    : await parent.getDirectoryHandle(directoryName, { create: true });
  return { directoryHandle, skipped: false, relativePath: [...segments, directoryName].join('/') };
}
