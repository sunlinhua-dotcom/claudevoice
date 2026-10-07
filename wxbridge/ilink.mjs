/**
 * ilink.mjs — 微信 ClawBot(iLink bot) 协议客户端。
 *
 * 协议与常量对齐腾讯官方插件 @tencent-weixin/openclaw-weixin 2.4.6 (MIT)：
 * 端点 ilink/bot/*，AES-128-ECB 的 CDN 媒体，以及 item 类型编号。
 * 注意 item 类型编号跟老版微信 msgtype 不是一回事，别用 3/34/43/49。
 */
import { createDecipheriv, randomBytes, randomUUID } from 'node:crypto';

export const BASE_URL = 'https://ilinkai.weixin.qq.com';
export const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c';
export const ILINK_APP_ID = 'bot';
export const CHANNEL_VERSION = '2.4.6';
export const BOT_AGENT = 'WxBridge/1.0.0';

/** iLink 的 item 类型。官方 dist/src/api/types.js 的 MessageItemType。 */
export const ItemType = {
  NONE: 0, TEXT: 1, IMAGE: 2, VOICE: 3, FILE: 4, VIDEO: 5,
  TOOL_CALL_START: 11, TOOL_CALL_RESULT: 12,
};
export const MessageType = { NONE: 0, USER: 1, BOT: 2 };
export const MessageState = { NEW: 0, GENERATING: 1, FINISH: 2 };

/** 会话过期的 errcode，命中后要重新扫码。 */
export const STALE_TOKEN_ERRCODE = -14;

const CLIENT_VERSION = (() => {
  const [a = 0, b = 0, c = 0] = CHANNEL_VERSION.split('.').map((n) => parseInt(n, 10) || 0);
  return String(((a & 0xff) << 16) | ((b & 0xff) << 8) | (c & 0xff));
})();

function wechatUin() {
  return Buffer.from(String(randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}

function headers(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': wechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    ...(token ? { Authorization: `Bearer ${token.trim()}` } : {}),
  };
}

const baseInfo = () => ({ channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT });

async function post(endpoint, body, { token, timeoutMs, signal, label }) {
  const url = new URL(endpoint, `${BASE_URL}/`).toString();
  const ac = timeoutMs ? new AbortController() : undefined;
  const timer = ac ? setTimeout(() => ac.abort(), timeoutMs) : undefined;
  const onOuter = () => ac?.abort();
  if (signal && ac) signal.addEventListener('abort', onOuter, { once: true });
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: headers(token),
      body: JSON.stringify({ ...body, base_info: baseInfo() }),
      ...(ac ? { signal: ac.signal } : {}),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`${label} HTTP ${res.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally {
    if (timer) clearTimeout(timer);
    if (signal && ac) signal.removeEventListener('abort', onOuter);
  }
}

/**
 * 长轮询取新消息。客户端超时属于正常流程，返回空列表让调用方直接重试。
 */
export async function getUpdates({ token, buf = '', timeoutMs = 35_000, signal }) {
  try {
    return await post('ilink/bot/getupdates', { get_updates_buf: buf },
      { token, timeoutMs, signal, label: 'getUpdates' });
  } catch (error) {
    if (error?.name === 'AbortError') return { ret: 0, msgs: [], get_updates_buf: buf };
    throw error;
  }
}

export async function sendText({ token, to, text, contextToken }) {
  const resp = await post('ilink/bot/sendmessage', {
    msg: {
      from_user_id: '',
      to_user_id: to,
      client_id: `wxbridge-${randomUUID()}`,
      message_type: MessageType.BOT,
      message_state: MessageState.FINISH,
      item_list: text ? [{ type: ItemType.TEXT, text_item: { text } }] : undefined,
      context_token: contextToken || undefined,
    },
  }, { token, timeoutMs: 15_000, label: 'sendMessage' });
  if (resp?.ret && resp.ret !== 0) throw new Error(`sendMessage ret=${resp.ret} ${resp.errmsg || ''}`);
  return resp;
}

export async function getConfig({ token, userId, contextToken }) {
  return post('ilink/bot/getconfig', { ilink_user_id: userId, context_token: contextToken },
    { token, timeoutMs: 10_000, label: 'getConfig' });
}

export async function notifyStart({ token }) {
  return post('ilink/bot/msg/notifystart', {}, { token, timeoutMs: 10_000, label: 'notifyStart' });
}

export async function notifyStop({ token }) {
  return post('ilink/bot/msg/notifystop', {}, { token, timeoutMs: 10_000, label: 'notifyStop' });
}

/**
 * aes_key 在不同媒体类型上有两种编码：图片是 base64(16 原始字节)，
 * 文件 / 语音 / 视频是 base64(32 位十六进制字符串)。两种都要认。
 */
function parseAesKey(aesKeyBase64) {
  const decoded = Buffer.from(aesKeyBase64, 'base64');
  if (decoded.length === 16) return decoded;
  const ascii = decoded.toString('ascii');
  if (decoded.length === 32 && /^[0-9a-fA-F]{32}$/.test(ascii)) return Buffer.from(ascii, 'hex');
  throw new Error(`aes_key 解不出 16 字节密钥（得到 ${decoded.length} 字节）`);
}

function cdnUrl(encryptedQueryParam, fullUrl) {
  if (fullUrl) return fullUrl;
  return `${CDN_BASE_URL}/download?encrypted_query_param=${encodeURIComponent(encryptedQueryParam)}`;
}

async function fetchBytes(url, label) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${label} CDN ${res.status} ${res.statusText}`);
  return Buffer.from(await res.arrayBuffer());
}

/** 从 CDN 拉取并解密一份媒体，返回明文 Buffer。 */
export async function downloadMedia(media, { aesKeyOverride, label = 'media' } = {}) {
  if (!media?.encrypt_query_param && !media?.full_url) throw new Error(`${label} 缺少下载参数`);
  const url = cdnUrl(media.encrypt_query_param ?? '', media.full_url);
  const buf = await fetchBytes(url, label);
  const aesKeyBase64 = aesKeyOverride || media.aes_key;
  if (!aesKeyBase64) return buf;
  return Buffer.concat((() => {
    const d = createDecipheriv('aes-128-ecb', parseAesKey(aesKeyBase64), null);
    return [d.update(buf), d.final()];
  })());
}
