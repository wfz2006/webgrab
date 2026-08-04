import test from 'node:test';
import assert from 'node:assert/strict';
import { HttpFetcher } from '../offscreen/http-fetcher.js';

/**
 * 小于分块阈值（1MB）的文件走单线程流式下载。真机实测发现这条分支此前完全
 * 没有完整性校验：
 *
 *   1. probe() 会发一个 `Range: bytes=0-0` 的请求，Chrome 把这个 1 字节的
 *      206 响应写进了 HTTP 缓存；
 *   2. 紧接着 _downloadStream() 发不带 Range 的完整 GET，命中缓存后拿回的是
 *      `status: 200` + `Content-Length: <完整长度>`，但 body 只有 1 字节；
 *   3. 读到 done 就当成功返回，磁盘上落下一个 1 字节残file，任务却报 done。
 *
 * 这里用真机抓到的响应形态复现，并锁死修复：探测不得污染缓存，流式下载必须
 * 校验实际字节数。
 */

const TOTAL = 33_157;

async function withFetch(mock, run) {
  const previous = globalThis.fetch;
  globalThis.fetch = mock;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

function streamFetcher(urls = ['https://cdn.example.test/photo.jpg']) {
  const fetcher = new HttpFetcher(urls, { concurrency: 1 });
  fetcher._sleep = async () => {};
  return fetcher;
}

function bodyOf(bytes) {
  return {
    getReader() {
      let sent = false;
      return {
        async read() {
          if (sent) return { done: true, value: undefined };
          sent = true;
          return { done: false, value: bytes };
        },
        cancel() {},
      };
    },
  };
}

function headersOf(map) {
  return { get: (name) => map[name.toLowerCase()] ?? null };
}

/** _fetchWithTimeout 会把 init.headers 归一成 Headers 对象，读取要按 Headers 来。 */
function rangeOf(init) {
  const headers = init?.headers;
  if (!headers) return null;
  if (typeof headers.get === 'function') return headers.get('range');
  return headers.Range ?? headers.range ?? null;
}

test('缓存把完整 GET 截断成 1 字节（声明 Content-Length 却只给 1 字节）时必须失败，不能落下残file还报成功', async () => {
  const fetcher = streamFetcher();
  const written = [];

  await withFetch(async (_url, init) => {
    const range = rangeOf(init);
    if (range === 'bytes=0-0') {
      return {
        ok: true,
        status: 206,
        headers: headersOf({ 'content-range': `bytes 0-0/${TOTAL}`, 'content-length': '1' }),
        body: bodyOf(Uint8Array.of(0xff)),
      };
    }
    // 真机抓到的形态：200 + 完整 Content-Length，但 body 被缓存截断成 1 字节
    return {
      ok: true,
      status: 200,
      headers: headersOf({ 'content-length': String(TOTAL) }),
      body: bodyOf(Uint8Array.of(0xff)),
    };
  }, async () => {
    await assert.rejects(
      fetcher.download(undefined, async (chunk) => { written.push(chunk.length); }),
      /截断|不完整|字节/,
      '响应被截断必须报错，静默成功等于把残file当完整文件交付'
    );
  });
});

test('探测请求必须绕开 HTTP 缓存，避免把 1 字节分片响应写进缓存污染后续完整 GET', async () => {
  const fetcher = streamFetcher();
  const probeInits = [];

  await withFetch(async (_url, init) => {
    const range = rangeOf(init);
    if (range === 'bytes=0-0') {
      probeInits.push(init);
      return {
        ok: true,
        status: 206,
        headers: headersOf({ 'content-range': `bytes 0-0/${TOTAL}`, 'content-length': '1' }),
        body: bodyOf(Uint8Array.of(0xff)),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: headersOf({ 'content-length': String(TOTAL) }),
      body: bodyOf(new Uint8Array(TOTAL)),
    };
  }, async () => {
    await fetcher.download(undefined, async () => {});
  });

  assert.equal(probeInits.length, 1);
  assert.equal(
    probeInits[0].cache,
    'no-store',
    '探测请求必须用 cache: no-store，否则 1 字节的 206 会进缓存并毒化随后的完整 GET'
  );
});

test('遇到截断先原地重取一次（绕开缓存），拿到完整字节就正常完成', async () => {
  const fetcher = streamFetcher();
  const fullGets = [];
  // 按 offset 归位统计最终文件长度——重试会把同一段重发一次，
  // FileWriter 也是按 offset 覆盖的，简单累加不是真实落盘大小。
  let fileExtent = 0;

  await withFetch(async (_url, init) => {
    const range = rangeOf(init);
    if (range === 'bytes=0-0') {
      return {
        ok: true,
        status: 206,
        headers: headersOf({ 'content-range': `bytes 0-0/${TOTAL}`, 'content-length': '1' }),
        body: bodyOf(Uint8Array.of(0xff)),
      };
    }
    fullGets.push(init);
    // 第一次完整 GET 命中被污染的缓存，重取（no-store）时拿到完整内容
    const truncated = fullGets.length === 1;
    return {
      ok: true,
      status: 200,
      headers: headersOf({ 'content-length': String(TOTAL) }),
      body: bodyOf(truncated ? Uint8Array.of(0xff) : new Uint8Array(TOTAL)),
    };
  }, async () => {
    await fetcher.download(undefined, async (chunk) => {
      fileExtent = Math.max(fileExtent, chunk.offset + chunk.length);
    });
  });

  assert.equal(fullGets.length, 2, '截断后必须重取一次');
  assert.equal(fullGets[1].cache, 'no-store', '重取必须绕开缓存，否则还会拿到同一份被截断的响应');
  assert.equal(fileExtent, TOTAL, '重取成功后最终文件长度必须等于完整长度');
  assert.equal(fetcher.progress.downloaded, TOTAL, '进度必须反映本次成功尝试的字节数，不能把失败尝试累加进去');
});

test('服务器不给 Content-Length 且探测也拿不到总长时，不做长度校验也不误报失败', async () => {
  const fetcher = streamFetcher();
  let bytesWritten = 0;

  await withFetch(async (_url, init) => {
    if (rangeOf(init) === 'bytes=0-0') {
      return { ok: true, status: 200, headers: headersOf({}), body: bodyOf(new Uint8Array(0)) };
    }
    return { ok: true, status: 200, headers: headersOf({}), body: bodyOf(new Uint8Array(512)) };
  }, async () => {
    await fetcher.download(undefined, async (chunk) => { bytesWritten += chunk.length; });
  });

  assert.equal(bytesWritten, 512);
});
