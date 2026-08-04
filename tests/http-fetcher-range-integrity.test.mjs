import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpFetcher } from '../offscreen/http-fetcher.js';

const TWO_MIB = 2 * 1024 * 1024;

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function preparedFetcher() {
  const fetcher = new HttpFetcher(['https://cdn.example.test/video'], {
    concurrency: 1,
    chunkSize: 1024 * 1024,
  });
  fetcher.probe = async () => ({ totalSize: TWO_MIB, acceptRanges: true });
  fetcher._sleep = async () => {};
  return fetcher;
}

test('分块请求若返回 200 全文件，必须失败而不是按 Range 偏移重复写坏文件', async () => {
  const fetcher = preparedFetcher();
  let writes = 0;

  await withFetch(async () => new Response(new Uint8Array(TWO_MIB), {
    status: 200,
    headers: { 'content-length': String(TWO_MIB) },
  }), async () => {
    await assert.rejects(
      fetcher.download(undefined, async () => { writes += 1; }),
      /Range.*206|分块.*失败/i
    );
  });

  assert.equal(writes, 0);
});

test('206 的 Content-Range 或响应字节数与请求区间不符时拒绝写盘', async () => {
  const fetcher = preparedFetcher();
  let writes = 0;

  await withFetch(async (_url, init) => {
    const requested = new Headers(init.headers).get('range');
    assert.ok(requested);
    return new Response(new Uint8Array(16), {
      status: 206,
      headers: {
        'content-range': `bytes 99-114/${TWO_MIB}`,
        'content-length': '16',
      },
    });
  }, async () => {
    await assert.rejects(
      fetcher.download(undefined, async () => { writes += 1; }),
      /Content-Range|分块.*失败/i
    );
  });

  assert.equal(writes, 0);
});
