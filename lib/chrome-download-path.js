export function chromeConflictAction(strategy) {
  if (strategy === 'overwrite') return 'overwrite';
  if (strategy === 'skip') return 'prompt';
  return 'uniquify';
}

function normalizePath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/\/{2,}/g, '/').toLocaleLowerCase();
}

export async function hasMatchingDownload(relativePath, downloadsApi = globalThis.chrome?.downloads) {
  if (!downloadsApi?.search) return false;
  const normalized = normalizePath(relativePath);
  const basename = normalized.split('/').at(-1) || normalized;
  const items = await downloadsApi.search({ query: [basename] });
  return (items || []).some((item) => {
    if (item?.exists === false) return false;
    const filename = normalizePath(item?.filename);
    return filename === normalized || filename.endsWith(`/${normalized}`);
  });
}

export async function prepareChromeDownload(baseOptions, strategy = 'uniquify', downloadsApi = globalThis.chrome?.downloads) {
  if (strategy === 'skip' && await hasMatchingDownload(baseOptions.filename, downloadsApi)) {
    return { skipped: true, options: null };
  }
  return {
    skipped: false,
    options: {
      ...baseOptions,
      conflictAction: chromeConflictAction(strategy),
    },
  };
}
