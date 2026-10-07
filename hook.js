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
// 名字读法 / 中文判定这类纯逻辑与 server.js、cloudflare/src/worker.js 共用一份（shared/speech.cjs），
// 免得同一套规则在三个文件里各漂各的。
const { isMostlyChinese, humanizeName: humanize, baseName } = require('./shared/speech.cjs');
const { URL } = require('url');
const { spawn } = require('child_process');

// 读配置：优先环境变量，其次 ~/.claude/claudevoice.json
let url = process.env.CLAUDEVOICE_URL || '';
let secret = process.env.CLAUDEVOICE_SECRET || '';
// 项目根目录清单：cwd 落在某个根下时，取「根的下一层」当项目名（子目录不再各自算一个项目）。
// 支持在 ~/.claude/claudevoice.json 里用 projectRoots 配置；最长前缀优先。
let projectRoots = [os.homedir(), path.join(os.homedir(), 'Desktop')];
let cfgWebUrl = '';   // 可选：claudevoice.json 的 webUrl（CloudCLI 网页地址），环境变量 CC_WEB_URL 优先
try {
  const cfgPath = path.join(os.homedir(), '.claude', 'claudevoice.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  url = url || cfg.url;
  secret = secret || cfg.secret || '';
  if (Array.isArray(cfg.projectRoots) && cfg.projectRoots.length) projectRoots = cfg.projectRoots.slice();
  if (typeof cfg.webUrl === 'string') cfgWebUrl = cfg.webUrl;
} catch (_) {}
url = url || 'http://127.0.0.1:8787/hook';

// 读 stdin
// 两种运行模式（同一个脚本）：
//   主进程（Claude Code 同步调起）：读 stdin → 本地过滤 / 判断 / 弹横幅 / iMessage 深链 →
//     把「翻译 + POST + 读回包 + enqueueDesktop」整包交给脱离的子进程 → 立刻 exit(0)。
//   子进程（argv[2] === --cv-detached）：自己重新读配置拿 URL 和 secret，从 stdin 管道收 job，
//     做完网络活后退出。secret 不进 argv / 环境变量 / 日志 / 临时文件。
const DETACHED_FLAG = '--cv-detached';
const MAIN_NET_TIMEOUT = 8000;       // 子进程起不来、退回进程内直发时沿用的旧超时
const DETACHED_NET_TIMEOUT = 20000;  // 脱离后没人在等，网络超时放宽

if (process.argv[2] === DETACHED_FLAG) runDetached();
else {
  let forwarded = false;
  const once = (b) => { if (forwarded) return; forwarded = true; forward(b); };
  let raw = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { raw += c; });
  process.stdin.on('end', () => once(raw));
  process.stdin.on('error', () => once(raw));
  // 兜底：stdin 没数据时也别卡死
  setTimeout(() => { if (!raw) once('{}'); }, 1500);
}

function forward(body) {
  // hook_event_name 兜底用 argv；Mac 端读 transcript 末句带上（Worker 读不到本机文件）。
  // 关键：末句若是英文，要翻成中文再发（本机能访问 Google，Worker 那边 Cloudflare IP 会被 Google 429）；
  // 翻译是网络活，和 POST 一起交给脱离的子进程做，主进程不等。
  let obj;
  try { obj = JSON.parse(body || '{}'); } catch (_) { return dispatch({ body }); }
  // 主人 的通知口径（2026-08-30）：CloudCLI 网页会话不往飞书推卡（人在网页前，卡是噪音），
  // 桌面/其他会话照推；CLAUDEVOICE_LARK=1 强制恢复推送。
  if (process.env.CLAUDEVOICE_LARK === '1') delete obj.noLark;
  else if (fromCloudCliSession()) obj.noLark = true;
  if (!obj.hook_event_name && process.argv[2]) obj.hook_event_name = process.argv[2];
  try { obj.cv_project = resolveProjectKey(obj.cwd); } catch (_) {}   // 真正的项目名（本机能读文件系统，服务端读不到）
  try { nativeNotify(obj); } catch (_) {}   // Mac 原生横幅提醒（视觉）
  try { imsgNotify(obj); } catch (_) {}     // iMessage 完成深链（手机直达会话，与云端链路互不影响）

  if (obj.hook_event_name === 'Stop' && obj.transcript_path && !obj.cv_preview) {
    const prev = lastAssistantText(obj.transcript_path);
    if (prev) {
      if (isMostlyChinese(prev)) {
        obj.cv_preview = prev.slice(0, 520);
        return dispatch({ body: JSON.stringify(obj) });
      }
      // 英文末句：子进程翻成中文后写进 cv_preview（失败退回原文），这里不等
      return dispatch({ body: JSON.stringify(obj), tr: prev.slice(0, 1500) });
    }
  }
  dispatch({ body: JSON.stringify(obj) });
}

// 把 job（{ body, tr? }）交给脱离的子进程：detached + stdio 不继承 + unref，job 走 stdin 管道，
// 管道写完主进程立刻退出。子进程起不来（spawn 抛错 / error 事件）才退回进程内直发，保证旧行为不丢。
function dispatch(job) {
  let settled = false;
  let guard = null;
  const inline = () => {
    if (settled) return;
    settled = true;
    if (guard) clearTimeout(guard);
    runJob(job, MAIN_NET_TIMEOUT, () => process.exit(0));
  };
  try {
    const child = spawn(process.execPath, [__filename, DETACHED_FLAG], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],   // stdout/stderr 不继承：否则 Claude Code 会等到子进程关掉管道
      windowsHide: true,
    });
    child.on('error', inline);
    child.unref();
    child.stdin.on('error', () => {});       // 子进程提前死了会 EPIPE，吞掉
    child.stdin.end(JSON.stringify(job), () => {
      if (settled) return;
      settled = true;
      process.exit(0);
    });
    // 超大 payload（> 管道缓冲）要等子进程读走；子进程卡住也最多再等 3 秒，永不拖住 Claude
    guard = setTimeout(() => { settled = true; process.exit(0); }, 3000);
  } catch (_) { inline(); }
}

// 子进程入口：从 stdin 收 job → 做网络活 → 退出。没有任何输出，也不写日志。
function runDetached() {
  let buf = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', (c) => { buf += c; });
  process.stdin.on('error', () => process.exit(0));
  process.stdin.on('end', () => {
    let job;
    try { job = JSON.parse(buf); } catch (_) { process.exit(0); }
    runJob(job, DETACHED_NET_TIMEOUT, () => process.exit(0));
  });
  setTimeout(() => process.exit(0), DETACHED_NET_TIMEOUT + 10000);   // 总上限：翻译 + POST 都挂死也自己退
}

// 翻译（若需要）→ POST → 读回包 → enqueueDesktop。done 恰好调用一次。
function runJob(job, timeoutMs, done) {
  try {
    if (!job || typeof job.body !== 'string') return done();
    if (!job.tr) return postBody(job.body, timeoutMs, done);
    return translateToZh(job.tr, (zh) => {
      let out = job.body;
      try {
        const o = JSON.parse(job.body);
        o.cv_preview = (zh && isMostlyChinese(zh) ? zh : job.tr).slice(0, 520);
        out = JSON.stringify(o);
      } catch (_) {}
      postBody(out, timeoutMs, done);
    });
  } catch (_) { done(); }
}

// 中文为主判定 + 免 key Google 翻译（本机可访问；失败回调空串，调用方退回原文）
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

function postBody(body, timeoutMs, done) {
  let called = false;
  const finish = () => { if (called) return; called = true; done(); };
  let target;
  try { target = new URL(url); } catch (_) { return finish(); }
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
      finish();
    });
    res.on('error', finish);
  });

  req.on('error', finish);
  req.setTimeout(timeoutMs, () => { req.destroy(); finish(); });
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
  const key = obj.cv_project || resolveProjectKey(obj.cwd);
  const proj = (NAMES[key] && NAMES[key].name) || humanize(key) || '项目';
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

// ---------- 长任务完成通知（可选；CLAUDEVOICE_IMSG_BIN 指向你自己的发信程序，例如 iMessage / ntfy 包装）----------
// 仅 Stop（完成/失败）发；等审批、子任务、其他事件一律不打扰。与云端通知完全独立：
// 耗时算不出来 / imsg 不存在 / 发送失败全部静默吞掉，绝不能拖垮或挡住原链路。
// CLAUDEVOICE_IMSG=0 关闭；CLAUDEVOICE_IMSG_MIN_SECS 调耗时门槛（默认 120 秒）。
function imsgNotify(obj) {
  try {
    if (process.env.CLAUDEVOICE_IMSG === '0') return;
    if (!obj || obj.hook_event_name !== 'Stop') return;
    if (!obj.transcript_path || !obj.session_id) return;
    const turn = readTurnInfo(obj.transcript_path);
    if (!turn) return;   // 起点/耗时算不出来：宁静默不发
    const rawMin = Number(process.env.CLAUDEVOICE_IMSG_MIN_SECS);
    const minSecs = Number.isFinite(rawMin) && rawMin >= 0 ? rawMin : 120;
    const elapsed = (Date.now() - turn.startTs) / 1000;
    if (elapsed < minSecs) return;
    const key = obj.cv_project || resolveProjectKey(obj.cwd);
    const proj = (NAMES[key] && NAMES[key].name) || humanize(key) || '项目';
    // 深链基址与 bridge/cloudcli.mjs 同规则（去尾斜杠），但保持零依赖不 import
    // 没配网页地址（环境变量 CC_WEB_URL 或 claudevoice.json 的 webUrl）就不带链接；环境变量设成空串也表示关闭
    const rawBase = process.env.CC_WEB_URL !== undefined ? process.env.CC_WEB_URL : cfgWebUrl;
    const base = /^https?:\/\//i.test(String(rawBase || '').trim()) ? String(rawBase).trim().replace(/\/+$/, '') : '';
    const brief = turn.text.replace(/[\r\n]+/g, ' ').trim().slice(0, 80);
    const mins = Math.max(1, Math.round(elapsed / 60));
    const line = `「${proj}」${turn.failed ? '失败了' : '跑完了'}（约${mins}分钟）：${brief}${base ? ` ${base}/session/${obj.session_id}` : ''}`;
    const bin = process.env.CLAUDEVOICE_IMSG_BIN;   // 自选的通知程序（argv[1] = 一行文字）；没配就不发
    if (!bin) return;
    const c = spawn(bin, [line], { detached: true, stdio: 'ignore' });
    c.on('error', () => {});
    c.unref();
  } catch (_) {}
}

// 从 transcript 尾部读「本轮」信息：起点 = 最后一条真正的用户消息（跳过 tool_result 回传与
// isMeta 命令行，否则工具结果会把耗时算成几秒钟）；摘要 = 最后一条 assistant 文本，
// 该条带 isApiErrorMessage 时按失败口径发。任何一步不成立都返回 null（调用方不发）。
function readTurnInfo(p) {
  const lines = tailLines(p);
  if (!lines) return null;
  let startTs = 0, text = '', failed = false;
  for (let i = lines.length - 1; i >= 0; i--) {
    let o; try { o = JSON.parse(lines[i]); } catch (_) { continue; }
    if (!o || o.isMeta) continue;
    if (!startTs && isUserPrompt(o)) {
      const t = Date.parse(o.timestamp || '');
      if (!Number.isFinite(t) || t <= 0) return null;   // 最后的用户消息没时间戳 → 耗时算不出
      startTs = t;
    }
    const role = o.type || (o.message && o.message.role);
    if (!text && role === 'assistant') {
      const c = o.message && o.message.content;
      let t = '';
      if (typeof c === 'string') t = c;
      else if (Array.isArray(c)) t = c.filter((x) => x && x.type === 'text').map((x) => x.text).join(' ');
      t = (t || '').trim();
      if (t) {
        text = t;
        failed = Boolean(o.isApiErrorMessage || (o.message && o.message.isApiErrorMessage));
      }
    }
    if (startTs && text) break;
  }
  return startTs ? { startTs, text, failed } : null;
}

// 真正的用户输入：有文本内容，且不是 tool_result 回传（工具结果也是 type=user，会把起点顶到最后）
function isUserPrompt(o) {
  const role = o.type || (o.message && o.message.role);
  if (role !== 'user') return false;
  const c = o.message && o.message.content;
  if (typeof c === 'string') return c.trim().length > 0;
  if (Array.isArray(c)) {
    if (c.some((x) => x && x.type === 'tool_result')) return false;
    return c.some((x) => x && x.type === 'text' && String(x.text).trim());
  }
  return false;
}

// 读音 / 显示名表（与 Worker 共用同一份 names.json，横幅显示中文名用）
const NAMES = (() => {
  try {
    const t = JSON.parse(fs.readFileSync(path.join(__dirname, 'names.json'), 'utf8'));
    const m = {};
    for (const k of Object.keys(t)) if (k[0] !== '_') m[k.toLowerCase()] = t[k];
    return new Proxy(m, { get: (o, k) => (typeof k === 'string' ? o[k.toLowerCase()] : undefined) });
  } catch (_) { return {}; }
})();

// ---------- 项目名解析 ----------
// cwd 的最后一段常常不是项目：scratchpad 临时目录、git worktree 代号、仓库子目录都会被误当成项目。
// 顺序：scratchpad 还原 → worktree 回溯 → projectRoots 下一层 → 标记文件向上找 → basename 兜底。
const PROJECT_MARKERS = ['.git', 'CLAUDE.md', '.claude', 'package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod'];

// 判定本会话是否由 CloudCLI 网页驾驶舱拉起：网页会话的父进程链上必有
// CloudCLI 服务进程（node dist-server/server/index.js）。桌面终端里跑的 claude 没有。
// CLAUDEVOICE_ORIGIN=web|desktop 可强制指定（测试与逃生用）。判定失败一律当桌面（宁推勿漏）。
function fromCloudCliSession() {
  const forced = (process.env.CLAUDEVOICE_ORIGIN || '').toLowerCase();
  if (forced === 'web') return true;
  if (forced === 'desktop') return false;
  try {
    const { execSync } = require('child_process');
    let pid = process.ppid;
    for (let i = 0; i < 8 && pid > 1; i++) {
      const line = execSync(`ps -o ppid=,command= -p ${pid}`, { timeout: 1000 }).toString();
      const m = /^\s*(\d+)\s+([\s\S]*)$/.exec(line);
      if (!m) break;
      if (m[2].includes('dist-server/server/index.js')) return true;
      pid = Number(m[1]);
    }
  } catch (_) {}
  return false;
}

function resolveProjectKey(cwdRaw) {
  let cwd = (cwdRaw || '').toString().replace(/[\/\\]+$/, '');
  if (!cwd) return 'unknown';

  // 1) Claude Code 的 scratchpad：/private/tmp/claude-<uid>/<编码过的项目路径>/<session>/scratchpad[/...]
  //    编码把 '/' 和空格都换成了 '-'，直接解码有歧义，所以拿真实目录逐段贪婪匹配还原。
  const sp = /^(?:\/private)?\/tmp\/claude-[^\/]*\/([^\/]+)\//.exec(cwd + '/');
  if (sp && sp[1].indexOf('-') === 0) {
    const real = decodeClaudePath(sp[1]);
    if (real) return resolveProjectKey(real);
  }

  // 2) git worktree：<项目>/.claude-worktrees/<随机代号> → 回到 <项目>
  const wt = cwd.indexOf('/.claude-worktrees/');
  if (wt > 0) return resolveProjectKey(cwd.slice(0, wt));

  // 3) 项目根清单：取「根的下一层」；最长前缀优先，这样 .../longterm 能盖住 .../
  let best = '';
  for (const r of projectRoots) {
    const root = (r || '').toString().replace(/[\/\\]+$/, '');
    if (!root) continue;
    if ((cwd + '/').indexOf(root + '/') === 0 && root.length > best.length) best = root;
  }
  if (best) {
    const rest = cwd.slice(best.length + 1);
    if (rest) return rest.split('/')[0];
  }

  // 4) 向上找标记文件，取「最高」的那个（子包有 package.json 也不会盖过仓库根）
  let hit = '';
  let cur = cwd;
  const stopAt = path.parse(cwd).root;
  for (let i = 0; i < 8 && cur && cur !== stopAt; i++) {
    for (const m of PROJECT_MARKERS) {
      try { if (fs.existsSync(path.join(cur, m))) { hit = cur; break; } } catch (_) {}
    }
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  if (hit) return baseName(hit);

  return baseName(cwd) || 'unknown';
}

// 把 "-Users-me-workspace-My-App" 这类编码路径还原成真实路径：
// 逐段读真实目录做贪婪最长匹配，天然解决目录名里本来就带 '-' 或空格的歧义。
function decodeClaudePath(enc) {
  const toks = String(enc).split('-');
  let i = toks[0] === '' ? 1 : 0;
  let cur = '/';
  while (i < toks.length) {
    let children;
    try { children = fs.readdirSync(cur); } catch (_) { break; }
    let best = null, bestLen = 0;
    for (const c of children) {
      const parts = c.replace(/[ \/]/g, '-').split('-');
      if (parts.length > toks.length - i || parts.length <= bestLen) continue;
      let ok = true;
      for (let k = 0; k < parts.length; k++) if (parts[k] !== toks[i + k]) { ok = false; break; }
      if (ok) { best = c; bestLen = parts.length; }
    }
    if (!best) break;
    cur = path.join(cur, best);
    i += bestLen;
  }
  return cur === '/' ? '' : cur;
}


// 读 transcript（JSONL）尾部 512KB 的行（最后几条记录足够）；读不了返回 null
function tailLines(p) {
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
    return txt.split('\n').filter(Boolean);
  } catch (_) { return null; }
}

// 读 transcript（JSONL）尾部，取最后一条 assistant 文本（与 server.js 同逻辑）
function lastAssistantText(p) {
  const lines = tailLines(p) || [];
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
  return '';
}
