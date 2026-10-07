import { deliveryPlan, normalizeBridgePayload } from './event-utils.mjs';
import { ttsParams, ttsCacheHash, ttsCacheUrl, ttsContentType, MemoryAudioCache, TTS_PROSODY, TTS_CACHE_TTL_SEC } from './tts-cache.mjs';
import { AttemptLimiter, UNLOCK_LIMIT, clientKey, makeCacheStore } from './rate-limit.mjs';
import { fanoutWrite } from './sse-fanout.mjs';
// 播报话术层（音色分配 / 名字读法 / 句子模板 / 摘要清洗）与根目录 server.js、hook.js 共用同一份。
// 只放纯函数，没有 I/O，所以能被 esbuild 直接打进 Worker。默认导入 —— 本地 .cjs 的具名导入在
// esbuild 的 CJS→ESM 互操作下不可靠，拿到的只保证是 module.exports 这个对象。
import speech from '../../shared/speech.cjs';
const {
  VOICE_POOL, VOICE_GENDER, humanizeName, sayTool, spaceCJK,
  pick, hashStr, assignVoice, isMostlyChinese,
  cleanForSpeech, pickSummary, buildStyle, extractTool, baseName, clip,
} = speech;

/**
 * ClaudeVoice — Cloudflare Worker（边缘常驻中转站）
 *
 *  Mac: hook.js ──POST /hook──► 本 Worker
 *  Worker: 规整事件 → Durable Object(Hub) 用 SSE 推给网页
 *          + Web Push 推手机 + Telegram 消息；并代理 Edge/Azure TTS
 *  静态面板从 assets(../public) 提供。
 *
 *  Secrets（wrangler secret put）：
 *    HOOK_SECRET, DASH_TOKEN,
 *    AZURE_SPEECH_KEY, AZURE_SPEECH_REGION,
 *    VAPID_PUBLIC, VAPID_PRIVATE(JWK json), VAPID_SUBJECT,
 *    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *  Vars（wrangler.toml [vars]）：TTS_ENGINE, TTS_VOICE, USER_NAME
 */


// 用户只认这两个称呼：主名 USER_NAME（布莱特）+ 别名 USER_ALIASES（老孙），每次随机抽一个。
// 2026-08-25 用户明确要求：不要再加"老板/老大"之类的尊称后缀（与 server.js 同步）。
function userAddresses(env, U) {
  const aliases = String(env.USER_ALIASES || '').split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  return [U, ...aliases];
}

// 内置「中文名 + TTS 读音」种子表，与 hook.js 共用仓库根目录的 names.json。
// name=屏幕显示；say=语音实际念的文本（只要读音对，用汉字当注音即可）。
import NAME_TABLE from '../../names.json';
const DEFAULT_PROJECTS = (() => {
  const m = {};
  for (const k of Object.keys(NAME_TABLE)) if (k[0] !== '_') m[k.toLowerCase()] = NAME_TABLE[k];
  return m;
})();


// 热改读音表：存在 Hub DO 里，改完立刻生效、不用重新部署。isolate 内缓存 30 秒。
let NAMES_CACHE = { at: 0, map: null };
async function overrideNames(env) {
  const now = Date.now();
  if (NAMES_CACHE.map && now - NAMES_CACHE.at < 30000) return NAMES_CACHE.map;
  try {
    const r = await hub(env).fetch('https://do/names');
    NAMES_CACHE = { at: now, map: (await r.json()) || {} };
  } catch (_) { NAMES_CACHE = { at: now, map: NAMES_CACHE.map || {} }; }
  return NAMES_CACHE.map;
}

// 解析项目：热改覆盖 > 内置种子 > 增强兜底拆词
async function resolveProject(projectKey, env) {
  const lk = String(projectKey || '').toLowerCase();
  let ov = {};
  try { ov = await overrideNames(env); } catch (_) {}
  const o = { ...(DEFAULT_PROJECTS[lk] || {}), ...(ov[lk] || {}) };   // 只改 say 时不冲掉种子的显示名
  return {
    display: o.name || humanizeName(projectKey),
    say: spaceCJK(o.say || o.name || humanizeName(projectKey)),
    color: o.color || null,
    voice: o.voice || null,
    known: !!(ov[lk] || DEFAULT_PROJECTS[lk]),   // false = 读音是猜的，要找用户确认
  };
}

// caches.default：自定义域名 / 本地 wrangler dev 可用；workers.dev 上官方不保证，拿不到就返回 null，调用方走内存兜底。
function edgeCache() {
  try { return typeof caches !== 'undefined' && caches.default ? caches.default : null; } catch (_) { return null; }
}

// /unlock 限流器：isolate 内存（原子）+ caches.default（尽力跨 isolate）。不碰 DO。
const unlockLimiter = new AttemptLimiter({ ...UNLOCK_LIMIT, store: makeCacheStore(edgeCache, 'https://unlock-rl.internal/') });

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    const p = url.pathname;
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, X-CV-Secret, X-CV-Token',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    };
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });

    if (p === '/health') return jsonResp({ ok: true }, 200, cors);

    // 用密码换 token：输对密码就种一个长期 cookie，之后免输（解决"加到主屏幕后没处输 token"的死循环）
    // 防爆破：按 CF-Connecting-IP 计数，10 分钟内错 5 次锁 10 分钟（429）。限流不走 DO，见 src/rate-limit.mjs 顶部说明。
    if (p === '/unlock' && req.method === 'POST') {
      let pw = '';
      try { const b = await req.json(); pw = ((b && b.pw) || '').toString().trim(); } catch (_) {}
      const expected = (env.UNLOCK_PASSWORD || '').toString();
      // 未配置 UNLOCK_PASSWORD 时不放行（无内置默认密码）。
      const r = await unlockLimiter.attempt(clientKey(req.headers.get('cf-connecting-ip')), () => !!(env.DASH_TOKEN && expected && pw && pw === expected));
      if (r.pending) ctx.waitUntil(r.pending);
      if (r.result === 'ok') {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...cors, 'content-type': 'application/json', 'set-cookie': `cv_token=${env.DASH_TOKEN}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax` } });
      }
      if (r.result === 'locked') {
        return new Response(JSON.stringify({ ok: false, locked: true, retryAfter: r.retryAfter }), { status: 429, headers: { ...cors, 'content-type': 'application/json', 'retry-after': String(r.retryAfter) } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { ...cors, 'content-type': 'application/json' } });
    }

    if (p === '/hook' && req.method === 'POST') {
      if (env.HOOK_SECRET && req.headers.get('x-cv-secret') !== env.HOOK_SECRET)
        return jsonResp({ error: 'bad secret' }, 401, cors);
      let payload = {};
      try { payload = await req.json(); } catch (_) {}
      const ev = await normalizeEvent(payload, env);
      if (ev) {
        // 小智盒子 / 圆屏直接从 Worker 发，不经 DO：10/02 DO 免费时长用光（眼镜网关常挂事件流），
        // 整条 /hook 跟着 1101，盒子、圆屏、Mac 发声全哑了一夜。DO 挂了这里照样发，Mac 照样拿到事件念。
        if (!ev.silent && !ev.noNotify) ctx.waitUntil(sendXiaozhi(env, ev));
        try { await hub(env).fetch('https://do/broadcast', { method: 'POST', body: JSON.stringify(ev) }); }
        catch (e) { console.log('hub broadcast failed', String(e)); }
      }
      return jsonResp({ ok: true, event: ev || null }, 200, cors); // 返回事件，供 Mac 端 afplay 发声
    }

    // 以下面向浏览器：若设了 DASH_TOKEN 需校验（query / 头 / 或 unlock 种下的 cookie）
    const cookieTok = (() => { const c = req.headers.get('cookie') || ''; const m = c.match(/(?:^|;\s*)cv_token=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; })();
    const tokOK = !env.DASH_TOKEN || url.searchParams.get('token') === env.DASH_TOKEN || req.headers.get('x-cv-token') === env.DASH_TOKEN || cookieTok === env.DASH_TOKEN;

    // 服务端订阅（Rokid 眼镜网关等）拿 hook secret 也能读事件流，不用面板口令
    const hookSecOK = !!env.HOOK_SECRET && req.headers.get('x-cv-secret') === env.HOOK_SECRET;
    if (p === '/events') {
      if (!tokOK && !hookSecOK) return jsonResp({ error: 'token required' }, 401, cors);
      // 优先 WebSocket（可休眠，挂着不计 DO 时长）；SSE 只留给老客户端，连着就一直占着 DO
      if ((req.headers.get('upgrade') || '').toLowerCase() === 'websocket') return hub(env).fetch(new Request('https://do/ws', req));
      return hub(env).fetch('https://do/sse');
    }
    if (p === '/subscribe' && req.method === 'POST') {
      if (!tokOK) return jsonResp({ error: 'token required' }, 401, cors);
      const body = await req.text();
      return hub(env).fetch('https://do/subscribe', { method: 'POST', body });
    }
    if (p === '/latest') {
      if (!tokOK && !hookSecOK) return jsonResp({ error: 'token required' }, 401, cors);
      return hub(env).fetch('https://do/latest');
    }
    // 待确认读音：读音表里没有、只能靠兜底猜的项目，攒在这里等用户拍板。
    if (p === '/pending') {
      const secOK = env.HOOK_SECRET && req.headers.get('x-cv-secret') === env.HOOK_SECRET;
      if (!tokOK && !secOK) return jsonResp({ error: 'token required' }, 401, cors);
      if (req.method === 'POST') {
        const r = await hub(env).fetch('https://do/pending', { method: 'POST', body: await req.text() });
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
      }
      return hub(env).fetch('https://do/pending');
    }

    // 项目读音表热改：GET 看当前覆盖，POST 合并写入（say 为空串表示删掉这条覆盖）。
    if (p === '/names') {
      const secOK = env.HOOK_SECRET && req.headers.get('x-cv-secret') === env.HOOK_SECRET;
      if (!tokOK && !secOK) return jsonResp({ error: 'token required' }, 401, cors);
      if (req.method === 'GET') {
        const ov = await hub(env).fetch('https://do/names').then((r) => r.json()).catch(() => ({}));
        const merged = {};
        for (const k of Object.keys(DEFAULT_PROJECTS)) merged[k] = { ...DEFAULT_PROJECTS[k], _src: 'seed' };
        for (const k of Object.keys(ov)) merged[k] = { ...(DEFAULT_PROJECTS[k] || {}), ...ov[k], _src: 'override' };
        return jsonResp({ ok: true, count: Object.keys(merged).length, overrides: ov, names: merged }, 200, cors);
      }
      if (req.method === 'POST') {
        const body = await req.text();
        const r = await hub(env).fetch('https://do/names', { method: 'POST', body });
        NAMES_CACHE = { at: 0, map: null };   // 本 isolate 立刻失效
        return new Response(await r.text(), { status: r.status, headers: { ...cors, 'content-type': 'application/json' } });
      }
      return jsonResp({ error: 'method' }, 405, cors);
    }
    if (p === '/tts' && req.method === 'POST') {
      const secOK = env.HOOK_SECRET && req.headers.get('x-cv-secret') === env.HOOK_SECRET;
      if (!tokOK && !secOK) return jsonResp({ error: 'token required' }, 401, cors);
      return handleTts(req, env, cors, ctx);
    }
    if (p === '/config') {
      return jsonResp({
        voicePool: VOICE_POOL,
        defaultVoice: env.TTS_VOICE || '茉莉',
        model: 'edge-neural',
        userName: env.USER_NAME || 'Dev',
        requiresToken: !!env.DASH_TOKEN,
        vapidPublic: env.VAPID_PUBLIC || '',
        ws: true,   // 面板据此走 WebSocket；本机 server.js 没这项，面板照旧走 SSE
      }, 200, { ...cors, 'cache-control': 'no-store' });
    }

    // 静态资源（面板 / sw.js / manifest / icon）
    if (env.DASH_TOKEN && (p === '/' || p === '/index.html') && !tokOK) {
      const o = new URL(req.url).origin;
      const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">`
        + `<title>ClaudeVoice 语音信号台</title>`
        + `<link rel="apple-touch-icon" href="${o}/assets/apple-touch-icon.png"><link rel="icon" type="image/png" href="${o}/assets/icon-192.png">`
        + `<meta name="apple-mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="default">`
        + `<meta property="og:type" content="website"><meta property="og:title" content="ClaudeVoice 语音信号台">`
        + `<meta property="og:description" content="Claude Code 全局语音通知台：任务完成或需要你确认时，自动语音播报 + 飞书卡片 + 手机推送。">`
        + `<meta property="og:image" content="${o}/assets/icon-512.png"><meta property="og:url" content="${o}/"><meta name="twitter:card" content="summary"><meta name="twitter:image" content="${o}/assets/icon-512.png">`
        + `<style>*{box-sizing:border-box}html,body{margin:0}body{min-height:100vh;min-height:100dvh;display:grid;place-items:center;padding:24px;background:linear-gradient(180deg,#eef1f8,#e6eaf6);color:#1b2233;font-family:"PingFang SC",system-ui,-apple-system,sans-serif;text-align:center;word-break:keep-all;text-wrap:balance}`
        + `.card{width:100%;max-width:340px}img{width:88px;height:88px;border-radius:22px;box-shadow:0 12px 40px -12px rgba(40,50,90,.45)}h1{font-size:20px;margin:16px 0 4px;font-weight:700}.sub{color:#5b6479;font-size:14px;margin:0 0 22px}`
        + `form{display:flex;flex-direction:column;gap:12px}input{width:100%;height:52px;border:1px solid #c9d0e3;border-radius:14px;background:#fff;font-size:18px;text-align:center;letter-spacing:2px;color:#1b2233;outline:none;-webkit-appearance:none}input:focus{border-color:#7c83ff;box-shadow:0 0 0 4px #7c83ff22}`
        + `button{height:52px;border:0;border-radius:14px;background:#5b63f0;color:#fff;font-size:17px;font-weight:600;cursor:pointer;-webkit-appearance:none}button:active{transform:translateY(1px)}.err{color:#e0456b;font-size:13px;min-height:18px;margin:10px 0 0}</style></head>`
        + `<body><div class="card"><img src="${o}/assets/icon-512.png" alt="ClaudeVoice"><h1>ClaudeVoice 语音信号台</h1><p class="sub">输入密码进入</p>`
        + `<form id="f"><input id="pw" type="password" inputmode="numeric" autocomplete="current-password" placeholder="密码"><button type="submit">进 入</button></form>`
        + `<p id="err" class="err"></p></div>`
        + `<script>var f=document.getElementById('f'),pw=document.getElementById('pw'),err=document.getElementById('err');`
        + `f.onsubmit=function(e){e.preventDefault();err.textContent='';var v=(pw.value||'').trim();if(!v)return;`
        + `fetch('/unlock',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({pw:v})})`
        + `.then(function(r){return r.json().catch(function(){return{ok:false};});})`
        + `.then(function(j){if(j&&j.ok){location.replace('/');}else{err.textContent=(j&&j.locked)?('尝试次数过多，请 '+Math.max(1,Math.ceil((j.retryAfter||600)/60))+' 分钟后再试'):'密码不对，再试一次';pw.value='';pw.focus();}})`
        + `.catch(function(){err.textContent='网络出错，重试一次';});};pw.focus();</script></body></html>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
};

const XIAOZHI_KINDS = new Set(['done', 'waiting', 'permission', 'failed']);

// 小智盒子（ESP32 自建服务器排队，盒子待机时自己醒来念）：只念完成 / 等你确认 / 失败。
// 地址和口令都是 secret：XIAOZHI_ANNOUNCE_URL、XIAOZHI_ANNOUNCE_TOKEN；没配就不发。
async function sendXiaozhi(env, ev) {
  const url = env.XIAOZHI_ANNOUNCE_URL, tok = env.XIAOZHI_ANNOUNCE_TOKEN;
  if (!url || !tok || !ev.speak || !XIAOZHI_KINDS.has(ev.kind)) return;
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}` },
      body: JSON.stringify({ text: ev.speak, kind: ev.kind, project: ev.project || '', session: ev.sessionId || '' }),   // 会话号：工牌上按条语音回复
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.log('xiaozhi announce', r.status);
  } catch (e) { console.log('xiaozhi announce failed', String(e)); }
}

function hub(env) {
  return env.HUB.get(env.HUB.idFromName('global'));
}

// ============================ Durable Object: Hub ============================
export class Hub {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.writers = new Map();      // id -> WritableStreamDefaultWriter
    this.recent = [];
    this.subs = [];
    this.enc = new TextEncoder();
    state.blockConcurrencyWhile(async () => {
      this.recent = (await state.storage.get('recent')) || [];
      this.subs = (await state.storage.get('subs')) || [];
    });
    // 客户端每 30 秒发 'ping' 保活，由运行时直接回 'pong'，不叫醒休眠中的 DO
    state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/ws') return this.handleWS(req);
    if (p === '/sse') return this.handleSSE();
    if (p === '/broadcast') { const ev = await req.json(); await this.broadcast(ev); return Response.json({ ok: true }); }
    if (p === '/subscribe') { const sub = await req.json(); await this.addSub(sub); return Response.json({ ok: true }); }
    if (p === '/pending') {
      const pend = (await this.state.storage.get('pending')) || {};
      if (req.method !== 'POST') return Response.json(pend);
      let body = {};
      try { body = (await req.json()) || {}; } catch (_) {}
      if (body.clear === '*') { await this.state.storage.put('pending', {}); return Response.json({ ok: true, cleared: Object.keys(pend).length }); }
      if (body.clear) { delete pend[String(body.clear).toLowerCase()]; await this.state.storage.put('pending', pend); return Response.json({ ok: true }); }
      return Response.json({ ok: false, error: 'nothing to do' });
    }
    if (p === '/names') {
      const cur = (await this.state.storage.get('names')) || {};
      if (req.method !== 'POST') return Response.json(cur);
      let patch = {};
      try { patch = (await req.json()) || {}; } catch (_) {}
      let changed = 0;
      for (const k of Object.keys(patch)) {
        const lk = k.toLowerCase();
        const v = patch[k];
        if (v === null || v === '' || (v && !v.name && !v.say && !v.color && !v.voice)) { delete cur[lk]; changed++; continue; }
        const rec = typeof v === 'string' ? { say: v } : v;
        cur[lk] = { ...(cur[lk] || {}), ...rec };
        changed++;
      }
      await this.state.storage.put('names', cur);
      // 定了名就不用再问了
      const pend = (await this.state.storage.get('pending')) || {};
      let dropped = 0;
      for (const k of Object.keys(patch)) if (pend[k.toLowerCase()]) { delete pend[k.toLowerCase()]; dropped++; }
      if (dropped) await this.state.storage.put('pending', pend);
      return Response.json({ ok: true, changed, count: Object.keys(cur).length });
    }
    if (p === '/latest') {
      const e = this.recent[this.recent.length - 1] || null;
      const min = e ? { project: e.project, kind: e.kind, title: e.title } : null; // 仅最小信息
      return Response.json({ event: min });
    }
    return new Response('not found', { status: 404 });
  }

  // 可休眠 WebSocket：连着的面板不占 DO 时长，只有广播和新连接进来时才醒
  handleWS(req) {
    if ((req.headers.get('upgrade') || '').toLowerCase() !== 'websocket') return new Response('expected websocket', { status: 426 });
    const [client, server] = Object.values(new WebSocketPair());
    this.state.acceptWebSocket(server);
    server.send(JSON.stringify({ type: 'history', events: this.recent.slice(-20) }));
    return new Response(null, { status: 101, webSocket: client });
  }
  webSocketMessage(ws, msg) {}   // 客户端不发别的；'ping' 已由自动应答处理
  webSocketClose(ws, code, reason) { try { ws.close(code, reason); } catch (_) {} }
  webSocketError(ws) { try { ws.close(1011, 'error'); } catch (_) {} }

  handleSSE() {
    const { readable, writable } = new TransformStream();
    const w = writable.getWriter();
    const id = crypto.randomUUID();
    this.writers.set(id, w);
    w.write(this.enc.encode('retry: 3000\n\n')).catch(() => {});
    w.write(this.enc.encode(sse({ type: 'history', events: this.recent.slice(-20) }))).catch(() => {});
    this.ensureAlarm();
    return new Response(readable, {
      headers: {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        'connection': 'keep-alive',
        'x-accel-buffering': 'no',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  async broadcast(ev) {
    this.recent.push(ev);
    while (this.recent.length > 100) this.recent.shift();
    await this.state.storage.put('recent', this.recent.slice(-60));
    const msg = sse({ type: 'event', event: ev });
    // 不再 await 单个 writer：连着但不读的 SSE 客户端会让 write 永远挂起，拖住整条广播和后面的推送
    fanoutWrite(this.writers, () => this.enc.encode(msg));
    const wmsg = JSON.stringify({ type: 'event', event: ev });
    for (const ws of this.state.getWebSockets()) {
      try { ws.send(wmsg); } catch (_) {}
    }
    // 推手机：Web Push + Telegram + 飞书（不阻塞失败）；静音事件（子任务）不推手机
    if (!ev.silent) {
      const delivery = { push: () => this.sendPush(ev), telegram: () => this.sendTelegram(ev), lark: () => this.sendLark(ev) };
      // 小智那一路已经在 Worker 的 /hook 里发了（不依赖 DO），这里不再发，免得念两遍
      await Promise.allSettled(deliveryPlan(ev).map((name) => delivery[name]()));
    }
    if (ev.unknownName && ev.projectKey && ev.projectKey !== 'unknown') {
      try { await this.notePending(ev); } catch (_) {}
    }
  }

  // 没进读音表的项目：记一笔，第一次见到时飞书私信问用户该怎么念。
  async notePending(ev) {
    const pend = (await this.state.storage.get('pending')) || {};
    const k = String(ev.projectKey).toLowerCase();
    const first = !pend[k];
    pend[k] = {
      key: ev.projectKey,
      guess: ev.project,
      cwd: ev.cwd || '',
      count: ((pend[k] && pend[k].count) || 0) + 1,
      firstTs: (pend[k] && pend[k].firstTs) || ev.ts,
      lastTs: ev.ts,
    };
    await this.state.storage.put('pending', pend);
    if (first) await this.askPronunciation(pend[k]);
  }

  async askPronunciation(item) {
    const card = {
      config: { wide_screen_mode: true },
      header: { template: 'turquoise', title: { tag: 'plain_text', content: `🆕 新项目 ${item.key} · 该怎么念？` } },
      elements: [
        { tag: 'div', text: { tag: 'lark_md', content: `这个项目第一次播报，读音表里没有，我先按兜底规则念作 **${item.guess}**。` } },
        { tag: 'div', text: { tag: 'lark_md', content: `告诉我正确读音就行，或者直接跑：\n\`cvname ${item.key} <读音>\`` } },
        { tag: 'note', elements: [{ tag: 'plain_text', content: `目录 ${item.cwd || '(未知)'}　·　读音只要听着对，用同音汉字当注音即可` }] },
      ],
    };
    await this.sendLarkCard(card);
  }

  larkText(ev) {
    const icon = { done: '✅', waiting: '⏳', permission: '🔐', notification: '🔔', subagent: '🧩', failed: '❌' }[ev.kind] || '🔔';
    let t = `${icon} ${ev.project} · ${ev.title}\n${ev.speak}`;
    if (ev.detail && ev.detail !== ev.title) t += `\n\n${ev.detail}`;
    return t;
  }
  larkCard(ev) {
    const KMAP = { done: { c: 'green', l: '已完成' }, waiting: { c: 'orange', l: '等待输入' }, permission: { c: 'red', l: '需要授权' }, notification: { c: 'blue', l: '通知' }, subagent: { c: 'violet', l: '子任务' }, failed: { c: 'red', l: '任务失败' } };
    const k = KMAP[ev.kind] || { c: 'blue', l: ev.kind };
    const icon = { done: '✅', waiting: '⏳', permission: '🔐', notification: '🔔', subagent: '🧩', failed: '❌' }[ev.kind] || '🔔';
    const elements = [{ tag: 'div', text: { tag: 'lark_md', content: '**' + ev.speak + '**' } }];
    if (ev.detail && ev.detail !== ev.title) {
      elements.push({ tag: 'hr' });
      elements.push({ tag: 'div', text: { tag: 'lark_md', content: ev.detail } });
    }
    const t = new Date(ev.ts).toLocaleString('zh-CN', { hour12: false });
    const g = ev.gender === 'm' ? '♂' : (ev.gender === 'f' ? '♀' : '·');
    elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `音色 ${g} ${ev.voice}　·　${t}` }] });
    if (this.env.DASH_URL) {
      elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开语音面板' }, url: this.env.DASH_URL, type: 'primary' }] });
    }
    return { config: { wide_screen_mode: true }, header: { template: k.c, title: { tag: 'plain_text', content: `${icon} ${ev.project} · ${k.l}` } }, elements };
  }
  async larkToken() {
    const now = Date.now();
    if (this._larkTok && this._larkTok.token && now < this._larkTok.exp) return this._larkTok.token;
    try {
      const r = await fetch('https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ app_id: this.env.LARK_APP_ID, app_secret: this.env.LARK_APP_SECRET }) });
      const j = await r.json();
      if (j.tenant_access_token) { this._larkTok = { token: j.tenant_access_token, exp: now + ((j.expire || 7200) - 120) * 1000 }; return j.tenant_access_token; }
    } catch (_) {}
    return '';
  }
  async sendLark(ev) { return this.sendLarkCard(this.larkCard(ev)); }

  async sendLarkCard(card) {
    // 优先：自建应用机器人私信
    if (this.env.LARK_APP_ID && this.env.LARK_APP_SECRET && this.env.LARK_OPEN_ID) {
      const tok = await this.larkToken();
      if (!tok) return;
      try {
        await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
          body: JSON.stringify({ receive_id: this.env.LARK_OPEN_ID, msg_type: 'interactive', content: JSON.stringify(card) }) });
      } catch (_) {}
      return;
    }
    // 备选：自定义机器人 webhook
    const url = this.env.LARK_WEBHOOK_URL;
    if (!url) return;
    const body = { msg_type: 'interactive', card };
    if (this.env.LARK_WEBHOOK_SECRET) {
      const ts = Math.floor(Date.now() / 1000).toString();
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(ts + '\n' + this.env.LARK_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(0));
      body.timestamp = ts;
      body.sign = btoa(String.fromCharCode(...new Uint8Array(sig)));
    }
    try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
  }

  // SSE 保活闹钟：只有还挂着 SSE writer 时才存在。WebSocket 不需要它（休眠 + 自动 ping/pong）。
  async ensureAlarm() {
    try {
      const cur = await this.state.storage.getAlarm();
      if (cur == null) await this.state.storage.setAlarm(Date.now() + 20000);
    } catch (e) { console.log('ensureAlarm 失败: ' + String(e)); }
  }
  async alarm() {
    // fanoutWrite 返回仍挂着的 writer 数；断开 / 卡死的先摘掉，没有活 writer 就不再续闹钟
    const alive = fanoutWrite(this.writers, () => this.enc.encode(': ka\n\n'));
    if (alive > 0) await this.state.storage.setAlarm(Date.now() + 20000);
  }

  async addSub(sub) {
    if (!sub || !sub.endpoint) return;
    if (!this.subs.find((s) => s.endpoint === sub.endpoint)) {
      this.subs.push(sub);
      await this.state.storage.put('subs', this.subs);
    }
  }

  async sendPush(ev) {
    if (!this.env.VAPID_PRIVATE || !this.env.VAPID_PUBLIC || !this.subs.length) return;
    const dead = [];
    await Promise.allSettled(this.subs.map(async (sub) => {
      try {
        const auth = await vapidAuth(this.env, sub.endpoint);
        const r = await fetch(sub.endpoint, { method: 'POST', headers: { ...auth, TTL: '120' } });
        if (r.status === 404 || r.status === 410) dead.push(sub.endpoint);
      } catch (_) {}
    }));
    if (dead.length) {
      this.subs = this.subs.filter((s) => !dead.includes(s.endpoint));
      await this.state.storage.put('subs', this.subs);
    }
  }

  async sendTelegram(ev) {
    const tok = this.env.TELEGRAM_BOT_TOKEN, chat = this.env.TELEGRAM_CHAT_ID;
    if (!tok || !chat) return;
    const icon = { done: '✅', waiting: '⏳', permission: '🔐', notification: '🔔', subagent: '🧩', failed: '❌' }[ev.kind] || '🔔';
    const text = `${icon} ${ev.speak}` + (ev.detail ? `\n\n${ev.detail}` : '');
    try {
      await fetch(`https://api.telegram.org/bot${tok}/sendMessage`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: chat, text, disable_notification: false }),
      });
    } catch (_) {}
  }
}

// ============================ 事件规整（与 server.js 同逻辑）============================
async function normalizeEvent(payload, env) {
  const bridgeEvent = normalizeBridgePayload(payload);
  if (bridgeEvent) return bridgeEvent;
  const eventName = payload.hook_event_name || payload.hookEventName || '';
  const cwd = payload.cwd || payload.workspace || '';
  // hook.js 在本机把 scratchpad / worktree / 子目录都归到了真正的项目；服务端读不到文件系统，只能兜底 basename。
  const projectKey = (payload.cv_project || '').toString().trim() || baseName(cwd) || 'unknown';
  const proj = await resolveProject(projectKey, env);
  const rawMsg = (payload.message || '').toString().trim();
  const U = env.USER_NAME || 'Dev';

  let kind, title, detail, tool = '';
  if (eventName === 'Stop') {
    kind = 'done'; title = '任务完成';
    detail = payload.cv_preview || '本轮任务结束。';
  } else if (eventName === 'SubagentStop') {
    if ((env.CV_SUBAGENT || 'silent').toLowerCase() === 'off') return null;
    kind = 'subagent'; title = '子任务完成'; detail = '一个子代理已完成。';
  } else if (eventName === 'Notification') {
    const low = rawMsg.toLowerCase();
    if (low.includes('waiting') || low.includes('idle')) { kind = 'waiting'; title = '等待你的输入'; detail = rawMsg || 'Claude 正在等待你的输入。'; }
    else if (low.includes('permission') || low.includes('approve') || low.includes('allow')) { kind = 'permission'; title = '需要你的授权'; tool = extractTool(rawMsg); detail = rawMsg || '需要你确认一个操作。'; }
    else { kind = 'notification'; title = '通知'; detail = rawMsg || '有新通知。'; }
  } else return null;

  const v = assignVoice(projectKey, proj.voice);
  return {
    id: crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    ts: Date.now(),
    kind,
    needsAction: kind === 'waiting' || kind === 'permission',
    noLark: Boolean(payload.noLark),
    silent: kind === 'subagent' && (env.CV_SUBAGENT || 'silent').toLowerCase() !== 'voice',
    project: proj.display, projectKey, cwd, color: proj.color || null,
    unknownName: !proj.known,               // 读音表里没有，念法是兜底猜的

    voice: v.name, gender: v.gender,
    style: buildStyle(kind),
    title, detail: clip(detail, 240),
    speak: await buildSpeak(env, kind, U, proj.say, sayTool(tool), detail),
    rawMessage: rawMsg, sessionId: payload.session_id || '',
  };
}



// 真·总结：用 Workers AI（Llama 3.3 70B fast，免费额度内，~0.6s）读懂全文 → 一句可朗读的简体中文。
// 失败/超时返回空串，调用方退回抽取式。
async function aiSummarize(env, text) {
  if (!env || !env.AI) return '';
  try {
    const run = env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: '你是中文语音播报助手。把用户给的"任务完成说明"压成一句、最多两句适合朗读的简体中文：先说核心做了什么；如有需要用户拍板的事，再补一句。要求：不超过50字、口语化、不要列点不要markdown、不要重复目录名、直接输出播报正文本身（不要写"总结："之类前缀）。' },
        { role: 'user', content: String(text).slice(0, 1500) },
      ],
      max_tokens: 160,
    });
    const timeout = new Promise((res) => setTimeout(() => res(null), 4500)); // 超时即退回抽取式，保证 hook 不超时
    const r = await Promise.race([run, timeout]);
    if (!r) return '';
    let out = (typeof r === 'string' ? r : (r.response || '')).toString().trim();
    out = out.replace(/^(总结|播报|内容|输出)[:：]\s*/, '').replace(/^["'「『《]+|["'」』》]+$/g, '').replace(/\s+/g, ' ').trim();
    return out.slice(0, 120);
  } catch (_) { return ''; }
}

// 统一格式：中文名 + 敬称 + 目录名 + 任务状态 + 具体描述（模板在 shared/speech.cjs）
async function buildSpeak(env, kind, U, proj, tool, detail) {
  if (kind === 'done') return await buildDoneSpeak(env, U, proj, detail);
  return speech.buildAlertSpeak(kind, userAddresses(env, U), proj, tool);
}

// 完成播报是云端独有的一条：先让 Workers AI 真读一遍再总结，不行才退回本地那套抽取式。
async function buildDoneSpeak(env, U, proj, detail) {
  const who = userAddresses(env, U);
  const raw = (detail || '').trim();
  if (!raw || raw === '本轮任务结束。') return speech.doneFallback(who, proj);
  let sum = await aiSummarize(env, raw);                              // 首选：AI 真总结（读懂全文 → 一句中文）
  if (!sum) sum = isMostlyChinese(raw) ? pickSummary(raw, 150) : '';  // AI 不可用 → 抽取式（已是中文）
  if (!sum) return speech.doneFallback(who, proj);                    // 仍拿不到中文 → 定型句，绝不念英文
  return speech.doneWithSummary(who, proj, sum);
}

// ============================ TTS 代理（edge 首选 → azure 兜底）============================
// 项目 4 音色 → Edge/Azure 同名神经语音（实测可用的 zh-CN 音色）
const EDGE_VOICE_MAP = { '茉莉': 'zh-CN-XiaoxiaoNeural', '冰糖': 'zh-CN-XiaoyiNeural', '白桦': 'zh-CN-YunxiNeural', '苏打': 'zh-CN-YunyangNeural' };
const EDGE_DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';
function resolveVoiceEdge(v) {
  if (!v) return EDGE_DEFAULT_VOICE;
  if (EDGE_VOICE_MAP[v]) return EDGE_VOICE_MAP[v];
  if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(v)) return v;
  return EDGE_DEFAULT_VOICE;
}
function escXmlW(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;'); }
function hexW(n, upper) { const a = [...crypto.getRandomValues(new Uint8Array(n))].map((b) => b.toString(16).padStart(2, '0')).join(''); return upper ? a.toUpperCase() : a; }
async function secMsGecW() {
  let ticks = Date.now() / 1000 + 11644473600;
  ticks -= ticks % 300; ticks *= 1e7;
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(ticks.toFixed(0) + '6A5AA1D4EAFF4E9FB37E23D68491D6F4'));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('').toUpperCase();
}

// 微软 Edge 在线神经语音：Worker 用 fetch(Upgrade) 拿出站 WebSocket（免 key）
async function edgeSynthW(text, voice, format) {
  const v = resolveVoiceEdge(voice);
  const fmt = format === 'wav' ? 'riff-24khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3';
  const connId = hexW(16, false);
  // Worker 出站 WebSocket：用 https:// 方案 + Upgrade 头（workerd 不接受 wss:// 方案）
  const url = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1?TrustedClientToken=6A5AA1D4EAFF4E9FB37E23D68491D6F4&ConnectionId=${connId}&Sec-MS-GEC=${await secMsGecW()}&Sec-MS-GEC-Version=1-143.0.3650.75`;
  const resp = await fetch(url, { headers: {
    Upgrade: 'websocket',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0',
    Origin: 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold',
    Cookie: `muid=${hexW(16, true)};`,
    'Accept-Language': 'en-US,en;q=0.9', Pragma: 'no-cache', 'Cache-Control': 'no-cache',
  } });
  const ws = resp.webSocket;
  if (!ws) throw new Error('edge 无 webSocket(status ' + resp.status + ')');
  ws.accept();
  try { ws.binaryType = 'arraybuffer'; } catch (_) {}
  return await new Promise((resolve, reject) => {
    const binParts = [];            // 二进制帧按到达顺序收集（workerd 可能给 Blob，需异步取 arrayBuffer）
    let settled = false, ended = false;
    const to = setTimeout(() => { if (!settled) { settled = true; try { ws.close(); } catch (_) {} reject(new Error('edge 超时')); } }, 20000);
    async function assemble() {
      if (settled) return; settled = true; clearTimeout(to); try { ws.close(); } catch (_) {}
      try {
        let total = 0; const arrs = [];
        for (const part of binParts) {
          const ab = part instanceof ArrayBuffer ? part : (part && part.arrayBuffer ? await part.arrayBuffer() : null);
          if (!ab) continue;
          const u8 = new Uint8Array(ab);
          const hlen = (u8[0] << 8) | u8[1];
          const a = u8.subarray(2 + hlen); arrs.push(a); total += a.length;
        }
        if (!total) return reject(new Error('edge 无音频'));
        const out = new Uint8Array(total); let o = 0; for (const a of arrs) { out.set(a, o); o += a.length; }
        resolve(out);
      } catch (err) { reject(err); }
    }
    ws.addEventListener('message', (e) => {
      const d = e.data;
      if (typeof d === 'string') { if (d.includes('Path:turn.end')) { ended = true; assemble(); } }
      else binParts.push(d);
    });
    ws.addEventListener('close', () => { if (!settled) { if (ended || binParts.length) assemble(); else { settled = true; clearTimeout(to); reject(new Error('edge 关闭无音频')); } } });
    ws.addEventListener('error', () => { if (!settled) { settled = true; clearTimeout(to); reject(new Error('edge ws 错误')); } });
    const ts = new Date().toString();
    const cfg = `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
      JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: fmt } } } });
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${v}'><prosody pitch='${TTS_PROSODY.pitch}' rate='${TTS_PROSODY.rate}' volume='${TTS_PROSODY.volume}'>${escXmlW(text)}</prosody></voice></speak>`;
    ws.send(cfg);
    ws.send(`X-RequestId:${connId}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`);
  });
}

// Azure 语音服务（同一套语音名；纯 POST）
async function azureSynthW(text, voice, format, env) {
  const v = resolveVoiceEdge(voice);
  const fmt = format === 'wav' ? 'riff-24khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3';
  const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${v}'>${escXmlW(text)}</voice></speak>`;
  const r = await fetch(`https://${env.AZURE_SPEECH_REGION}.tts.speech.microsoft.com/cognitiveservices/v1`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': fmt, 'Ocp-Apim-Subscription-Key': env.AZURE_SPEECH_KEY, 'User-Agent': 'ClaudeVoice' },
    body: ssml,
  });
  if (!r.ok) throw new Error('Azure ' + r.status + ': ' + (await r.text()).slice(0, 150));
  return new Uint8Array(await r.arrayBuffer());
}

function ttsOrderW(env) {
  return env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION ? ['edge', 'azure'] : ['edge'];
}

// /tts 缓存：isolate 内存 LRU → caches.default → 现合成。key = SHA-256(文本 + 解析后的音色 + 格式 + 韵律参数)，
// 原文不进 URL。只缓存合成成功的非空音频；鉴权在路由层已经做完，这里只管缓存。
const ttsMem = new MemoryAudioCache();

async function synthTts(text, voice, format, env) {
  let lastErr = '';
  for (const eng of ttsOrderW(env)) {
    try {
      const bytes = await retryTtsW(eng, async () => {
        if (eng === 'edge') return edgeSynthW(text, voice, format);
        return azureSynthW(text, voice, format, env);
      });
      assertAudioW(bytes, eng);
      return bytes;
    } catch (e) { lastErr = String((e && e.message) || e); console.log('TTS ' + eng + ' 失败: ' + lastErr); }
  }
  const err = new Error(lastErr || 'TTS 失败');
  err.ttsFailed = true;
  throw err;
}

async function handleTts(req, env, cors, ctx) {
  let body = {};
  try { body = await req.json(); } catch (_) {}
  const text = (body.text || '').toString().slice(0, 800);
  if (!text) return jsonResp({ error: 'text 必填' }, 400, cors);
  const voice = (body.voice || env.TTS_VOICE || '茉莉').toString();
  const format = body.format === 'wav' ? 'wav' : 'mp3';
  const ct = ttsContentType(format);
  // x-cv-tts-cache: hit | miss；命中时 x-cv-tts-tier: mem（isolate 内存）| edge（caches.default）——
  // 线上看到 edge 说明 Cache API 在当前域名上真的生效，只见 mem 说明它没生效（workers.dev 上官方不保证）。
  const reply = (bytes, state, tier) => new Response(bytes, { headers: {
    ...cors, 'Access-Control-Expose-Headers': 'x-cv-tts-cache, x-cv-tts-tier',
    'content-type': ct, 'cache-control': `public, max-age=${TTS_CACHE_TTL_SEC}`, 'x-cv-tts-cache': state,
    ...(tier ? { 'x-cv-tts-tier': tier } : {}),
  } });

  let hash = '';
  try { hash = await ttsCacheHash(ttsParams({ text, voice: resolveVoiceEdge(voice), format })); } catch (e) { console.log('tts cache key 失败: ' + String(e)); }
  const cache = hash ? edgeCache() : null;
  const keyReq = hash ? new Request(ttsCacheUrl(hash)) : null;

  if (hash) {
    const m = ttsMem.get(hash);
    if (m) return reply(m.bytes, 'hit', 'mem');
    if (cache) {
      try {
        const c = await cache.match(keyReq);
        if (c) {
          const bytes = new Uint8Array(await c.arrayBuffer());
          if (bytes.byteLength) { ttsMem.set(hash, bytes, ct); return reply(bytes, 'hit', 'edge'); }
        }
      } catch (e) { console.log('tts cache 读取失败: ' + String(e)); }
    }
  }

  const synthAndStore = async () => {
    const bytes = await synthTts(text, voice, format, env);
    if (hash) {
      ttsMem.set(hash, bytes, ct);
      if (cache) {
        const put = cache.put(keyReq, new Response(bytes, { headers: { 'content-type': ct, 'cache-control': `public, max-age=${TTS_CACHE_TTL_SEC}` } }))
          .catch((e) => console.log('tts cache 写入失败: ' + String(e)));
        if (ctx && ctx.waitUntil) ctx.waitUntil(put);
      }
    }
    return bytes;
  };
  try {
    const bytes = hash ? await ttsMem.once(hash, synthAndStore) : await synthAndStore();
    return reply(bytes, 'miss');
  } catch (e) {
    return jsonResp({ error: 'TTS 失败', detail: String((e && e.message) || e) }, 502, cors);
  }
}

async function retryTtsW(engine, synth) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const bytes = await synth();
      assertAudioW(bytes, engine);
      return bytes;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      const delay = 250 * (2 ** attempt);
      console.log(`TTS ${engine} 第 ${attempt + 1} 次失败，${delay}ms 后重试`);
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError || new Error(engine + ' 合成失败');
}

function assertAudioW(bytes, engine) {
  const size = bytes && (bytes.byteLength || bytes.length);
  if (!size) throw new Error(engine + ' 返回空音频');
}

// ============================ VAPID（无 payload 推送，仅需 JWT 鉴权）============================
async function vapidAuth(env, endpoint) {
  const aud = new URL(endpoint).origin;
  const header = b64urlStr(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const payload = b64urlStr(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 43200, sub: env.VAPID_SUBJECT || 'mailto:admin@example.com' }));
  const signingInput = header + '.' + payload;
  const key = await crypto.subtle.importKey('jwk', JSON.parse(env.VAPID_PRIVATE), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, new TextEncoder().encode(signingInput)));
  const jwt = signingInput + '.' + b64urlBytes(sig);
  return { Authorization: `vapid t=${jwt}, k=${env.VAPID_PUBLIC}` };
}

// ============================ 工具 ============================
function sse(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function jsonResp(o, status, cors) { return new Response(JSON.stringify(o), { status, headers: { ...(cors || {}), 'content-type': 'application/json; charset=utf-8' } }); }
function b64urlStr(s) { return b64urlBytes(new TextEncoder().encode(s)); }
function b64urlBytes(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
