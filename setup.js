#!/usr/bin/env node
/**
 * ClaudeVoice 安装器
 *   node setup.js          安装/更新全局 hooks
 *   node setup.js --remove 卸载全局 hooks
 *
 * 做三件事：
 *   1. 确保 .env 存在并生成 HOOK_SECRET
 *   2. 写 ~/.claude/claudevoice.json（hook 脚本读它拿到 服务地址 + 密钥）
 *   3. 幂等地把 Notification / Stop hook 合并进 ~/.claude/settings.json（先备份）
 */
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const DIR = __dirname;
const HOOK = path.join(DIR, 'hook.js');
const NODE = process.execPath;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CV_CFG = path.join(CLAUDE_DIR, 'claudevoice.json');
const EVENTS = ['Notification', 'Stop', 'SubagentStop']; // 等待输入/授权 + 任务完成 + 子任务完成(默认静音)
const remove = process.argv.includes('--remove');

// ---- 1. .env ----
const envPath = path.join(DIR, '.env');
let env = parseEnv(envPath);
if (!env.PORT) env.PORT = '8787';
if (!env.HOOK_SECRET) env.HOOK_SECRET = crypto.randomBytes(16).toString('hex');
if (!env.MIMO_BASE) env.MIMO_BASE = 'https://api.xiaomimimo.com/v1';
if (!env.MIMO_MODEL) env.MIMO_MODEL = 'mimo-v2-tts';
if (!env.MIMO_VOICE) env.MIMO_VOICE = 'mimo_default';
if (env.MIMO_API_KEY === undefined) env.MIMO_API_KEY = '';
writeEnv(envPath, env);

const PORT = env.PORT;
const SECRET = env.HOOK_SECRET;

// ---- 2. ~/.claude/claudevoice.json ----
fs.mkdirSync(CLAUDE_DIR, { recursive: true });
if (remove) {
  try { fs.unlinkSync(CV_CFG); } catch (_) {}
} else {
  fs.writeFileSync(CV_CFG, JSON.stringify({
    url: `http://127.0.0.1:${PORT}/hook`,
    secret: SECRET,
  }, null, 2));
}

// ---- 3. settings.json hooks 合并 ----
let settings = {};
if (fs.existsSync(SETTINGS)) {
  try { settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8')); }
  catch (e) { console.error('⚠ 无法解析现有 settings.json，已中止以免覆盖：', e.message); process.exit(1); }
  // 备份
  const bak = SETTINGS + '.bak.' + Date.now();
  fs.copyFileSync(SETTINGS, bak);
  console.log('已备份原 settings.json →', bak);
}
settings.hooks = settings.hooks || {};

const cmd = `"${NODE}" "${HOOK}"`;
for (const ev of EVENTS) {
  const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
  // 去掉旧的 ClaudeVoice 条目（按 hook.js 路径识别），保留用户其它 hook
  const cleaned = list.filter((grp) => {
    if (!grp || !Array.isArray(grp.hooks)) return true;
    return !grp.hooks.some((h) => h && typeof h.command === 'string' && h.command.includes(HOOK));
  });
  if (!remove) {
    cleaned.push({ hooks: [{ type: 'command', command: `${cmd} ${ev}`, timeout: 10 }] });
  }
  if (cleaned.length) settings.hooks[ev] = cleaned;
  else delete settings.hooks[ev];
}

fs.writeFileSync(SETTINGS, JSON.stringify(settings, null, 2));

// ---- 总结 ----
if (remove) {
  console.log('\n✅ 已卸载 ClaudeVoice 全局 hooks。');
} else {
  console.log('\n✅ 安装完成。');
  console.log('   全局 hooks 已写入:', SETTINGS, '（事件:', EVENTS.join(', ') + '）');
  console.log('   hook 配置:', CV_CFG);
  if (!env.MIMO_API_KEY) {
    console.log('\n⚠ 还没有设置 MIMO_API_KEY，请编辑', envPath, '填入小米 MiMo 的 key。');
  }
  console.log('\n下一步：');
  console.log('   1) 启动服务:  node server.js   （或 npm start）');
  console.log(`   2) 打开面板:  http://localhost:${PORT}`);
  console.log('   3) 点“启用语音播报”，保持页面打开即可。');
  console.log('\n（hooks 对所有项目全局生效；新开的 Claude Code 会话即自动接入。）');
}

// ---------- helpers ----------
function parseEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (m) out[m[1]] = stripQuotes(m[2]);
    }
  } catch (_) {}
  return out;
}
function stripQuotes(v) {
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
function writeEnv(file, obj) {
  const order = ['PORT', 'HOST', 'MIMO_API_KEY', 'MIMO_BASE', 'MIMO_MODEL', 'MIMO_VOICE', 'HOOK_SECRET', 'DASH_TOKEN'];
  const keys = order.filter((k) => k in obj).concat(Object.keys(obj).filter((k) => !order.includes(k)));
  const body = keys.map((k) => `${k}=${obj[k]}`).join('\n') + '\n';
  fs.writeFileSync(file, body);
}
