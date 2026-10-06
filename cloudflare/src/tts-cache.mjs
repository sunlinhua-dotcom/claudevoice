// /tts 缓存的纯函数层：不碰 caches / fetch / env，Node 里能直接跑测试，也能被 esbuild 打进 Worker。
//
// 缓存分两层：
//   1) caches.default（边缘缓存，key = https://tts-cache.internal/<sha256>，原文不进 URL）
//   2) isolate 内存 LRU（MemoryAudioCache）——Cache API 在 workers.dev 域名上官方不保证可用，
//      且不跨数据中心；同一条播报被 Mac / 面板 / 盒子几乎同时请求时，这一层兜底，并做 singleflight 合并。

export const TTS_CACHE_VERSION = 1;
export const TTS_CACHE_HOST = 'https://tts-cache.internal/';
// 合成时写进 SSML 的韵律参数；worker.js 的 Edge SSML 也读这份常量，改一处两边同步，缓存 key 随之失效。
export const TTS_PROSODY = Object.freeze({ pitch: '+0Hz', rate: '+0%', volume: '+0%' });
export const TTS_CACHE_TTL_SEC = 86400;

// 所有会改变音频字节的输入都收在这里。text / voice(已解析成 Edge 音色名) / format + 韵律常量。
// 注意：请求体里的 style 目前不参与合成，所以不进 key；以后哪个字段开始影响音频，就加到这里。
export function ttsParams({ text, voice, format }) {
  return {
    v: TTS_CACHE_VERSION,
    text: String(text == null ? '' : text),
    voice: String(voice == null ? '' : voice),
    format: format === 'wav' ? 'wav' : 'mp3',
    pitch: TTS_PROSODY.pitch,
    rate: TTS_PROSODY.rate,
    volume: TTS_PROSODY.volume,
  };
}

// 规范化序列化：按 key 排序，新增字段自动并入哈希，不会漏。
export function canonicalParams(params) {
  return JSON.stringify(Object.keys(params).sort().map((k) => [k, params[k]]));
}

export async function ttsCacheHash(params) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(canonicalParams(params)));
  let out = '';
  for (const b of new Uint8Array(buf)) out += b.toString(16).padStart(2, '0');
  return out;
}

export function ttsCacheUrl(hash) { return TTS_CACHE_HOST + hash; }

export function ttsContentType(format) { return format === 'wav' ? 'audio/wav' : 'audio/mpeg'; }

// isolate 内存里的小 LRU。条数和总字节都封顶，单条超过总预算一半的不收。
export class MemoryAudioCache {
  constructor({ maxEntries = 32, maxBytes = 4 * 1024 * 1024, ttlMs = TTS_CACHE_TTL_SEC * 1000, now = Date.now } = {}) {
    this.maxEntries = maxEntries;
    this.maxBytes = maxBytes;
    this.ttlMs = ttlMs;
    this.now = now;
    this.map = new Map();        // hash -> { bytes, contentType, at }
    this.bytes = 0;
    this.inflight = new Map();   // hash -> Promise
  }

  get(hash) {
    const e = this.map.get(hash);
    if (!e) return null;
    if (this.now() - e.at > this.ttlMs) { this.#drop(hash); return null; }
    this.map.delete(hash); this.map.set(hash, e);   // 最近使用挪到末尾
    return e;
  }

  set(hash, bytes, contentType) {
    const size = bytes && bytes.byteLength;
    if (!size || size > this.maxBytes / 2) return false;
    if (this.map.has(hash)) this.#drop(hash);
    this.map.set(hash, { bytes, contentType, at: this.now() });
    this.bytes += size;
    while (this.map.size > this.maxEntries || this.bytes > this.maxBytes) {
      const oldest = this.map.keys().next().value;
      this.#drop(oldest);
    }
    return true;
  }

  #drop(hash) {
    const e = this.map.get(hash);
    if (e) { this.bytes -= e.bytes.byteLength; this.map.delete(hash); }
  }

  // singleflight：同一个 hash 同时来多个请求只合成一次；失败不缓存（inflight 在 finally 里清掉）。
  once(hash, fn) {
    const cur = this.inflight.get(hash);
    if (cur) return cur;
    const p = (async () => { try { return await fn(); } finally { this.inflight.delete(hash); } })();
    this.inflight.set(hash, p);
    return p;
  }
}
