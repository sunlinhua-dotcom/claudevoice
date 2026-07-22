#!/usr/bin/env node
/**
 * ClaudeVoice hook — Claude Code 全局 hook 调用此脚本。
 *
 * Claude 会把事件 JSON 从 stdin 传进来（含 cwd / hook_event_name / message / transcript_path）。
 * 本脚本原样转发给 ClaudeVoice 服务，由服务解析并广播。
 *
 * 关键原则：永不阻塞、永不报错退出。服务挂了也不能拖住 Claude。
 */

'use strict';

// cc-bridge 自己启动的 headless Claude 会通过飞书管理状态，避免全局 hook 再发一份通知。
if (process.env.CC_BRIDGE === '1') process.exit(0);

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const { URL } = require('url');
const { spawn } = require('child_process');

// 读配置：优先环境变量，其次 ~/.claude/claudevoice.json
let url = process.env.CLAUDEVOICE_URL || '';
let secret = process.env.CLAUDEVOICE_SECRET || '';
try {
  const cfgPath = path.join(os.homedir(), '.claude', 'claudevoice.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  url = url || cfg.url;
  secret = secret || cfg.secret || '';
} catch (_) {}
url = url || 'http://127.0.0.1:8787/hook';

// 读 stdin
let raw = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (c) => { raw += c; });
process.stdin.on('end', () => forward(raw));
// 兜底：stdin 没数据时也别卡死
setTimeout(() => { if (!raw) forward('{}'); }, 1500);

function forward(body) {
  // hook_event_name 兜底用 argv；Mac 端读 transcript 末句带上（Worker 读不到本机文件）。
  // 关键：末句若是英文，在本机（能访问 Google）翻成中文再发——Worker 那边 Cloudflare IP 会被 Google 429。
  let obj;
  try { obj = JSON.parse(body || '{}'); } catch (_) { return postBody(body); }
  if (!obj.hook_event_name && process.argv[2]) obj.hook_event_name = process.argv[2];
  try { nativeNotify(obj); } catch (_) {}   // Mac 原生横幅提醒（视觉）

  if (obj.hook_event_name === 'Stop' && obj.transcript_path && !obj.cv_preview) {
    const prev = lastAssistantText(obj.transcript_path);
    if (prev) {
      if (isMostlyChinese(prev)) {
        obj.cv_preview = prev.slice(0, 520);
        return postBody(JSON.stringify(obj));
      }
      return translateToZh(prev.slice(0, 1500), (zh) => {   // 英文末句 → 本机翻成中文
        obj.cv_preview = (zh && isMostlyChinese(zh) ? zh : prev).slice(0, 520);
        postBody(JSON.stringify(obj));
      });
    }
  }
  postBody(JSON.stringify(obj));
}

// 中文为主判定 + 免 key Google 翻译（本机可访问；失败回调空串，调用方退回原文）
function isMostlyChinese(s) {
  const cjk = (String(s).match(/[一-鿿]/g) || []).length;
  const latin = (String(s).match(/[A-Za-z]/g) || []).length;
  return cjk >= Math.max(4, latin);
}
function translateToZh(text, cb) {
  let done = false;
  const finish = (v) => { if (done) return; done = true; cb(v); };
  try {
    const u = new URL('https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=zh-CN&dt=t&q=' + encodeURIComponent(text));
    const r = https.request({ method: 'GET', hostname: u.hostname, path: u.pathname + u.search, port: 443, headers: { 'User-Agent': 'Mozilla/5.0' } }, (resp) => {
      const ch = [];
      resp.on('data', (c) => ch.push(c));
      resp.on('end', () => {
        try {
          const j = JSON.parse(Buffer.concat(ch).toString('utf8'));
          if (Array.isArray(j) && Array.isArray(j[0])) return finish(j[0].map((s) => (s && s[0]) || '').join('').trim());
        } catch (_) {}
        finish('');
      });
    });
    r.on('error', () => finish(''));
    r.setTimeout(4000, () => { r.destroy(); finish(''); });
    r.end();
  } catch (_) { finish(''); }
}

function postBody(body) {
  let target;
  try { target = new URL(url); } catch (_) { process.exit(0); }
  const lib = target.protocol === 'https:' ? https : http;
  const data = Buffer.from(body, 'utf8');
  const req = lib.request({
    method: 'POST',
    hostname: target.hostname,
    port: target.port || (target.protocol === 'https:' ? 443 : 80),
    path: target.pathname + target.search,
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': data.length,
      'X-CV-Secret': secret,
    },
  }, (res) => {
    let b = '';
    res.on('data', (c) => { b += c; });
    res.on('end', () => {
      try {
        if (process.env.CLAUDEVOICE_VOICE !== '0') {
          const j = JSON.parse(b || '{}');
          if (j && j.event) enqueueDesktop(j.event);
        }
      } catch (_) {}
      process.exit(0);
    });
  });

  req.on('error', () => process.exit(0));
  req.setTimeout(8000, () => { req.destroy(); process.exit(0); });
  req.write(data);
  req.end();
}

// 写入本地播放队列（菜单栏 App 顺序读取播放）。写文件永远成功、不依赖长连接。
function enqueueDesktop(ev) {
  if (!ev || !ev.speak || ev.silent) return;   // 静音事件（子任务）不进桌面播放队列
  try {
    const dir = path.join(os.homedir(), '.claude', 'cv-queue');
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, Date.now() + '_' + Math.floor(Math.random() * 1e6) + '.json');
    fs.writeFileSync(f, JSON.stringify(ev));
  } catch (_) {}
}

// Mac 原生通知中心横幅（不依赖浏览器的视觉提醒）。设 CLAUDEVOICE_NATIVE=0 可关。
function nativeNotify(obj) {
  if (process.platform !== 'darwin') return;
  if (process.env.CLAUDEVOICE_NATIVE === '0') return;
  if (obj && obj.hook_event_name === 'SubagentStop') return;  // 子任务默认静音，不弹原生横幅
  const proj = humanize(baseName((obj.cwd || '').toString())) || '项目';
  const ev = obj.hook_event_name || '';
  const msg = (obj.message || '').toString().toLowerCase();
  let line = '🔔 有新信号', sound = 'Glass';
  if (ev === 'Stop') { line = '✅ 已完成，回来看看'; sound = 'Glass'; }
  else if (ev === 'Notification' && (msg.includes('waiting') || msg.includes('idle'))) { line = '⏳ 正在等你输入'; sound = 'Funk'; }
  else if (ev === 'Notification' && (msg.includes('permission') || msg.includes('approve') || msg.includes('allow'))) { line = '🔐 需要你授权'; sound = 'Funk'; }
  const esc = (s) => s.toString().replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/[\r\n]+/g, ' ');
  const script = `display notification "${esc(line)}" with title "ClaudeVoice" subtitle "${esc(proj)}" sound name "${esc(sound)}"`;
  try {
    const c = spawn('osascript', ['-e', script], { detached: true, stdio: 'ignore' });
    c.on('error', () => {}); c.unref();
  } catch (_) {}
}

// 文件夹名拆词（与 server.js humanizeName 同）
function humanize(key) {
  return (key || '')
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim() || key;
}
function baseName(p) { return p ? p.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop() : ''; }

// 读 transcript（JSONL）尾部，取最后一条 assistant 文本（与 server.js 同逻辑）
function lastAssistantText(p) {
  try {
    const fd = fs.openSync(p, 'r');
    let txt;
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - 512 * 1024);
      const buf = Buffer.alloc(size - start);
      fs.readSync(fd, buf, 0, buf.length, start);
      txt = buf.toString('utf8');
    } finally { fs.closeSync(fd); }
    const lines = txt.split('\n').filter(Boolean);
    for (let i = lines.length - 1; i >= 0; i--) {
      let o; try { o = JSON.parse(lines[i]); } catch (_) { continue; }
      const role = o.type || (o.message && o.message.role);
      if (role !== 'assistant') continue;
      const c = o.message && o.message.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c)) t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
      t = (t || '').trim();
      if (t) return t;
    }
  } catch (_) {}
  return '';
}
