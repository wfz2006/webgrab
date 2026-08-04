import test from 'node:test';
import assert from 'node:assert/strict';

let metadataModule = {};
try {
  metadataModule = await import('../lib/http-response-metadata.js');
} catch {
  // RED: helper 尚未实现。
}

test('206 Range 响应用 Content-Range 总长度，不把单段 Content-Length 冒充完整文件', () => {
  assert.equal(typeof metadataModule.parseResponseMetadata, 'function');
  const result = metadataModule.parseResponseMetadata([
    { name: 'Content-Type', value: 'video/mp4; charset=binary' },
    { name: 'Content-Length', value: '1048576' },
    { name: 'Content-Range', value: 'bytes 0-1048575/39501347' },
  ]);

  assert.deepEqual(result, {
    contentType: 'video/mp4',
    contentLength: 1_048_576,
    totalLength: 39_501_347,
    isPartial: true,
    inferredExt: 'mp4',
  });
});

test('无扩展名 URL 可由常见媒体 MIME 推导成品扩展名', () => {
  assert.equal(typeof metadataModule.inferMediaExtension, 'function');
  assert.equal(metadataModule.inferMediaExtension('video/mp4'), 'mp4');
  assert.equal(metadataModule.inferMediaExtension('audio/mp4'), 'm4a');
  assert.equal(metadataModule.inferMediaExtension('application/vnd.apple.mpegurl'), 'm3u8');
  assert.equal(metadataModule.inferMediaExtension('application/octet-stream'), '');
});
