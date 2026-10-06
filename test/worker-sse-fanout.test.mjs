// Hub 的 SSE 扇出：不被卡死的客户端拖住；断开的客户端摘除后，闹钟不再续。
import test from 'node:test';
import assert from 'node:assert/strict';
import { fanoutWrite, writerHealth, SSE_MAX_BACKLOG } from '../cloudflare/src/sse-fanout.mjs';

const enc = new TextEncoder();
const mkClient = () => {
  const ts = new TransformStream();
  return { writer: ts.writable.getWriter(), reader: ts.readable.getReader(), ts };
};

test('健康客户端：写入后能读到，数量原样返回', async () => {
  const c = mkClient();
  const writers = new Map([['a', c.writer]]);
  assert.equal(fanoutWrite(writers, () => enc.encode('data: 1\n\n')), 1);
  const { value } = await c.reader.read();
  assert.equal(new TextDecoder().decode(value), 'data: 1\n\n');
});

test('卡死的客户端（不读）不阻塞：fanoutWrite 同步返回，积压超限后被摘掉，其余客户端照常收', async () => {
  const stuck = mkClient();
  const live = mkClient();
  const writers = new Map([['stuck', stuck.writer], ['live', live.writer]]);
  const drops = [];
  const received = [];
  (async () => {
    try { for (;;) { const { value, done } = await live.reader.read(); if (done) break; received.push(new TextDecoder().decode(value)); } }
    catch (_) {}
  })();

  const t0 = Date.now();
  for (let i = 0; i < SSE_MAX_BACKLOG + 4; i++) {
    fanoutWrite(writers, () => enc.encode(`data: ${i}\n\n`), { onDrop: (id, why) => drops.push([id, why]) });
    await new Promise((r) => setTimeout(r, 1));   // 广播之间让出时间片（真实环境里每次广播是独立请求），健康客户端借此读走数据
  }
  assert.ok(Date.now() - t0 < 500, '扇出不应被卡死的客户端阻塞');
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(writers.has('stuck'), false, '卡死的 writer 应已被摘除');
  assert.deepEqual(drops, [['stuck', 'stalled']]);
  assert.equal(writers.has('live'), true);
  assert.equal(received.length, SSE_MAX_BACKLOG + 4);
  assert.equal(received[0], 'data: 0\n\n');
});

test('客户端断开（readable 被 cancel）后：writer 被摘除，没有活 writer 时返回 0 → 闹钟不再续', async () => {
  const c = mkClient();
  const writers = new Map([['a', c.writer]]);
  await c.reader.cancel('client gone');
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(writerHealth(c.writer), 'dead');
  const left = fanoutWrite(writers, () => enc.encode(': ka\n\n'));
  assert.equal(left, 0);
  assert.equal(writers.size, 0);
});

test('空 Map：返回 0（没有 writer 就不续闹钟）', () => {
  assert.equal(fanoutWrite(new Map(), () => enc.encode('x')), 0);
});

test('每个 writer 拿到独立的 chunk（makeChunk 每路调用一次）', async () => {
  const a = mkClient(), b = mkClient();
  const writers = new Map([['a', a.writer], ['b', b.writer]]);
  let calls = 0;
  fanoutWrite(writers, () => { calls++; return enc.encode('hi'); });
  assert.equal(calls, 2);
  const [ra, rb] = await Promise.all([a.reader.read(), b.reader.read()]);
  assert.notEqual(ra.value.buffer, rb.value.buffer);
});

test('writerHealth：desiredSize 抛错 / 为 null 判 dead，缺失则按 ok', () => {
  assert.equal(writerHealth({ get desiredSize() { throw new Error('x'); } }), 'dead');
  assert.equal(writerHealth({ desiredSize: null }), 'dead');
  assert.equal(writerHealth({ desiredSize: -SSE_MAX_BACKLOG }), 'stalled');
  assert.equal(writerHealth({ desiredSize: 1 }), 'ok');
  assert.equal(writerHealth({}), 'ok');
});
