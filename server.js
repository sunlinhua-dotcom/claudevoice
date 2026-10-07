#!/usr/bin/env node
/**
 * ClaudeVoice — 全局语音通知服务
 *
 * 职责：
 *  1. 接收 Claude Code 全局 hook 推来的事件 (POST /hook)
 *  2. 通过 SSE 把事件实时推给所有打开的网页 (GET /events)
 *  3. 代理微软 Edge 神经语音，可选 Azure 兜底 (POST /tts)
 *  4. 托管网页面板 (GET /)
 *
 * 纯 Node 内置模块，无需 npm install。
 */

'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { URL } = require('url');
const edge = require('./edge-tts'); // 首选 TTS 引擎（免 key 的微软 Edge 神经语音）
// 播报话术层（音色分配 / 名字读法 / 句子模板 / 摘要清洗）与 hook.js、cloudflare/src/worker.js 共用
// 同一份 shared/speech.cjs。这里只保留与本进程有关的部分（读 projects.json、SSE、TTS 合成）。
const speech = require('./shared/speech.cjs');
const {
  VOICE_POOL, VOICE_GENDER, spaceCJK, humanizeName, sayTool,
  pick, hashStr, assignVoice, isMostlyChinese,
  cleanForSpeech, pickSummary, buildStyle, extractTool, baseName, clip,
} = speech;

// ---------- 配置 ----------
loadDotenv(path.join(__dirname, '.env'));

const CFG = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '8787', 10),
  ttsEngine: (process.env.TTS_ENGINE || 'edge').toLowerCase(), // 保留配置显示；实际可靠性链固定为 edge → azure
  defaultVoice: process.env.TTS_VOICE || '茉莉',
  azureKey: process.env.AZURE_SPEECH_KEY || '',
  azureRegion: process.env.AZURE_SPEECH_REGION || '',
  subagentMode: (process.env.CV_SUBAGENT || 'silent').toLowerCase(), // 子任务：silent(默认,只显示不出声) / voice / off
  hookSecret: process.env.HOOK_SECRET || '',
  dashToken: process.env.DASH_TOKEN || '', // 设了就要求 ?token= 才能看面板/SSE/TTS
  userName: process.env.USER_NAME || 'Dev', // 播报时尊称
  userAliases: String(process.env.USER_ALIASES || '').split(/[，,]/).map(s => s.trim()).filter(Boolean), // 备用称呼，随机轮换
  larkWebhook: process.env.LARK_WEBHOOK_URL || '',    // 飞书自定义机器人 webhook（备选）
  larkSecret: process.env.LARK_WEBHOOK_SECRET || '',  // 可选签名密钥
  larkAppId: process.env.LARK_APP_ID || '',           // 飞书自建应用（机器人私信）
  larkAppSecret: process.env.LARK_APP_SECRET || '',
  larkOpenId: process.env.LARK_OPEN_ID || '',         // 收件人 open_id
  dashUrl: process.env.DASH_URL || '',                // 卡片「打开面板」按钮指向（公网面板地址）
};

// 用户只认这两个称呼：主名 userName（布莱特）+ 别名 userAliases（老孙），每次随机抽一个。
// 2026-08-25 用户明确要求：不要再加"老板/老大"之类的尊称后缀。
function userAddresses() {
  return [CFG.userName, ...CFG.userAliases];
}

const PROJECTS = loadProjects(path.join(__dirname, 'projects.json'));

// 内置「中文名 + TTS 读音」种子表，与 hook.js / Worker 共用同一份 names.json。
// name = 屏幕显示；say = 语音实际念的读音（只要读音对，用汉字当注音即可）。projects.json 仍可覆盖。
const DEFAULT_PROJECTS = (() => {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, 'names.json'), 'utf8'));
    const m = {};
    for (const k of Object.keys(t)) if (k[0] !== '_') m[k.toLowerCase()] = t[k];
    return m;
  } catch (_) { return {}; }
})();

// 解析项目：手工覆盖 > 种子 > 增强兜底拆词
function resolveProject(projectKey, cwd) {
  const lk = String(projectKey || '').toLowerCase();
  const o = PROJECTS[projectKey] || PROJECTS[lk] || PROJECTS[cwd] || DEFAULT_PROJECTS[lk] || {};
  return {
    display: o.name || humanizeName(projectKey),
    say: spaceCJK(o.say || o.name || humanizeName(projectKey)),
    color: o.color || null,
    voice: o.voice || null,
  };
}
const INDEX_HTML = path.join(__dirname, 'public', 'index.html');

// ---------- 运行时状态 ----------
const sseClients = new Set();          // res 集合
const recent = [];                     // 最近事件环形缓冲（最多 100）
const RECENT_MAX = 100;
const ttsCache = new Map();            // key -> {buf, type}
const TTS_CACHE_MAX = 200;

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = u.pathname;

  // CORS（便于隧道/跨端访问）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-CV-Secret, X-CV-Token');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }

  if (p === '/health') return json(res, 200, { ok: true, clients: sseClients.size });
  if (p === '/hook' && req.method === 'POST') return handleHook(req, res);
  if (p === '/events') return handleEvents(req, res, u);
  if (p === '/tts' && req.method === 'POST') return handleTts(req, res, u);
  if (p === '/config') return handleConfig(res);
  if (p === '/_cue') return serveFile(res, path.join(__dirname, 'mac-app', 'cuegen.html'), 'text/html; charset=utf-8');
  if (p === '/_savecue' && req.method === 'POST') return handleSaveCue(req, res);
  if (p === '/sw.js') return serveStatic(res, 'sw.js', 'application/javascript; charset=utf-8');
  if (p === '/manifest.webmanifest') return serveStatic(res, 'manifest.webmanifest', 'application/manifest+json; charset=utf-8');
  if (p === '/icon.svg') return serveStatic(res, 'icon.svg', 'image/svg+xml; charset=utf-8');
  if (p === '/' || p === '/index.html') return serveIndex(res, u);

  json(res, 404, { error: 'not found' });
});

server.listen(CFG.port, CFG.host, () => {
  const url = `http://localhost:${CFG.port}`;
  log(`ClaudeVoice 已启动 → ${url}`);
  log(`  hook 接收:  POST ${url}/hook   (密钥: ${CFG.hookSecret ? '已设置' : '⚠ 未设置'})`);
  log(`  面板:       ${url}/${CFG.dashToken ? '?token=***' : ''}`);
  log(`  TTS:        Edge 神经语音${CFG.azureKey && CFG.azureRegion ? ' → Azure 兜底' : ''}`);
});

// =================================================================
// Hook 接收：解析 Claude Code 事件并广播
// =================================================================
function handleHook(req, res) {
  if (CFG.hookSecret) {
    const got = req.headers['x-cv-secret'];
    if (got !== CFG.hookSecret) {
      json(res, 401, { error: 'bad secret' });
      return;
    }
  }
  readBody(req, 64 * 1024).then((raw) => {
    let payload = {};
    try { payload = JSON.parse(raw || '{}'); } catch (_) {}
    const ev = normalizeEvent(payload);
    if (ev) {
      pushRecent(ev);
      broadcast({ type: 'event', event: ev });
      if (!ev.silent) sendLark(ev);   // 飞书推送（本机直推手机，best-effort）；静音事件不推手机
      log(`事件 [${ev.kind}] ${ev.project} — ${ev.speak}`);
    }
    json(res, 200, { ok: true, event: ev || null });
  }).catch((e) => json(res, 400, { error: String(e) }));
}

function normalizeEvent(payload) {
  const eventName = payload.hook_event_name || payload.hookEventName || '';
  const cwd = payload.cwd || payload.workspace || '';
  // hook.js 已在本机把 scratchpad / worktree / 子目录归到真正的项目；没有就退回 basename。
  const projectKey = (payload.cv_project || '').toString().trim() || baseName(cwd) || 'unknown';
  const proj = resolveProject(projectKey, cwd);   // {display, say, color, voice}
  const rawMsg = (payload.message || '').toString().trim();
  const U = CFG.userName;

  let kind, title, detail, tool = '';

  if (eventName === 'Stop') {
    kind = 'done';
    detail = payload.cv_preview || lastAssistantText(payload.transcript_path) || '本轮任务结束。';
    title = '任务完成';
  } else if (eventName === 'SubagentStop') {
    if (CFG.subagentMode === 'off') return null;   // 关掉就完全忽略
    kind = 'subagent';
    title = '子任务完成';
    detail = '一个子代理已完成。';
  } else if (eventName === 'Notification') {
    const low = rawMsg.toLowerCase();
    if (low.includes('waiting') || low.includes('idle')) {
      kind = 'waiting'; title = '等待你的输入';
      detail = rawMsg || 'Claude 正在等待你的输入。';
    } else if (low.includes('permission') || low.includes('approve') || low.includes('allow')) {
      kind = 'permission'; title = '需要你的授权'; tool = extractTool(rawMsg);
      detail = rawMsg || '需要你确认一个操作。';
    } else {
      kind = 'notification'; title = '通知';
      detail = rawMsg || '有新通知。';
    }
  } else {
    return null; // 其他/未知事件忽略
  }

  const v = assignVoice(projectKey, proj.voice);
  return {
    id: crypto.randomBytes(8).toString('hex'),
    ts: nowMs(),
    kind,
    needsAction: kind === 'waiting' || kind === 'permission',
    silent: kind === 'subagent' && CFG.subagentMode !== 'voice', // 默认静音：只显示不出声、不推送
    project: proj.display,                   // 屏幕显示（中文名）
    projectKey,
    cwd,
    color: proj.color || null,              // 没设就让前端按 projectKey hash 配色
    voice: v.name,                          // 按项目分配的音色
    gender: v.gender,                       // 'm' / 'f'，前端显示用
    style: buildStyle(kind),                // 随机语气 + 英文美式发音
    title,
    detail: clip(detail, 240),
    speak: buildSpeak(kind, U, proj.say, sayTool(tool), detail), // 语音念读音；完成时展开内容
    rawMessage: rawMsg,
    sessionId: payload.session_id || '',
  };
}

// 统一格式：中文名 + 敬称 + 目录名 + 任务状态 + 具体描述（模板在 shared/speech.cjs）
function buildSpeak(kind, U, proj, tool, detail) {
  if (kind === 'done') return buildDoneSpeak(U, proj, detail);
  return speech.buildAlertSpeak(kind, userAddresses(), proj, tool);
}

// 自托管这边没有 Workers AI，只能用规则式摘要（云端 worker.js 会先试 AI 总结再退回这条路）。
// 非中文不念内容，直接用中文定型句。
function buildDoneSpeak(U, proj, detail) {
  const text = detail || '';
  const sum = (text && text !== '本轮任务结束。' && isMostlyChinese(text)) ? pickSummary(text, 150) : '';
  if (!sum) return speech.doneFallback(userAddresses(), proj);
  return speech.doneWithSummary(userAddresses(), proj, sum);
}

// 读取 transcript（JSONL）尾部，取最后一条 assistant 文本
function lastAssistantText(transcriptPath) {
  if (!transcriptPath) return '';
  try {
    const tail = readTail(transcriptPath, 512 * 1024);
    const lines = tail.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let obj;
      try { obj = JSON.parse(lines[i]); } catch (_) { continue; }
      const role = obj.type || (obj.message && obj.message.role);
      if (role !== 'assistant') continue;
      const content = obj.message && obj.message.content;
      let text = '';
      if (typeof content === 'string') text = content;
      else if (Array.isArray(content)) {
        text = content.filter((c) => c && c.type === 'text').map((c) => c.text).join(' ');
      }
      text = (text || '').trim();
      if (text) return text;
    }
  } catch (_) {}
  return '';
}

// =================================================================
// SSE：把事件推给网页
// =================================================================
function handleEvents(req, res, u) {
  if (!checkToken(u, req)) { json(res, 401, { error: 'token required' }); return; }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.write('retry: 3000\n\n');
  sendSse(res, { type: 'hello', ts: nowMs() });
  sendSse(res, { type: 'history', events: recent.slice(-20) });

  sseClients.add(res);
  const ka = setInterval(() => { try { res.write(': ka\n\n'); } catch (_) {} }, 20000);
  req.on('close', () => { clearInterval(ka); sseClients.delete(res); });
}

function broadcast(obj) {
  for (const res of sseClients) sendSse(res, obj);
}
function sendSse(res, obj) {
  try { res.write(`data: ${JSON.stringify(obj)}\n\n`); } catch (_) {}
}

// =================================================================
// TTS 代理：Edge 免 key，失败重试后可回落到 Azure
// =================================================================
function handleTts(req, res, u) {
  const secOK = CFG.hookSecret && req.headers['x-cv-secret'] === CFG.hookSecret;
  if (!checkToken(u, req) && !secOK) { json(res, 401, { error: 'token required' }); return; }
  // Edge 免 key 即可发声；配置 Azure 后可作为兜底。

  readBody(req, 16 * 1024).then((raw) => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) {}
    const text = (body.text || '').toString().slice(0, 800);
    if (!text) { json(res, 400, { error: 'text 必填' }); return; }
    const voice = (body.voice || CFG.defaultVoice).toString();
    const style = (body.style || '').toString().slice(0, 200);
    const format = body.format === 'wav' ? 'wav' : 'mp3';

    const cacheKey = sha1([text, voice, style, format, CFG.ttsEngine].join('|'));
    const hit = ttsCache.get(cacheKey);
    if (hit) { sendAudio(res, hit.buf, format); return; }

    synthTTS({ text, voice, style, format }).then(({ buf }) => {
      cachePut(cacheKey, { buf, type: format });
      sendAudio(res, buf, format);
    }).catch((e) => {
      log('TTS 全部失败: ' + e.message);
      json(res, 502, { error: 'TTS 失败', detail: e.message });
    });
  }).catch((e) => json(res, 400, { error: String(e) }));
}

// 引擎调度固定为 edge →（配置了 key 才有）azure。
function ttsOrder() {
  return CFG.azureKey && CFG.azureRegion ? ['edge', 'azure'] : ['edge'];
}
async function synthTTS({ text, voice, style, format }) {
  let lastErr;
  for (const eng of ttsOrder()) {
    try {
      const buf = await retryTts(eng, async () => {
        if (eng === 'edge') return edge.synthEdge(text, voice, format);
        return synthAzure({ text, voice, format });
      });
      assertAudio(buf, eng);
      return { buf, engine: eng };
    } catch (e) { lastErr = e; log(`TTS ${eng} 失败(${e.message})，回落下一个`); }
  }
  throw lastErr || new Error('无可用 TTS 引擎');
}

async function retryTts(engine, synth) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const buf = await synth();
      assertAudio(buf, engine);
      return buf;
    } catch (error) {
      lastError = error;
      if (attempt === 2) break;
      const delay = 250 * (2 ** attempt);
      log(`TTS ${engine} 第 ${attempt + 1} 次失败(${error.message})，${delay}ms 后重试`);
      await sleep(delay);
    }
  }
  throw lastError || new Error(`${engine} 合成失败`);
}

function assertAudio(buf, engine) {
  if (!buf || typeof buf.length !== 'number' || buf.length === 0) {
    throw new Error(`${engine} 返回空音频`);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function escXml(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

// Azure 语音服务（与 edge 同一套语音名；纯 HTTPS POST，免费层每月 50 万字符）
function synthAzure({ text, voice, format }) {
  return new Promise((resolve, reject) => {
    const v = edge.resolveVoice(voice);
    const fmt = format === 'wav' ? 'riff-24khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3';
    const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='zh-CN'><voice name='${v}'>${escXml(text)}</voice></speak>`;
    const data = Buffer.from(ssml, 'utf8');
    const r = https.request({
      method: 'POST', hostname: `${CFG.azureRegion}.tts.speech.microsoft.com`, path: '/cognitiveservices/v1', port: 443,
      headers: { 'Content-Type': 'application/ssml+xml', 'X-Microsoft-OutputFormat': fmt, 'Ocp-Apim-Subscription-Key': CFG.azureKey, 'Content-Length': data.length, 'User-Agent': 'ClaudeVoice' },
    }, (resp) => {
      const ch = []; resp.on('data', (c) => ch.push(c));
      resp.on('end', () => {
        if (resp.statusCode !== 200) return reject(new Error('Azure ' + resp.statusCode + ': ' + clip(Buffer.concat(ch).toString('utf8'), 150)));
        resolve(Buffer.concat(ch));
      });
    });
    r.on('error', reject); r.setTimeout(30000, () => r.destroy(new Error('Azure 超时'))); r.write(data); r.end();
  });
}

function sendAudio(res, buf, format) {
  if (!buf || !buf.length) {
    json(res, 502, { error: 'TTS 失败', detail: '合成结果为空' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': format === 'wav' ? 'audio/wav' : 'audio/mpeg',
    'Content-Length': buf.length,
    'Cache-Control': 'public, max-age=86400',
  });
  res.end(buf);
}

function cachePut(key, val) {
  ttsCache.set(key, val);
  if (ttsCache.size > TTS_CACHE_MAX) {
    const first = ttsCache.keys().next().value;
    ttsCache.delete(first);
  }
}

// =================================================================
// /config 与首页
// =================================================================
function handleConfig(res) {
  // 无敏感信息（不含 key/secret），不做 token 限制
  json(res, 200, {
    voicePool: VOICE_POOL,
    defaultVoice: CFG.defaultVoice,
    model: 'edge-neural',
    userName: CFG.userName,
    requiresToken: !!CFG.dashToken,
    vapidPublic: '',   // 本地不开 Web Push（那是 Cloudflare Worker 部署才有）
    projects: PROJECTS,
  });
}

// 临时：把网页渲染好的音效保存为 mac-app 的 chime WAV
function serveFile(res, abspath, type) {
  fs.readFile(abspath, (err, buf) => {
    if (err) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store' });
    res.end(buf);
  });
}
function handleSaveCue(req, res) {
  readBody(req, 8 * 1024 * 1024).then((raw) => {
    let b = {};
    try { b = JSON.parse(raw); } catch (_) {}
    const dir = path.join(__dirname, 'mac-app');
    const saved = [];
    if (b.done) { fs.writeFileSync(path.join(dir, 'chime-done.wav'), Buffer.from(b.done, 'base64')); saved.push('done'); }
    if (b.alert) { fs.writeFileSync(path.join(dir, 'chime-alert.wav'), Buffer.from(b.alert, 'base64')); saved.push('alert'); }
    log('saved cue: ' + saved.join(','));
    json(res, 200, { ok: true, saved });
  }).catch((e) => json(res, 400, { error: String(e) }));
}

function serveStatic(res, name, type) {
  fs.readFile(path.join(__dirname, 'public', name), (err, buf) => {
    if (err) { json(res, 404, { error: 'not found' }); return; }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'public, max-age=3600' });
    res.end(buf);
  });
}

function serveIndex(res, u) {
  if (!checkToken(u, { headers: {} })) {
    res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<h1>需要访问令牌</h1><p>请在网址后加上 <code>?token=你的令牌</code></p>');
    return;
  }
  fs.readFile(INDEX_HTML, (err, buf) => {
    if (err) { json(res, 500, { error: 'index.html 缺失' }); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(buf);
  });
}

// =================================================================
// 工具函数
// =================================================================
function checkToken(u, req) {
  if (!CFG.dashToken) return true;
  const q = u.searchParams.get('token');
  const h = req && req.headers && req.headers['x-cv-token'];
  return q === CFG.dashToken || h === CFG.dashToken;
}

// 飞书推送：优先「自建应用机器人私信」(App ID/Secret + open_id)，否则用自定义机器人 webhook
let _larkTok = { token: '', exp: 0 };
function larkText(ev) {
  const icon = { done: '✅', waiting: '⏳', permission: '🔐', notification: '🔔', subagent: '🧩' }[ev.kind] || '🔔';
  let t = `${icon} ${ev.project} · ${ev.title}\n${ev.speak}`;
  if (ev.detail && ev.detail !== ev.title) t += `\n\n${ev.detail}`;
  return t;
}
// 飞书原生交互卡片（彩色标题栏 + 分隔 + 备注 + 可选按钮）
function larkCard(ev) {
  const KMAP = { done: { c: 'green', l: '已完成' }, waiting: { c: 'orange', l: '等待输入' }, permission: { c: 'red', l: '需要授权' }, notification: { c: 'blue', l: '通知' }, subagent: { c: 'violet', l: '子任务' } };
  const k = KMAP[ev.kind] || { c: 'blue', l: ev.kind };
  const icon = { done: '✅', waiting: '⏳', permission: '🔐', notification: '🔔', subagent: '🧩' }[ev.kind] || '🔔';
  const elements = [{ tag: 'div', text: { tag: 'lark_md', content: '**' + ev.speak + '**' } }];
  if (ev.detail && ev.detail !== ev.title) {
    elements.push({ tag: 'hr' });
    elements.push({ tag: 'div', text: { tag: 'lark_md', content: ev.detail } });
  }
  const t = new Date(ev.ts).toLocaleString('zh-CN', { hour12: false });
  const g = ev.gender === 'm' ? '♂' : (ev.gender === 'f' ? '♀' : '·');
  elements.push({ tag: 'note', elements: [{ tag: 'plain_text', content: `音色 ${g} ${ev.voice}　·　${t}` }] });
  if (CFG.dashUrl) {
    elements.push({ tag: 'action', actions: [{ tag: 'button', text: { tag: 'plain_text', content: '打开语音面板' }, url: CFG.dashUrl, type: 'primary' }] });
  }
  return { config: { wide_screen_mode: true }, header: { template: k.c, title: { tag: 'plain_text', content: `${icon} ${ev.project} · ${k.l}` } }, elements };
}
function larkPost(reqPath, headers, body) {
  try {
    const data = Buffer.from(body);
    const r = https.request({
      method: 'POST', hostname: 'open.feishu.cn', path: reqPath, port: 443,
      headers: Object.assign({ 'Content-Type': 'application/json', 'Content-Length': data.length }, headers || {}),
    }, (res) => { res.on('data', () => {}); res.on('end', () => {}); });
    r.on('error', () => {}); r.setTimeout(6000, () => r.destroy()); r.write(data); r.end();
  } catch (_) {}
}
function withLarkToken(cb) {
  const now = Date.now();
  if (_larkTok.token && now < _larkTok.exp) return cb(_larkTok.token);
  const data = Buffer.from(JSON.stringify({ app_id: CFG.larkAppId, app_secret: CFG.larkAppSecret }));
  const r = https.request({
    method: 'POST', hostname: 'open.feishu.cn', path: '/open-apis/auth/v3/tenant_access_token/internal',
    port: 443, headers: { 'Content-Type': 'application/json', 'Content-Length': data.length },
  }, (res) => {
    let b = ''; res.on('data', (c) => b += c); res.on('end', () => {
      try {
        const j = JSON.parse(b);
        if (j.tenant_access_token) { _larkTok = { token: j.tenant_access_token, exp: now + ((j.expire || 7200) - 120) * 1000 }; cb(_larkTok.token); }
        else cb('');
      } catch (_) { cb(''); }
    });
  });
  r.on('error', () => cb('')); r.setTimeout(6000, () => { r.destroy(); cb(''); }); r.write(data); r.end();
}
function sendLark(ev) {
  if (CFG.larkAppId && CFG.larkAppSecret && CFG.larkOpenId) {
    withLarkToken((tok) => {
      if (!tok) return;
      larkPost('/open-apis/im/v1/messages?receive_id_type=open_id', { Authorization: 'Bearer ' + tok },
        JSON.stringify({ receive_id: CFG.larkOpenId, msg_type: 'interactive', content: JSON.stringify(larkCard(ev)) }));
    });
    return;
  }
  if (CFG.larkWebhook) {
    const body = { msg_type: 'interactive', card: larkCard(ev) };
    if (CFG.larkSecret) {
      const ts = Math.floor(Date.now() / 1000).toString();
      body.timestamp = ts;
      body.sign = crypto.createHmac('sha256', ts + '\n' + CFG.larkSecret).update('').digest('base64');
    }
    try {
      const u = new URL(CFG.larkWebhook);
      const data = Buffer.from(JSON.stringify(body));
      const r = https.request({ method: 'POST', hostname: u.hostname, path: u.pathname + u.search, port: u.port || 443,
        headers: { 'Content-Type': 'application/json', 'Content-Length': data.length } },
        (res) => { res.on('data', () => {}); res.on('end', () => {}); });
      r.on('error', () => {}); r.setTimeout(6000, () => r.destroy()); r.write(data); r.end();
    } catch (_) {}
  }
}

function pushRecent(ev) {
  recent.push(ev);
  while (recent.length > RECENT_MAX) recent.shift();
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Error('body 过大')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function readTail(file, maxBytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - maxBytes);
    const len = size - start;
    const buf = Buffer.alloc(len);
    fs.readSync(fd, buf, 0, len, start);
    return buf.toString('utf8');
  } finally { fs.closeSync(fd); }
}

function json(res, code, obj) {
  const s = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(s);
}

function sha1(s) { return crypto.createHash('sha1').update(s).digest('hex'); }
function nowMs() { return Date.now(); }
function log(...a) { process.stdout.write('[' + new Date().toISOString() + '] ' + a.join(' ') + '\n'); }

function loadDotenv(file) {
  try {
    const txt = fs.readFileSync(file, 'utf8');
    for (const line of txt.split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  } catch (_) { /* .env 可选 */ }
}

function loadProjects(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return {}; }
}
