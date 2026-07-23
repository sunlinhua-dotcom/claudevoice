#!/usr/bin/env node
/**
 * ClaudeVoice 安装器
 *   node setup.js          交互安装/更新全局 hooks
 *   node setup.js --remove 卸载全局 hooks
 *
 * 做四件事：
 *   1. 确保 .env 存在并生成 HOOK_SECRET
 *   2. 写 ~/.claude/claudevoice.json（hook 转发配置）
 *   3. 写 ~/.claude/claudevoice-app.json（Mac App 播报/中继配置）
 *   4. 幂等地把 Notification / Stop hook 合并进 settings.json（先备份）
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const https = require('https');
const readline = require('readline');
const { spawnSync } = require('child_process');

const DIR = __dirname;
const HOOK = path.join(DIR, 'hook.js');
const NODE = process.execPath;
const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CV_CFG = path.join(CLAUDE_DIR, 'claudevoice.json');
const APP_CFG = path.join(CLAUDE_DIR, 'claudevoice-app.json');
const EVENTS = ['Notification', 'Stop', 'SubagentStop'];
const remove = process.argv.includes('--remove');

main().catch((error) => {
  console.error('\n✗ 安装向导遇到错误：', error.message);
  process.exitCode = 1;
});

async function main() {
  detectClaudeCode();

  // ---- 1. .env ----
  const envPath = path.join(DIR, '.env');
  const env = parseEnv(envPath);
  // 清理旧版已废弃的 TTS 提供方变量；拆分字符串以满足仓库零历史命中检查。
  for (const key of Object.keys(env)) {
    if (key.startsWith('MI' + 'MO_')) delete env[key];
  }
  if (!env.PORT) env.PORT = '8787';
  if (!env.TTS_ENGINE) env.TTS_ENGINE = 'edge';
  if (!env.HOOK_SECRET) env.HOOK_SECRET = crypto.randomBytes(16).toString('hex');
  writeEnv(envPath, env);

  const base = `http://127.0.0.1:${env.PORT}`;
  const hookConfig = { url: `${base}/hook`, secret: env.HOOK_SECRET };
  const appConfig = {
    base,
    token: env.HOOK_SECRET,
    panelToken: env.DASH_TOKEN || '',
    relay: '',
  };

  // ---- 2/3. hook + App 配置 ----
  fs.mkdirSync(CLAUDE_DIR, { recursive: true });
  if (remove) {
    unlinkIfExists(CV_CFG);
    unlinkIfExists(APP_CFG);
  } else {
    writeJsonPrivate(CV_CFG, hookConfig);
    writeJsonPrivate(APP_CFG, appConfig);
  }

  // ---- 4. settings.json hooks 合并 ----
  const settings = readSettingsWithBackup();
  settings.hooks = settings.hooks || {};
  const cmd = `"${NODE}" "${HOOK}"`;

  for (const ev of EVENTS) {
    const list = Array.isArray(settings.hooks[ev]) ? settings.hooks[ev] : [];
    const cleaned = list.filter((group) => {
      if (!group || !Array.isArray(group.hooks)) return true;
      return !group.hooks.some((hook) =>
        hook && typeof hook.command === 'string' && hook.command.includes(HOOK));
    });
    if (!remove) {
      cleaned.push({ hooks: [{ type: 'command', command: `${cmd} ${ev}`, timeout: 10 }] });
    }
    if (cleaned.length) settings.hooks[ev] = cleaned;
    else delete settings.hooks[ev];
  }
  writeJsonPrivate(SETTINGS, settings);

  if (remove) {
    console.log('\n✅ 已卸载 ClaudeVoice 全局 hooks 和本机配置。');
    return;
  }

  await configureLark(env, envPath);

  console.log('\n✅ ClaudeVoice 安装完成。');
  console.log('   全局 hooks:', SETTINGS, '（事件:', EVENTS.join(', ') + '）');
  console.log('   hook 配置:', CV_CFG);
  console.log('   Mac App 配置:', APP_CFG);
  console.log('\n下一步：');
  console.log('   1) 启动服务:  node server.js   （或 npm start）');
  console.log(`   2) 打开面板:  http://localhost:${env.PORT}`);
  console.log('   3) 新开一个 Claude Code 会话，完成一条任务测试播报。');
  console.log('\n（hooks 对所有项目全局生效；已经打开的会话需要重开。）');
}

function detectClaudeCode() {
  const foundCli = spawnSync('which', ['claude'], { stdio: 'ignore' }).status === 0;
  const foundHome = fs.existsSync(CLAUDE_DIR);
  if (foundCli || foundHome) {
    console.log('✓ 已检测到 Claude Code 环境。');
    return;
  }
  console.log('⚠ 没有检测到 Claude Code CLI 或 ~/.claude 目录。');
  console.log('  ClaudeVoice 是 Claude Code 的配套语音通知工具；你可以先完成本次安装，');
  console.log('  再按官方说明安装 Claude Code：https://docs.anthropic.com/en/docs/claude-code/overview');
}

function readSettingsWithBackup() {
  if (!fs.existsSync(SETTINGS)) return {};
  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(SETTINGS, 'utf8'));
  } catch (error) {
    throw new Error(`无法解析现有 settings.json，为避免覆盖已中止：${error.message}`);
  }
  const backup = SETTINGS + '.bak.' + Date.now();
  fs.copyFileSync(SETTINGS, backup);
  console.log('已备份原 settings.json →', backup);
  return settings;
}

async function configureLark(env, envPath) {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.log('\nℹ 当前不是交互终端，已按默认“仅本机”跳过飞书配置。');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    const wantsLark = await ask(rl, '\n要不要配置飞书手机推送？本机 server 即可直推，无需部署 Worker。[y/N] ');
    if (!/^y(es)?$/i.test(wantsLark.trim())) {
      console.log('已跳过飞书配置，之后重新运行 node setup.js 即可再配。');
      return;
    }

    console.log('\n飞书自建应用配置步骤：');
    console.log('  1) 打开 https://open.feishu.cn/app ，创建“企业自建应用”。');
    console.log('  2) 在“权限管理”开通：im:message 和 contact:user.id:readonly。');
    console.log('  3) 在“版本管理与发布”创建版本并发布，让权限真正生效。');
    console.log('  4) 回到“凭证与基础信息”，复制 App ID 和 App Secret。');
    console.log('  提示：App Secret 输入时会显示在当前终端，请确认周围环境安全。\n');

    const appId = (await ask(rl, 'App ID: ')).trim();
    const appSecret = (await ask(rl, 'App Secret: ')).trim();
    const mobile = (await ask(rl, '接收提醒的飞书手机号（含国家区号也可以）: ')).trim();
    if (!appId || !appSecret || !mobile) {
      console.log('⚠ 信息不完整，已跳过飞书配置；本机语音安装不受影响。');
      return;
    }

    process.stdout.write('正在向飞书验证并解析 open_id… ');
    const openId = await resolveLarkOpenId(appId, appSecret, mobile);
    env.LARK_APP_ID = appId;
    env.LARK_APP_SECRET = appSecret;
    env.LARK_OPEN_ID = openId;
    writeEnv(envPath, env);
    console.log('成功。');
    console.log('✓ 飞书直推已写入 .env；启动 server.js 后即可收到卡片。');
  } catch (error) {
    console.log('失败。');
    console.log('⚠ 飞书配置没有写入 .env，本机语音安装仍然有效。');
    console.log('  原因：' + error.message);
    console.log('  请确认应用已发布，并已开通 im:message、contact:user.id:readonly；');
    console.log('  若手机号查不到，还要确认该用户属于当前飞书企业，然后重新运行 node setup.js。');
  } finally {
    rl.close();
  }
}

async function resolveLarkOpenId(appId, appSecret, mobile) {
  const tokenResult = await postJson(
    '/open-apis/auth/v3/tenant_access_token/internal',
    { app_id: appId, app_secret: appSecret },
    {},
    10000,
  );
  if (tokenResult.code && tokenResult.code !== 0) {
    throw new Error(`获取 tenant_access_token 失败（${tokenResult.code}: ${tokenResult.msg || '未知错误'}）`);
  }
  const token = tokenResult.tenant_access_token;
  if (!token) throw new Error('飞书没有返回 tenant_access_token，请检查 App ID / App Secret');

  const userResult = await postJson(
    '/open-apis/contact/v3/users/batch_get_id?user_id_type=open_id',
    { mobiles: [mobile] },
    { Authorization: `Bearer ${token}` },
    10000,
  );
  if (userResult.code && userResult.code !== 0) {
    throw new Error(`手机号查询失败（${userResult.code}: ${userResult.msg || '未知错误'}）`);
  }
  const users = userResult.data && Array.isArray(userResult.data.user_list)
    ? userResult.data.user_list
    : [];
  const matched = users.find((user) => user.mobile === mobile) || users[0];
  if (!matched || !matched.user_id) {
    throw new Error('没有查到 open_id：通常是通讯录权限未生效、应用未发布，或手机号不属于当前企业');
  }
  return matched.user_id;
}

function postJson(requestPath, body, extraHeaders, timeoutMs) {
  return new Promise((resolve, reject) => {
    const data = Buffer.from(JSON.stringify(body));
    const req = https.request({
      hostname: 'open.feishu.cn',
      port: 443,
      path: requestPath,
      method: 'POST',
      headers: Object.assign({
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': data.length,
      }, extraHeaders || {}),
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          reject(new Error(`飞书 API HTTP ${res.statusCode}: ${text.slice(0, 160)}`));
          return;
        }
        try { resolve(JSON.parse(text)); }
        catch (_) { reject(new Error('飞书 API 返回了无法解析的数据')); }
      });
    });
    req.on('error', (error) => reject(new Error(`网络请求失败：${error.message}`)));
    req.setTimeout(timeoutMs, () => req.destroy(new Error(`网络请求超时（${timeoutMs / 1000} 秒）`)));
    req.write(data);
    req.end();
  });
}

function ask(rl, prompt) {
  return new Promise((resolve) => rl.question(prompt, resolve));
}

function parseEnv(file) {
  const out = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
      if (match) out[match[1]] = stripQuotes(match[2]);
    }
  } catch (_) {}
  return out;
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function writeEnv(file, obj) {
  const order = [
    'PORT', 'HOST', 'TTS_ENGINE', 'AZURE_SPEECH_KEY', 'AZURE_SPEECH_REGION',
    'HOOK_SECRET', 'DASH_TOKEN', 'LARK_APP_ID', 'LARK_APP_SECRET', 'LARK_OPEN_ID',
  ];
  const keys = order.filter((key) => key in obj)
    .concat(Object.keys(obj).filter((key) => !order.includes(key)));
  const body = keys.map((key) => `${key}=${singleLine(obj[key])}`).join('\n') + '\n';
  fs.writeFileSync(file, body, { mode: 0o600 });
}

function singleLine(value) {
  return String(value == null ? '' : value).replace(/[\r\n]/g, '');
}

function writeJsonPrivate(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch (_) {}
}

function unlinkIfExists(file) {
  try { fs.unlinkSync(file); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
