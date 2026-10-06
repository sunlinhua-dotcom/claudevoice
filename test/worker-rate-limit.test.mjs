// /unlock 限流：clientKey、窗口 / 锁定判定、并发原子性、缓存 store 适配。
import test from 'node:test';
import assert from 'node:assert/strict';
import { AttemptLimiter, UNLOCK_LIMIT, clientKey, makeCacheStore, stricter } from '../cloudflare/src/rate-limit.mjs';

const MIN = 60 * 1000;
function mk(extra = {}) {
  const clock = { t: 1_000_000 };
  const lim = new AttemptLimiter({ ...UNLOCK_LIMIT, now: () => clock.t, ...extra });
  return { lim, clock };
}
const bad = () => false;
const good = () => true;

test('配置是 10 分钟内错 5 次锁 10 分钟', () => {
  assert.deepEqual({ ...UNLOCK_LIMIT }, { maxFails: 5, windowMs: 10 * MIN, lockMs: 10 * MIN });
});

test('错 4 次仍然放行，第 5 次错误触发 429 锁定', async () => {
  const { lim } = mk();
  for (let i = 0; i < 4; i++) assert.equal((await lim.attempt('1.1.1.1', bad)).result, 'bad');
  const fifth = await lim.attempt('1.1.1.1', bad);
  assert.equal(fifth.result, 'locked');
  assert.equal(fifth.retryAfter, 600);
});

test('锁定期间连输对密码也拒绝，且 retryAfter 递减', async () => {
  const { lim, clock } = mk();
  for (let i = 0; i < 5; i++) await lim.attempt('ip', bad);
  clock.t += 3 * MIN;
  const r = await lim.attempt('ip', good);
  assert.equal(r.result, 'locked');
  assert.equal(r.retryAfter, 7 * 60);
});

test('锁定到期后恢复，输对即成功', async () => {
  const { lim, clock } = mk();
  for (let i = 0; i < 5; i++) await lim.attempt('ip', bad);
  clock.t += 10 * MIN + 1;
  assert.equal((await lim.attempt('ip', good)).result, 'ok');
});

test('成功路径：输对密码返回 ok，并清掉之前的失败计数', async () => {
  const { lim } = mk();
  for (let i = 0; i < 4; i++) await lim.attempt('ip', bad);
  assert.equal((await lim.attempt('ip', good)).result, 'ok');
  for (let i = 0; i < 4; i++) assert.equal((await lim.attempt('ip', bad)).result, 'bad');   // 重新数，不是接着锁
});

test('窗口过期：10 分钟前的失败不累计', async () => {
  const { lim, clock } = mk();
  for (let i = 0; i < 4; i++) await lim.attempt('ip', bad);
  clock.t += 10 * MIN + 1;
  for (let i = 0; i < 4; i++) assert.equal((await lim.attempt('ip', bad)).result, 'bad');
});

test('不同 IP 互不影响', async () => {
  const { lim } = mk();
  for (let i = 0; i < 5; i++) await lim.attempt('a', bad);
  assert.equal((await lim.attempt('a', good)).result, 'locked');
  assert.equal((await lim.attempt('b', good)).result, 'ok');
});

test('并发爆破不超发：同一时刻 50 个错误猜测，只有 5 个被真正比对', async () => {
  const { lim } = mk();
  let compared = 0;
  const check = () => { compared++; return false; };
  const out = await Promise.all(Array.from({ length: 50 }, () => lim.attempt('ip', check)));
  assert.equal(compared, 5);
  assert.equal(out.filter((r) => r.result === 'locked').length, 46);   // 第 5 个触发锁 + 之后 45 个
  assert.equal(out.filter((r) => r.result === 'bad').length, 4);
});

test('并发里混着一个对的密码：锁之前到的能成功', async () => {
  const { lim } = mk();
  const out = await Promise.all([bad, bad, good, bad].map((c) => lim.attempt('ip', c)));
  assert.deepEqual(out.map((r) => r.result), ['bad', 'bad', 'ok', 'bad']);
});

test('clientKey：IPv4 原样、IPv6 收 /64、映射地址还原、空值归 unknown', () => {
  assert.equal(clientKey('203.0.113.7'), '203.0.113.7');
  assert.equal(clientKey(' 203.0.113.7 '), '203.0.113.7');
  assert.equal(clientKey(''), 'unknown');
  assert.equal(clientKey(null), 'unknown');
  assert.equal(clientKey('::ffff:203.0.113.7'), '203.0.113.7');
  const a = clientKey('2001:db8:1:2:aaaa:bbbb:cccc:dddd');
  const b = clientKey('2001:DB8:1:2::1');
  assert.equal(a, b);
  assert.equal(a, '2001:db8:1:2::/64');
  assert.notEqual(a, clientKey('2001:db8:1:3::1'));
  assert.equal(clientKey('::1'), '0:0:0:0::/64');
});

test('IPv6 同一 /64 内换地址也算同一个桶', async () => {
  const { lim } = mk();
  for (let i = 0; i < 5; i++) await lim.attempt(clientKey(`2001:db8:9:9:${i}::1`), bad);
  assert.equal((await lim.attempt(clientKey('2001:db8:9:9:ffff::2'), good)).result, 'locked');
});

test('stricter：锁定优先，其次失败次数多的', () => {
  const unlocked = { n: 4, first: 1, lockedUntil: 0 };
  const locked = { n: 5, first: 1, lockedUntil: 99 };
  assert.equal(stricter(unlocked, locked), locked);
  assert.equal(stricter(locked, unlocked), locked);
  assert.equal(stricter({ n: 2, first: 1, lockedUntil: 0 }, { n: 3, first: 1, lockedUntil: 0 }).n, 3);
  assert.equal(stricter(null, unlocked), unlocked);
  assert.equal(stricter(unlocked, null), unlocked);
});

// ---- 缓存 store ----
function fakeCache() {
  const m = new Map();
  return {
    m,
    async match(req) { const r = m.get(req.url); return r ? r.clone() : undefined; },
    async put(req, res) { m.set(req.url, res); },
    async delete(req) { return m.delete(req.url); },
  };
}

test('缓存 store：IP 不进 URL，失败写入、成功删除', async () => {
  const cache = fakeCache();
  const store = makeCacheStore(() => cache, 'https://unlock-rl.internal/');
  const { lim } = mk({ store });
  const r = await lim.attempt('198.51.100.9', bad);
  await r.pending;
  const urls = [...cache.m.keys()];
  assert.equal(urls.length, 1);
  assert.match(urls[0], /^https:\/\/unlock-rl\.internal\/[0-9a-f]{64}$/);
  assert.ok(!urls[0].includes('198.51.100.9'));
  const cc = cache.m.get(urls[0]).headers.get('cache-control');
  assert.match(cc, /max-age=\d+/);
  const ok = await lim.attempt('198.51.100.9', good);
  await ok.pending;
  assert.equal(cache.m.size, 0);
});

test('缓存 store：新 isolate（内存为空）能从缓存读到别的 isolate 记下的锁', async () => {
  const cache = fakeCache();
  const store = makeCacheStore(() => cache, 'https://unlock-rl.internal/');
  const clock = { t: 5_000_000 };
  const a = new AttemptLimiter({ ...UNLOCK_LIMIT, store, now: () => clock.t });
  let last;
  for (let i = 0; i < 5; i++) last = await a.attempt('ip', bad);
  await last.pending;
  const b = new AttemptLimiter({ ...UNLOCK_LIMIT, store, now: () => clock.t });   // 另一个 isolate：内存是空的
  assert.equal((await b.attempt('ip', good)).result, 'locked');
});

test('缓存不可用（caches.default 为 null）时退化为纯内存，照样限流', async () => {
  const store = makeCacheStore(() => null, 'https://unlock-rl.internal/');
  const { lim } = mk({ store });
  for (let i = 0; i < 4; i++) await lim.attempt('ip', bad);
  assert.equal((await lim.attempt('ip', bad)).result, 'locked');
});

test('store 抛错不影响判定（读写都吞掉）', async () => {
  const store = { get: async () => { throw new Error('cache down'); }, set: () => { throw new Error('cache down'); } };
  const { lim } = mk({ store });
  for (let i = 0; i < 4; i++) assert.equal((await lim.attempt('ip', bad)).result, 'bad');
  assert.equal((await lim.attempt('ip', bad)).result, 'locked');
  const { lim: l2 } = mk({ store });
  assert.equal((await l2.attempt('other', good)).result, 'ok');
});

test('内存条目封顶：过期的先清，仍超限按插入顺序丢最老', async () => {
  const { lim, clock } = mk({ maxEntries: 3 });
  for (const k of ['a', 'b', 'c']) await lim.attempt(k, bad);
  clock.t += 11 * MIN;                       // 前三条都过期了
  await lim.attempt('d', bad); await lim.attempt('e', bad);
  assert.ok(lim.mem.size <= 3);
  assert.ok(lim.mem.has('e'));
});
