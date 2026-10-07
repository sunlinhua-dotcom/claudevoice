// /tts 缓存纯函数层：cache key、内存 LRU、singleflight。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ttsParams, canonicalParams, ttsCacheHash, ttsCacheUrl, ttsContentType,
  MemoryAudioCache, TTS_CACHE_HOST, TTS_PROSODY,
} from '../cloudflare/src/tts-cache.mjs';

const base = { text: '布莱特，任务完成了。', voice: 'zh-CN-XiaoxiaoNeural', format: 'mp3' };

test('同样参数哈希一致，且是 64 位十六进制', async () => {
  const a = await ttsCacheHash(ttsParams(base));
  const b = await ttsCacheHash(ttsParams({ ...base }));
  assert.equal(a, b);
  assert.match(a, /^[0-9a-f]{64}$/);
});

test('文本 / 音色 / 格式任一不同，哈希就不同', async () => {
  const h0 = await ttsCacheHash(ttsParams(base));
  assert.notEqual(h0, await ttsCacheHash(ttsParams({ ...base, text: base.text + '。' })));
  assert.notEqual(h0, await ttsCacheHash(ttsParams({ ...base, voice: 'zh-CN-YunxiNeural' })));
  assert.notEqual(h0, await ttsCacheHash(ttsParams({ ...base, format: 'wav' })));
});

test('format 只认 wav，其余都归 mp3（与 handleTts 的归一化一致）', async () => {
  assert.equal(await ttsCacheHash(ttsParams({ ...base, format: 'ogg' })), await ttsCacheHash(ttsParams({ ...base, format: 'mp3' })));
});

test('韵律参数进了 key：改任意一项哈希都会变', async () => {
  const p = ttsParams(base);
  const h0 = await ttsCacheHash(p);
  for (const k of ['pitch', 'rate', 'volume']) {
    assert.notEqual(h0, await ttsCacheHash({ ...p, [k]: '+10%' }), k);
  }
  assert.equal(p.rate, TTS_PROSODY.rate);
});

test('新增参数字段自动并入哈希（规范化序列化按 key 排序，与字段书写顺序无关）', async () => {
  const p = ttsParams(base);
  assert.notEqual(await ttsCacheHash(p), await ttsCacheHash({ ...p, speed: 1.2 }));
  const shuffled = Object.fromEntries(Object.entries(p).reverse());
  assert.equal(canonicalParams(p), canonicalParams(shuffled));
  assert.equal(await ttsCacheHash(p), await ttsCacheHash(shuffled));
});

test('cache key URL 不含原文，也不含音色名', async () => {
  const h = await ttsCacheHash(ttsParams(base));
  const url = ttsCacheUrl(h);
  assert.ok(url.startsWith(TTS_CACHE_HOST));
  assert.equal(url, 'https://tts-cache.internal/' + h);
  assert.ok(!url.includes(encodeURIComponent('任务')) && !url.includes('任务') && !url.includes('Xiaoxiao'));
});

test('content-type', () => {
  assert.equal(ttsContentType('wav'), 'audio/wav');
  assert.equal(ttsContentType('mp3'), 'audio/mpeg');
  assert.equal(ttsContentType(undefined), 'audio/mpeg');
});

const bytes = (n, v = 1) => new Uint8Array(n).fill(v);

test('内存缓存：存取、LRU 淘汰、字节封顶', () => {
  const c = new MemoryAudioCache({ maxEntries: 3, maxBytes: 100 });
  assert.equal(c.get('a'), null);
  assert.ok(c.set('a', bytes(20), 'audio/mpeg'));
  assert.ok(c.set('b', bytes(20), 'audio/mpeg'));
  assert.ok(c.set('c', bytes(20), 'audio/mpeg'));
  assert.ok(c.get('a'));                       // a 变成最近使用
  assert.ok(c.set('d', bytes(20), 'audio/mpeg'));   // 超条数 → 淘汰最久没用的 b
  assert.equal(c.get('b'), null);
  assert.ok(c.get('a') && c.get('c') && c.get('d'));
  assert.ok(c.set('e', bytes(45), 'audio/mpeg'));   // 45 ≤ 100/2 可收；总字节超 100 → 继续淘汰
  assert.ok(c.bytes <= 100);
});

test('内存缓存：空音频和超大单条不收', () => {
  const c = new MemoryAudioCache({ maxBytes: 100 });
  assert.equal(c.set('x', new Uint8Array(0), 'audio/mpeg'), false);
  assert.equal(c.set('x', null, 'audio/mpeg'), false);
  assert.equal(c.set('big', bytes(51), 'audio/mpeg'), false);
  assert.equal(c.get('x'), null);
  assert.equal(c.bytes, 0);
});

test('内存缓存：重复 set 同一个 key 不重复计字节', () => {
  const c = new MemoryAudioCache({ maxBytes: 1000 });
  c.set('a', bytes(30), 'audio/mpeg');
  c.set('a', bytes(40), 'audio/mpeg');
  assert.equal(c.bytes, 40);
  assert.equal(c.map.size, 1);
});

test('内存缓存：过期条目读不到', () => {
  let t = 1000;
  const c = new MemoryAudioCache({ ttlMs: 500, now: () => t });
  c.set('a', bytes(10), 'audio/mpeg');
  t = 1400; assert.ok(c.get('a'));
  t = 1600; assert.equal(c.get('a'), null);
  assert.equal(c.bytes, 0);
});

test('singleflight：并发同 key 只合成一次，成功后 inflight 清空', async () => {
  const c = new MemoryAudioCache();
  let calls = 0;
  const fn = async () => { calls++; await new Promise((r) => setTimeout(r, 20)); return bytes(5); };
  const [a, b, d] = await Promise.all([c.once('k', fn), c.once('k', fn), c.once('k', fn)]);
  assert.equal(calls, 1);
  assert.equal(a, b); assert.equal(b, d);
  assert.equal(c.inflight.size, 0);
});

test('singleflight：失败不缓存，下一次重新合成', async () => {
  const c = new MemoryAudioCache();
  let calls = 0;
  await assert.rejects(c.once('k', async () => { calls++; throw new Error('boom'); }), /boom/);
  assert.equal(c.inflight.size, 0);
  assert.equal(c.get('k'), null);
  const out = await c.once('k', async () => { calls++; return bytes(3); });
  assert.equal(calls, 2);
  assert.equal(out.byteLength, 3);
});
