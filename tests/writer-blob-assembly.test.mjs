import assert from 'node:assert/strict';
import test from 'node:test';
import { FileWriter } from '../offscreen/writer.js';

/**
 * Blob 降级模式的组装语义必须和文件句柄模式的定位写入一致：
 * write(data, offset) 是"写到这个位置"，不是"追加一段"。
 * 否则重试重发同一段数据时会拼出比真实文件更长的坏文件。
 */

async function readBlobUrl(url) {
  const response = await fetch(url);
  return new Uint8Array(await response.arrayBuffer());
}

test('顺序追加写入组装出的内容与写入顺序一致', async () => {
  const writer = new FileWriter(null, 'a.bin');
  await writer.open();
  await writer.write(Uint8Array.of(1, 2, 3), 0);
  await writer.write(Uint8Array.of(4, 5), 3);

  const result = await writer.close();
  assert.equal(result.method, 'blob');
  assert.deepEqual([...(await readBlobUrl(result.url))], [1, 2, 3, 4, 5]);
});

test('乱序到达的分块按 offset 归位，而不是按到达顺序拼接', async () => {
  const writer = new FileWriter(null, 'b.bin');
  await writer.open();
  await writer.write(Uint8Array.of(4, 5, 6), 3);
  await writer.write(Uint8Array.of(1, 2, 3), 0);

  const result = await writer.close();
  assert.deepEqual([...(await readBlobUrl(result.url))], [1, 2, 3, 4, 5, 6]);
});

test('重试重发同一段数据时后写覆盖先写，文件长度不翻倍', async () => {
  const writer = new FileWriter(null, 'c.bin');
  await writer.open();
  // 第一次尝试拿到被截断的 1 字节
  await writer.write(Uint8Array.of(0xff), 0);
  // 绕开缓存重取，拿到完整内容后从头重写
  await writer.write(Uint8Array.of(0xff, 0xd8, 0xff, 0xdb), 0);

  const result = await writer.close();
  const bytes = await readBlobUrl(result.url);
  assert.equal(bytes.length, 4, '重试重发的那一段不能被当成新内容追加');
  assert.deepEqual([...bytes], [0xff, 0xd8, 0xff, 0xdb]);
});

test('50MB 上限按文件末端位置判定，重复写入同一段不会误触发', async () => {
  const writer = new FileWriter(null, 'd.bin');
  writer._blobMaxSize = 1024;
  await writer.open();

  const block = new Uint8Array(600);
  await writer.write(block, 0);
  await writer.write(block, 0); // 同一位置重写，末端仍是 600
  await writer.close().then(async (result) => {
    assert.equal((await readBlobUrl(result.url)).length, 600);
  });
});

test('真正超过上限时仍然报错', async () => {
  const writer = new FileWriter(null, 'e.bin');
  writer._blobMaxSize = 1024;
  await writer.open();

  await writer.write(new Uint8Array(600), 0);
  await assert.rejects(() => writer.write(new Uint8Array(600), 600), /超过 .*MB 限制/);
});
