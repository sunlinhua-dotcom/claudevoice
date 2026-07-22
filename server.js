#!/usr/bin/env node
/**
 * ClaudeVoice — 全局语音通知服务
 *
 * 职责：
 *  1. 接收 Claude Code 全局 hook 推来的事件 (POST /hook)
 *  2. 通过 SSE 把事件实时推给所有打开的网页 (GET /events)
 *  3. 代理小米 MiMo TTS 合成语音，API key 只留在服务端 (POST /tts)
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

// ---------- 配置 ----------
loadDotenv(path.join(__dirname, '.env'));

const CFG = {
  host: process.env.HOST || '0.0.0.0',
  port: parseInt(process.env.PORT || '8787', 10),
  mimoKey: process.env.MIMO_API_KEY || '',
  mimoBase: (process.env.MIMO_BASE || 'https://api.xiaomimimo.com/v1').replace(/\/$/, ''),
  mimoModel: process.env.MIMO_MODEL || 'mimo-v2-tts',
  mimoVoice: process.env.MIMO_VOICE || 'mimo_default',
  ttsEngine: (process.env.TTS_ENGINE || 'edge').toLowerCase(), // 首选引擎：edge(默认,免key) / azure / mimo
  azureKey: process.env.AZURE_SPEECH_KEY || '',                // Azure 兜底（可选，免费层每月 50 万字符）
  azureRegion: process.env.AZURE_SPEECH_REGION || '',          // 如 eastasia / eastus
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

// v2.5-tts 的内置音色（男女分组）。每个项目按名字 hash 稳定分到一个；
// projects.json 里可用 "voice" 覆盖。英文名音色(Mia/Chloe/Milo/Dean)英文发音更好。
// 只用中文音色（英文音色 Dean/Mia/Chloe/Milo 读中文会变乱码）。保留男女区分。
const VOICE_POOL = [
  { name: '茉莉', gender: 'f' }, { name: '白桦', gender: 'm' },
  { name: '冰糖', gender: 'f' }, { name: '苏打', gender: 'm' },
];
const VOICE_GENDER = VOICE_POOL.reduce((m, v) => (m[v.name] = v.gender, m), {});

// 播报里跟在名字后的尊称，每次随机抽一个（都是对老板的不同叫法）。
const HONORIFICS = [
  '老板', '老大', '老总', '大老板', '我的老板',
  '老板大人', '尊敬的老板', '老板中的老板', '头儿', '领导',
  '一把手', '董事长', '总裁', '掌柜的', '东家',
  '当家的', '当家人', '我们老大', '我的顶头上司', '话事人',
];

// 用户认可的几种称呼：主名 userName + 备用别名 userAliases，每次随机抽一个当开头。
function userAddresses() {
  return [CFG.userName, ...CFG.userAliases];
}

const PROJECTS = loadProjects(path.join(__dirname, 'projects.json'));

// 内置「中文名 + TTS 读音」种子（我的判断；projects.json 可覆盖）。
// name = 屏幕显示；say = 语音实际念的读音。
const DEFAULT_PROJECTS = {
  CLAUDEVOICE: { name: '语音通知台', say: 'Claude Voice' },
  autoresearch: { name: '自动研究', say: 'Auto Research' },
  'my-web-app': { name: '我的网站', say: 'My Web App' },
  'api-service': { name: '接口服务', say: 'API Service' },
  'docs-site': { name: '文档站', say: 'Docs Site' },
};

// 把文件夹名拆成可读形式：驼峰 / 全大写缩写 / 下划线连字符 / 字母数字边界 都加空格
function humanizeName(key) {
  return (key || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim() || key;
}
// 工具名也拆驼峰，方便英文读对：WebFetch → Web Fetch
function sayTool(t) { return humanizeName(t || ''); }
// 解析项目：手工覆盖 > 种子 > 机械拆词
function resolveProject(projectKey, cwd) {
  const o = PROJECTS[projectKey] || PROJECTS[cwd] || DEFAULT_PROJECTS[projectKey] || {};
  return {
    display: o.name || humanizeName(projectKey),
    say: o.say || o.name || humanizeName(projectKey),
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
  log(`  MiMo TTS:   ${CFG.mimoKey ? CFG.mimoModel + ' / ' + CFG.mimoVoice : '⚠ 未配置 MIMO_API_KEY'}`);
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
  const projectKey = baseName(cwd) || 'unknown';
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

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }

function assignVoice(projectKey, override) {
  if (override) return { name: override, gender: VOICE_GENDER[override] || 'f' };
  return VOICE_POOL[hashStr(projectKey) % VOICE_POOL.length];
}

// 统一格式：中文名 + 敬称 + 目录名 + 任务状态 + 具体描述
function buildSpeak(kind, U, proj, tool, detail) {
  if (kind === 'done') return buildDoneSpeak(U, proj, detail);
  const g = `${pick(userAddresses())}，${pick(HONORIFICS)}，`;
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
// 中文为主判定（翻译已在 hook.js / Mac 端完成；这里仅兜底，非中文不念内容、用中文定型句）
function isMostlyChinese(s) {
  const cjk = (String(s).match(/[一-鿿]/g) || []).length;
  const latin = (String(s).match(/[A-Za-z]/g) || []).length;
  return cjk >= Math.max(4, latin);
}
function buildDoneSpeak(U, proj, detail) {
  const g = `${pick(userAddresses())}，${pick(HONORIFICS)}，`;
  const text = detail || '';
  const sum = (text && text !== '本轮任务结束。' && isMostlyChinese(text)) ? pickSummary(text, 150) : '';
  if (!sum || detail === '本轮任务结束。') {
    return pick([
      `${g}目录 ${proj} 的任务已经完成，回来看看结果吧。`,
      `${g}${proj} 这一轮完成了，记得验收。`,
    ]);
  }
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
  if (!out) { // 第一句就超长：截到最后一个标点，补句号正常收尾
    const s = sents[0].slice(0, maxLen);
    const lp = Math.max(s.lastIndexOf('，'), s.lastIndexOf('。'), s.lastIndexOf('、'), s.lastIndexOf('；'));
    out = (lp > maxLen * 0.5 ? s.slice(0, lp) : s) + '。';
  }
  const dec = sents.find((s) => DECISION_RE.test(s)); // 需要你定夺的那句通常在结尾，确保念到
  if (dec && out.indexOf(dec) < 0 && out.length + dec.length <= maxLen + 80) out += dec;
  return out;
}
function capSpeech(s, n) {
  s = (s || '').trim(); if (s.length <= n) return s;
  const c = s.slice(0, n);
  const lp = Math.max(c.lastIndexOf('。'), c.lastIndexOf('！'), c.lastIndexOf('？'), c.lastIndexOf('，'));
  return (lp > n * 0.5 ? c.slice(0, lp + 1) : c) + '……';
}

// 把总结清洗成适合朗读的纯文本，按句子边界裁到 maxLen
function cleanForSpeech(text, maxLen) {
  let s = (text || '').toString()
    .replace(/```[\s\S]*?```/g, ' ')      // 去代码块
    .replace(/`[^`]*`/g, ' ')             // 去行内代码
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1') // 链接/图片留文字
    .replace(/[*_#>~|]/g, ' ')            // 去 markdown 记号
    .replace(/^[\s\-•\d.]+/gm, '')        // 去列表/序号前缀
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lastPunc = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'), cut.lastIndexOf('，'));
  return (lastPunc > maxLen * 0.5 ? cut.slice(0, lastPunc + 1) : cut) + '……';
}

function buildStyle(kind) {
  // 保持简短：TTS 的风格指令越短越干净，过长会被模型当成内容念进去导致乱码
  const tones = ['语气自然亲切。', '语气干练利落。', '温柔地提醒。', '沉稳地说。', '稍微轻快一点。', '带一点期待。'];
  return pick(tones);
}

function extractTool(msg) {
  // "Claude needs your permission to use Bash" → "Bash"
  const m = /use\s+([A-Za-z0-9_\- ]+?)(?:[\.\(]|$)/i.exec(msg);
  return m ? m[1].trim() : '';
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
// TTS 代理：调用 MiMo，返回音频字节（key 不出服务端）
// =================================================================
function handleTts(req, res, u) {
  const secOK = CFG.hookSecret && req.headers['x-cv-secret'] === CFG.hookSecret;
  if (!checkToken(u, req) && !secOK) { json(res, 401, { error: 'token required' }); return; }
  // 不再强依赖 MIMO key：首选 edge-tts 免 key 即可发声

  readBody(req, 16 * 1024).then((raw) => {
    let body = {};
    try { body = JSON.parse(raw || '{}'); } catch (_) {}
    const text = (body.text || '').toString().slice(0, 800);
    if (!text) { json(res, 400, { error: 'text 必填' }); return; }
    const voice = (body.voice || CFG.mimoVoice).toString();
    const style = (body.style || '').toString().slice(0, 200);
    const format = body.format === 'wav' ? 'wav' : 'mp3';

    const cacheKey = sha1([text, voice, style, format, CFG.ttsEngine, CFG.mimoModel].join('|'));
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

// 引擎调度：按 [首选, edge, azure, mimo] 顺序，只用已配置可用的，失败自动回落
function ttsOrder() {
  const have = { edge: true, azure: !!(CFG.azureKey && CFG.azureRegion), mimo: !!CFG.mimoKey };
  const order = [CFG.ttsEngine, 'edge', 'azure', 'mimo'].filter((e, i, a) => a.indexOf(e) === i && have[e]);
  return order.length ? order : ['edge'];
}
async function synthTTS({ text, voice, style, format }) {
  let lastErr;
  for (const eng of ttsOrder()) {
    try {
      if (eng === 'edge') return { buf: await edge.synthEdge(text, voice, format), engine: 'edge' };
      if (eng === 'azure') return { buf: await synthAzure({ text, voice, format }), engine: 'azure' };
      if (eng === 'mimo') return { buf: await synthMimo({ text, voice, style, format }), engine: 'mimo' };
    } catch (e) { lastErr = e; log(`TTS ${eng} 失败(${e.message})，回落下一个`); }
  }
  throw lastErr || new Error('无可用 TTS 引擎');
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

function synthMimo({ text, voice, style, format }) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify({
      model: CFG.mimoModel,
      messages: [
        { role: 'user', content: style || '' },
        { role: 'assistant', content: text },
      ],
      audio: { format, voice },
    });
    const target = new URL(CFG.mimoBase + '/chat/completions');
    const opts = {
      method: 'POST',
      hostname: target.hostname,
      path: target.pathname + target.search,
      port: target.port || 443,
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + CFG.mimoKey,
        'Content-Length': Buffer.byteLength(payload),
      },
    };
    const r = https.request(opts, (resp) => {
      const chunks = [];
      resp.on('data', (c) => chunks.push(c));
      resp.on('end', () => {
        const txt = Buffer.concat(chunks).toString('utf8');
        if (resp.statusCode !== 200) {
          return reject(new Error(`MiMo ${resp.statusCode}: ${clip(txt, 200)}`));
        }
        let data;
        try { data = JSON.parse(txt); } catch (e) { return reject(new Error('返回非 JSON')); }
        const b64 = data && data.choices && data.choices[0] &&
          data.choices[0].message && data.choices[0].message.audio &&
          data.choices[0].message.audio.data;
        if (!b64) return reject(new Error('返回缺少 audio.data'));
        resolve(Buffer.from(b64, 'base64'));
      });
    });
    r.on('error', reject);
    r.setTimeout(60000, () => r.destroy(new Error('MiMo 超时')));
    r.write(payload);
    r.end();
  });
}

function sendAudio(res, buf, format) {
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
    defaultVoice: CFG.mimoVoice,
    model: CFG.mimoModel,
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

function baseName(p) {
  if (!p) return '';
  return p.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop();
}
function clip(s, n) { s = (s || '').toString(); return s.length > n ? s.slice(0, n) + '…' : s; }
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
