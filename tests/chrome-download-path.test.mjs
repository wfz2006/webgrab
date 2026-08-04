import test from 'node:test';
import assert from 'node:assert/strict';

import { chromeConflictAction, prepareChromeDownload } from '../lib/chrome-download-path.js';

test('Chrome conflict actions map rename and overwrite without changing relative filename', async () => {
  assert.equal(chromeConflictAction('uniquify'), 'uniquify');
  assert.equal(chromeConflictAction('overwrite'), 'overwrite');
  const result = await prepareChromeDownload(
    { url: 'https://example.test/a.jpg', filename: 'WebGrab/图片/Site/a.jpg' },
    'uniquify',
    { search: async () => [] }
  );
  assert.equal(result.options.filename, 'WebGrab/图片/Site/a.jpg');
  assert.equal(result.options.conflictAction, 'uniquify');
  assert.equal(result.skipped, false);
});

test('skip detects an existing matching download path and does not overwrite', async () => {
  const downloadsApi = {
    search: async () => [{ filename: 'C:\\Users\\me\\Downloads\\WebGrab\\图片\\Site\\a.jpg', exists: true, state: 'complete' }],
  };
  const result = await prepareChromeDownload(
    { url: 'https://example.test/a.jpg', filename: 'WebGrab/图片/Site/a.jpg' },
    'skip',
    downloadsApi
  );
  assert.equal(result.skipped, true);
  assert.equal(result.options, null);
});

test('skip never silently maps to overwrite when no matching history item exists', async () => {
  const result = await prepareChromeDownload(
    { url: 'https://example.test/a.jpg', filename: 'WebGrab/图片/Site/a.jpg' },
    'skip',
    { search: async () => [] }
  );
  assert.equal(result.skipped, false);
  assert.equal(result.options.conflictAction, 'prompt');
});
