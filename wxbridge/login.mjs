#!/usr/bin/env node
/**
 * login.mjs — 扫码把微信接上 wxbridge。
 *
 * 拉一张登录二维码渲染成 PNG，然后轮询扫码状态，确认后把凭证写进
 * ~/.wxbridge/account.json。index.mjs 会优先用这份，没有才回落到 OpenClaw 那份。
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import QRCode from 'qrcode';

import { BASE_URL } from './ilink.mjs';

const STATE_DIR = process.env.WXBRIDGE_STATE_DIR || join(homedir(), '.wxbridge');
const ACCOUNT_FILE = join(STATE_DIR, 'account.json');
const BOT_TYPE = '3';
const POLL_TIMEOUT_MS = 35_000;
const MAX_REFRESH = 3;

const log = (...args) => console.log(...args);

async function fetchQr() {
  const url = `${BASE_URL}/ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`取二维码失败 HTTP ${res.status}`);
  const data = await res.json();
  if (!data?.qrcode || !data?.qrcode_img_content) throw new Error(`取二维码失败：${JSON.stringify(data).slice(0, 200)}`);
  return { qrcode: data.qrcode, content: data.qrcode_img_content };
}

/** 扫码状态是长轮询，客户端超时当作 wait 继续转。 */
async function pollStatus(qrcode) {
  const url = `${BASE_URL}/ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), POLL_TIMEOUT_MS);
  try {
    const res = await fetch(url, { headers: { 'iLink-App-ClientVersion': '1' }, signal: ac.signal });
    if (!res.ok) throw new Error(`查扫码状态失败 HTTP ${res.status}`);
    return res.json();
  } catch (error) {
    if (error?.name === 'AbortError') return { status: 'wait' };
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function renderQr(content, outPath) {
  await QRCode.toFile(outPath, content, {
    type: 'png', width: 720, margin: 2,
    color: { dark: '#1F1E1DFF', light: '#FFFFFFFF' },
  });
  return outPath;
}

async function saveAccount(account) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  await writeFile(ACCOUNT_FILE, JSON.stringify(account, null, 2), { mode: 0o600 });
  return ACCOUNT_FILE;
}

export async function login({ outPath = join(STATE_DIR, 'login-qr.png'), timeoutMs = 480_000 } = {}) {
  await mkdir(STATE_DIR, { recursive: true, mode: 0o700 });
  let { qrcode, content } = await fetchQr();
  await renderQr(content, outPath);
  log(`QR_READY ${outPath}`);
  log(`QR_URL ${content}`);

  const deadline = Date.now() + timeoutMs;
  let refreshes = 1;
  let scanned = false;

  while (Date.now() < deadline) {
    const status = await pollStatus(qrcode);
    if (status.status === 'scaned') {
      if (!scanned) { log('SCANNED 已扫码，等你在微信里点确认'); scanned = true; }
    } else if (status.status === 'expired') {
      refreshes += 1;
      if (refreshes > MAX_REFRESH) throw new Error('二维码连续过期，登录中止');
      ({ qrcode, content } = await fetchQr());
      await renderQr(content, outPath);
      scanned = false;
      log(`QR_REFRESHED ${outPath}`);
    } else if (status.status === 'confirmed') {
      if (!status.ilink_bot_id || !status.bot_token) throw new Error('服务端没返回完整凭证');
      const account = {
        accountId: status.ilink_bot_id,
        token: status.bot_token,
        baseUrl: status.baseurl || BASE_URL,
        userId: status.ilink_user_id || '',
        savedAt: new Date().toISOString(),
      };
      const file = await saveAccount(account);
      log(`CONFIRMED accountId=${account.accountId} userId=${account.userId}`);
      log(`SAVED ${file}`);
      return account;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('登录超时');
}

if (process.argv[1]?.endsWith('login.mjs')) {
  login().catch((error) => { console.error('LOGIN_FAILED', error.message); process.exit(1); });
}
