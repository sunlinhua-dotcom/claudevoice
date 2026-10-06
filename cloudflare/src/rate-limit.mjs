// /unlock 防爆破：按客户端 IP 计数，窗口内错满 N 次就锁一段时间。纯逻辑，不碰 env / fetch，Node 里能直接测。
//
// 为什么不用 Durable Object：10/02 DO 免费时长用光，整条 /hook 跟着 1101；/unlock 若依赖 DO，
// DO 一挂连输对密码都进不去。这里的存储是「isolate 内存（同步、原子）+ caches.default（尽力而为的跨 isolate 持久）」，
// 不增加 DO 常驻时长，DO 挂了也不影响解锁。代价见 worker.js 里的说明。

export const UNLOCK_LIMIT = Object.freeze({ maxFails: 5, windowMs: 10 * 60 * 1000, lockMs: 10 * 60 * 1000 });

// IPv4 原样；IPv6 收到 /64（攻击者通常能在整段 /64 里换地址）；取不到 IP 归到 'unknown' 共用一个桶。
export function clientKey(ip) {
  const s = String(ip || '').trim().toLowerCase();
  if (!s) return 'unknown';
  const mapped = s.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) return mapped[1];
  if (!s.includes(':')) return s;
  const [headRaw, tailRaw] = s.split('::');
  const head = headRaw ? headRaw.split(':') : [];
  const tail = s.includes('::') && tailRaw ? tailRaw.split(':') : [];
  const groups = s.includes('::') ? [...head, ...Array(Math.max(0, 8 - head.length - tail.length)).fill('0'), ...tail] : head;
  return groups.slice(0, 4).map((g) => (g || '0').replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

// 记录形状：{ n: 窗口内失败次数, first: 窗口起点, lockedUntil: 锁定截止（0 = 没锁） }
function liveRec(rec, now, cfg) {
  if (!rec || typeof rec.n !== 'number') return null;
  if (rec.lockedUntil > now) return rec;                   // 还在锁
  if (rec.lockedUntil && rec.lockedUntil <= now) return null;   // 锁已到期 → 清零重来
  if (now - rec.first > cfg.windowMs) return null;          // 窗口过期
  return rec;
}

// 两份记录取更严的一份（isolate 内存 vs 缓存里读到的）。
export function stricter(a, b) {
  if (!a) return b || null;
  if (!b) return a;
  if ((b.lockedUntil || 0) !== (a.lockedUntil || 0)) return (b.lockedUntil || 0) > (a.lockedUntil || 0) ? b : a;
  return b.n > a.n ? b : a;
}

export class AttemptLimiter {
  constructor({ maxFails, windowMs, lockMs, store = null, maxEntries = 2000, now = Date.now } = UNLOCK_LIMIT) {
    this.cfg = { maxFails, windowMs, lockMs };
    this.store = store;            // { get(key) -> rec|null, set(key, rec|null, ttlSec) -> Promise } 可选
    this.mem = new Map();
    this.maxEntries = maxEntries;
    this.now = now;
  }

  // check 必须是同步函数（密码比较是同步的）：这样「查锁 → 比对 → 记失败」在一个 JS 时间片里完成，
  // 同一 isolate 里再多并发请求也不会超发猜测次数。唯一的 await 在最前面读缓存。
  async attempt(key, check) {
    let stored = null;
    if (this.store) { try { stored = await this.store.get(key); } catch (_) { stored = null; } }
    // ---- 同步区开始 ----
    const now = this.now();
    const { cfg } = this;
    const rec = liveRec(stricter(this.mem.get(key) || null, stored), now, cfg);
    if (rec && rec.lockedUntil > now) {
      this.mem.set(key, rec);
      return { result: 'locked', retryAfter: Math.ceil((rec.lockedUntil - now) / 1000), pending: null };
    }
    if (check()) {
      this.mem.delete(key);
      return { result: 'ok', retryAfter: 0, pending: this.#persist(key, null, 0) };
    }
    const next = rec
      ? { n: rec.n + 1, first: rec.first, lockedUntil: 0 }
      : { n: 1, first: now, lockedUntil: 0 };
    if (next.n >= cfg.maxFails) next.lockedUntil = now + cfg.lockMs;
    this.mem.set(key, next);
    this.#prune(now);
    const ttlSec = Math.max(1, Math.ceil((Math.max(next.lockedUntil, next.first + cfg.windowMs) - now) / 1000));
    const pending = this.#persist(key, next, ttlSec);
    // ---- 同步区结束 ----
    if (next.lockedUntil) return { result: 'locked', retryAfter: Math.ceil(cfg.lockMs / 1000), pending };
    return { result: 'bad', retryAfter: 0, pending };
  }

  #persist(key, rec, ttlSec) {
    if (!this.store) return null;
    try { return Promise.resolve(this.store.set(key, rec, ttlSec)).catch(() => {}); } catch (_) { return null; }
  }

  #prune(now) {
    if (this.mem.size <= this.maxEntries) return;
    for (const [k, r] of this.mem) if (!liveRec(r, now, this.cfg)) this.mem.delete(k);
    while (this.mem.size > this.maxEntries) this.mem.delete(this.mem.keys().next().value);   // 仍超限就按插入顺序丢最老的
  }
}

async function sha256Hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s));
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

// 把一个 Cache 对象（caches.default）包成 limiter 的 store。key 先哈希，IP 不进 URL。
// getCache 每次调用时求值：workers.dev 或本地环境没有 caches.default 时返回 null，store 就退化为空操作。
export function makeCacheStore(getCache, prefix) {
  return {
    async get(key) {
      const cache = getCache();
      if (!cache) return null;
      const hit = await cache.match(new Request(prefix + (await sha256Hex(key))));
      return hit ? await hit.json() : null;
    },
    async set(key, rec, ttlSec) {
      const cache = getCache();
      if (!cache) return;
      const req = new Request(prefix + (await sha256Hex(key)));
      if (!rec) { await cache.delete(req); return; }
      await cache.put(req, new Response(JSON.stringify(rec), {
        headers: { 'content-type': 'application/json', 'cache-control': `public, max-age=${ttlSec}` },
      }));
    },
  };
}
