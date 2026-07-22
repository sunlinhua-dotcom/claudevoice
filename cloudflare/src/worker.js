import { deliveryPlan, normalizeBridgePayload } from './event-utils.mjs';

/**
 * ClaudeVoice — Cloudflare Worker（边缘常驻中转站）
 *
 *  Mac: hook.js ──POST /hook──► 本 Worker
 *  Worker: 规整事件 → Durable Object(Hub) 用 SSE 推给网页
 *          + Web Push 推手机 + Telegram 消息；并代理 MiMo TTS
 *  静态面板从 assets(../public) 提供。
 *
 *  Secrets（wrangler secret put）：
 *    MIMO_API_KEY, HOOK_SECRET, DASH_TOKEN,
 *    VAPID_PUBLIC, VAPID_PRIVATE(JWK json), VAPID_SUBJECT,
 *    TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID
 *  Vars（wrangler.toml [vars]）：MIMO_BASE, MIMO_MODEL, MIMO_VOICE, USER_NAME
 */

// 只用中文音色（英文音色读中文会变乱码）。保留男女区分。
const VOICE_POOL = [
  { name: '茉莉', gender: 'f' }, { name: '白桦', gender: 'm' },
  { name: '冰糖', gender: 'f' }, { name: '苏打', gender: 'm' },
];
const VOICE_GENDER = VOICE_POOL.reduce((m, v) => (m[v.name] = v.gender, m), {});

// 播报里跟在名字后的尊称，每次随机抽一个（都是对老板的不同叫法，与 server.js 同步）。
const HONORIFICS = [
  '老板', '老大', '老总', '大老板', '我的老板',
  '老板大人', '尊敬的老板', '老板中的老板', '头儿', '领导',
  '一把手', '董事长', '总裁', '掌柜的', '东家',
  '当家的', '当家人', '我们老大', '我的顶头上司', '话事人',
];

// 用户认可的几种称呼：主名 USER_NAME + 备用别名 USER_ALIASES（逗号分隔），每次随机抽一个当开头。
function userAddresses(env, U) {
  const aliases = String(env.USER_ALIASES || '').split(/[，,]/).map((s) => s.trim()).filter(Boolean);
  return [U, ...aliases];
}

// 内置「中文名 + TTS 读音」种子。name=屏幕显示；say=语音念的读音。
const DEFAULT_PROJECTS = {
  CLAUDEVOICE: { name: '语音通知台', say: 'Claude Voice' },
  autoresearch: { name: '自动研究', say: 'Auto Research' },
  'my-web-app': { name: '我的网站', say: 'My Web App' },
  'api-service': { name: '接口服务', say: 'API Service' },
  'docs-site': { name: '文档站', say: 'Docs Site' },
};
function humanizeName(key) {
  return (key || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim() || key;
}
function sayTool(t) { return humanizeName(t || ''); }
function resolveProject(projectKey) {
  const o = DEFAULT_PROJECTS[projectKey] || {};
  return {
    display: o.name || humanizeName(projectKey),
    say: o.say || o.name || humanizeName(projectKey),
    color: o.color || null,
    voice: o.voice || null,
  };
}

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
    if (p === '/unlock' && req.method === 'POST') {
      let pw = '';
      try { const b = await req.json(); pw = ((b && b.pw) || '').toString().trim(); } catch (_) {}
      const expected = (env.UNLOCK_PASSWORD || '').toString();
      // 未配置 UNLOCK_PASSWORD 时不放行（无内置默认密码）。
      if (env.DASH_TOKEN && expected && pw && pw === expected) {
        return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { ...cors, 'content-type': 'application/json', 'set-cookie': `cv_token=${env.DASH_TOKEN}; Max-Age=31536000; Path=/; Secure; HttpOnly; SameSite=Lax` } });
      }
      return new Response(JSON.stringify({ ok: false }), { status: 401, headers: { ...cors, 'content-type': 'application/json' } });
    }

    if (p === '/hook' && req.method === 'POST') {
      if (env.HOOK_SECRET && req.headers.get('x-cv-secret') !== env.HOOK_SECRET)
        return jsonResp({ error: 'bad secret' }, 401, cors);
      let payload = {};
      try { payload = await req.json(); } catch (_) {}
      const ev = await normalizeEvent(payload, env);
      if (ev) await hub(env).fetch('https://do/broadcast', { method: 'POST', body: JSON.stringify(ev) });
      return jsonResp({ ok: true, event: ev || null }, 200, cors); // 返回事件，供 Mac 端 afplay 发声
    }

    // 以下面向浏览器：若设了 DASH_TOKEN 需校验（query / 头 / 或 unlock 种下的 cookie）
    const cookieTok = (() => { const c = req.headers.get('cookie') || ''; const m = c.match(/(?:^|;\s*)cv_token=([^;]+)/); return m ? decodeURIComponent(m[1]) : ''; })();
    const tokOK = !env.DASH_TOKEN || url.searchParams.get('token') === env.DASH_TOKEN || req.headers.get('x-cv-token') === env.DASH_TOKEN || cookieTok === env.DASH_TOKEN;

    if (p === '/events') {
      if (!tokOK) return jsonResp({ error: 'token required' }, 401, cors);
      return hub(env).fetch('https://do/sse');
    }
    if (p === '/subscribe' && req.method === 'POST') {
      if (!tokOK) return jsonResp({ error: 'token required' }, 401, cors);
      const body = await req.text();
      return hub(env).fetch('https://do/subscribe', { method: 'POST', body });
    }
    if (p === '/latest') {
      if (!tokOK) return jsonResp({ error: 'token required' }, 401, cors);
      return hub(env).fetch('https://do/latest');
    }
    if (p === '/tts' && req.method === 'POST') {
      const secOK = env.HOOK_SECRET && req.headers.get('x-cv-secret') === env.HOOK_SECRET;
      if (!tokOK && !secOK) return jsonResp({ error: 'token required' }, 401, cors);
      return handleTts(req, env, cors);
    }
    if (p === '/config') {
      return jsonResp({
        voicePool: VOICE_POOL,
        defaultVoice: env.MIMO_VOICE || 'Dean',
        model: env.MIMO_MODEL || 'mimo-v2.5-tts',
        userName: env.USER_NAME || 'Dev',
        requiresToken: !!env.DASH_TOKEN,
        vapidPublic: env.VAPID_PUBLIC || '',
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
        + `.then(function(j){if(j&&j.ok){location.replace('/');}else{err.textContent='密码不对，再试一次';pw.value='';pw.focus();}})`
        + `.catch(function(){err.textContent='网络出错，重试一次';});};pw.focus();</script></body></html>`;
      return new Response(html, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
    }
    return env.ASSETS.fetch(req);
  },
};

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
  }

  async fetch(req) {
    const p = new URL(req.url).pathname;
    if (p === '/sse') return this.handleSSE();
    if (p === '/broadcast') { const ev = await req.json(); await this.broadcast(ev); return Response.json({ ok: true }); }
    if (p === '/subscribe') { const sub = await req.json(); await this.addSub(sub); return Response.json({ ok: true }); }
    if (p === '/latest') {
      const e = this.recent[this.recent.length - 1] || null;
      const min = e ? { project: e.project, kind: e.kind, title: e.title } : null; // 仅最小信息
      return Response.json({ event: min });
    }
    return new Response('not found', { status: 404 });
  }

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
    for (const [id, w] of this.writers) {
      try { await w.write(this.enc.encode(msg)); }
      catch (_) { this.writers.delete(id); }
    }
    // 推手机：Web Push + Telegram + 飞书（不阻塞失败）；静音事件（子任务）不推手机
    if (!ev.silent) {
      const delivery = { push: () => this.sendPush(ev), telegram: () => this.sendTelegram(ev), lark: () => this.sendLark(ev) };
      await Promise.allSettled(deliveryPlan(ev).map((name) => delivery[name]()));
    }
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
  async sendLark(ev) {
    // 优先：自建应用机器人私信
    if (this.env.LARK_APP_ID && this.env.LARK_APP_SECRET && this.env.LARK_OPEN_ID) {
      const tok = await this.larkToken();
      if (!tok) return;
      try {
        await fetch('https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id', {
          method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + tok },
          body: JSON.stringify({ receive_id: this.env.LARK_OPEN_ID, msg_type: 'interactive', content: JSON.stringify(this.larkCard(ev)) }) });
      } catch (_) {}
      return;
    }
    // 备选：自定义机器人 webhook
    const url = this.env.LARK_WEBHOOK_URL;
    if (!url) return;
    const body = { msg_type: 'interactive', card: this.larkCard(ev) };
    if (this.env.LARK_WEBHOOK_SECRET) {
      const ts = Math.floor(Date.now() / 1000).toString();
      const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(ts + '\n' + this.env.LARK_WEBHOOK_SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
      const sig = await crypto.subtle.sign('HMAC', key, new Uint8Array(0));
      body.timestamp = ts;
      body.sign = btoa(String.fromCharCode(...new Uint8Array(sig)));
    }
    try { await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }); } catch (_) {}
  }

  async ensureAlarm() {
    const cur = await this.state.storage.getAlarm();
    if (cur == null) this.state.storage.setAlarm(Date.now() + 20000);
  }
  async alarm() {
    for (const [id, w] of this.writers) {
      try { await w.write(this.enc.encode(': ka\n\n')); }
      catch (_) { this.writers.delete(id); }
    }
    if (this.writers.size > 0) this.state.storage.setAlarm(Date.now() + 20000);
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
  const projectKey = baseName(cwd) || 'unknown';
  const proj = resolveProject(projectKey);
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
    silent: kind === 'subagent' && (env.CV_SUBAGENT || 'silent').toLowerCase() !== 'voice',
    project: proj.display, projectKey, cwd, color: proj.color || null,
    voice: v.name, gender: v.gender,
    style: buildStyle(kind),
    title, detail: clip(detail, 240),
    speak: await buildSpeak(env, kind, U, proj.say, sayTool(tool), detail),
    rawMessage: rawMsg, sessionId: payload.session_id || '',
  };
}

function extractTool(msg) { const m = /use\s+([A-Za-z0-9_\- ]+?)(?:[\.\(]|$)/i.exec(msg); return m ? m[1].trim() : ''; }
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function assignVoice(k, override) {
  if (override && VOICE_GENDER[override]) return { name: override, gender: VOICE_GENDER[override] };
  return VOICE_POOL[hashStr(k) % VOICE_POOL.length];
}

// 判断是否中文为主（翻译已在 Mac 端 hook.js 做；Cloudflare IP 调 Google 翻译会被 429 限流，故云端不翻）
function isMostlyChinese(s) {
  const cjk = (String(s).match(/[一-鿿]/g) || []).length;
  const latin = (String(s).match(/[A-Za-z]/g) || []).length;
  return cjk >= Math.max(4, latin);
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

// 统一格式：中文名 + 敬称 + 目录名 + 任务状态 + 具体描述
async function buildSpeak(env, kind, U, proj, tool, detail) {
  if (kind === 'done') return await buildDoneSpeak(env, U, proj, detail);
  const g = `${pick(userAddresses(env, U))}，${pick(HONORIFICS)}，`;
  const P = {
    waiting: [
      `${g}目录 ${proj} 正在等你输入，回去看一下吧。`,
      `${g}${proj} 这边停下来，等你回话了。`,
    ],
    permission: tool ? [
      `${g}目录 ${proj} 需要你授权使用 ${tool}。`,
      `${g}${proj} 想动用 ${tool}，等你点头。`,
    ] : [
      `${g}目录 ${proj} 需要你确认一下。`,
    ],
    subagent: [`${g}${proj} 有一个子任务完成了。`],
    notification: [`${g}${proj} 有一条新消息，留意一下。`],
  };
  return pick(P[kind] || P.notification);
}
async function buildDoneSpeak(env, U, proj, detail) {
  const g = `${pick(userAddresses(env, U))}，${pick(HONORIFICS)}，`;
  const raw = (detail || '').trim();
  if (!raw || raw === '本轮任务结束。') {
    return pick([
      `${g}目录 ${proj} 的任务已经完成，回来看看结果吧。`,
      `${g}${proj} 这一轮完成了，记得验收。`,
    ]);
  }
  let sum = await aiSummarize(env, raw);                       // 首选：AI 真总结（读懂全文 → 一句中文）
  if (!sum) sum = isMostlyChinese(raw) ? pickSummary(raw, 150) : ''; // AI 不可用 → 抽取式（已是中文）
  if (!sum) return pick([                                      // 仍拿不到中文 → 定型句，绝不念英文
    `${g}目录 ${proj} 的任务已经完成，回来看看结果吧。`,
    `${g}${proj} 这一轮完成了，记得验收。`,
  ]);
  return `${g}目录 ${proj} 的任务完成了。具体是，${sum}`;
}
const DECISION_RE = /[?？]|是否|还是|要不要|需不需要|需要你|请你确认|请确认|建议|你来定|你决定|你看|选择|二选一|哪一个|哪个|可以吗|对吗|要不/;
// 从最后回复里抽「适合朗读的总结」：按整句累加到 maxLen，结论在前、需要定夺的句子保证念到，
// 永远在句子边界收尾（不切半句、不拖省略号），解决「念一小段突然没了」。
function pickSummary(detail, maxLen) {
  const t = cleanForSpeech(detail || '', 2000);
  if (!t) return '';
  const sents = t.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  if (!sents.length) return '';
  let out = '';
  for (const s of sents) {
    if (out.length + s.length > maxLen && out.length > 0) break;
    out += s;
  }
  if (!out) {
    const s = sents[0].slice(0, maxLen);
    const lp = Math.max(s.lastIndexOf('，'), s.lastIndexOf('。'), s.lastIndexOf('、'), s.lastIndexOf('；'));
    out = (lp > maxLen * 0.5 ? s.slice(0, lp) : s) + '。';
  }
  const dec = sents.find((s) => DECISION_RE.test(s));
  if (dec && out.indexOf(dec) < 0 && out.length + dec.length <= maxLen + 80) out += dec;
  return out;
}
function capSpeech(s, n) {
  s = (s || '').trim(); if (s.length <= n) return s;
  const c = s.slice(0, n);
  const lp = Math.max(c.lastIndexOf('。'), c.lastIndexOf('！'), c.lastIndexOf('？'), c.lastIndexOf('，'));
  return (lp > n * 0.5 ? c.slice(0, lp + 1) : c) + '……';
}
function cleanForSpeech(text, maxLen) {
  let s = (text || '').toString()
    .replace(/```[\s\S]*?```/g, ' ').replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]/g, ' ').replace(/^[\s\-•\d.]+/gm, '')
    .replace(/\s+/g, ' ').trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lp = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'), cut.lastIndexOf('，'));
  return (lp > maxLen * 0.5 ? cut.slice(0, lp + 1) : cut) + '……';
}
function buildStyle(kind) {
  // 保持简短：风格指令越短越干净，过长会被 TTS 当成内容念进去导致乱码
  const tones = ['语气自然亲切。', '语气干练利落。', '温柔地提醒。', '沉稳地说。', '稍微轻快一点。', '带一点期待。'];
  return pick(tones);
}

// ============================ TTS 代理（edge 首选 → azure 兜底 → mimo 兜底）============================
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
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${v}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escXmlW(text)}</prosody></voice></speak>`;
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

// 小米 MiMo（最后兜底）
async function mimoSynthW(text, voice, style, format, env) {
  if (!env.MIMO_API_KEY) throw new Error('MIMO 未配置');
  const base = (env.MIMO_BASE || 'https://api.xiaomimimo.com/v1').replace(/\/$/, '');
  const r = await fetch(base + '/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer ' + env.MIMO_API_KEY },
    body: JSON.stringify({ model: env.MIMO_MODEL || 'mimo-v2.5-tts', messages: [{ role: 'user', content: style }, { role: 'assistant', content: text }], audio: { format, voice } }),
  });
  if (!r.ok) throw new Error('MiMo ' + r.status + ': ' + (await r.text()).slice(0, 150));
  const data = await r.json();
  const b64 = data?.choices?.[0]?.message?.audio?.data;
  if (!b64) throw new Error('MiMo 返回缺少 audio.data');
  return b64ToBytes(b64);
}

function ttsOrderW(env) {
  const have = { edge: true, azure: !!(env.AZURE_SPEECH_KEY && env.AZURE_SPEECH_REGION), mimo: !!env.MIMO_API_KEY };
  const primary = (env.TTS_ENGINE || 'edge').toLowerCase();
  return [primary, 'edge', 'azure', 'mimo'].filter((e, i, a) => a.indexOf(e) === i && have[e]);
}

async function handleTts(req, env, cors) {
  let body = {};
  try { body = await req.json(); } catch (_) {}
  const text = (body.text || '').toString().slice(0, 800);
  if (!text) return jsonResp({ error: 'text 必填' }, 400, cors);
  const voice = (body.voice || env.MIMO_VOICE || '').toString();
  const style = (body.style || '').toString().slice(0, 300);
  const format = body.format === 'wav' ? 'wav' : 'mp3';
  let lastErr = '';
  for (const eng of ttsOrderW(env)) {
    try {
      let bytes;
      if (eng === 'edge') bytes = await edgeSynthW(text, voice, format);
      else if (eng === 'azure') bytes = await azureSynthW(text, voice, format, env);
      else if (eng === 'mimo') bytes = await mimoSynthW(text, voice, style, format, env);
      else continue;
      return new Response(bytes, { headers: { ...cors, 'content-type': format === 'wav' ? 'audio/wav' : 'audio/mpeg', 'cache-control': 'public, max-age=86400' } });
    } catch (e) { lastErr = String((e && e.message) || e); console.log('TTS ' + eng + ' 失败: ' + lastErr); }
  }
  return jsonResp({ error: 'TTS 失败', detail: lastErr }, 502, cors);
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
function baseName(p) { if (!p) return ''; return p.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop(); }
function clip(s, n) { s = (s || '').toString(); return s.length > n ? s.slice(0, n) + '…' : s; }
function b64ToBytes(b64) { const bin = atob(b64); const a = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) a[i] = bin.charCodeAt(i); return a; }
function b64urlStr(s) { return b64urlBytes(new TextEncoder().encode(s)); }
function b64urlBytes(bytes) { let bin = ''; for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]); return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
