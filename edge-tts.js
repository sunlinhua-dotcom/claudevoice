'use strict';
/**
 * edge-tts.js — 微软 Edge「大声朗读」在线神经语音（免 key、免费、中英双优）
 *
 * 纯 Node 内置模块（tls + crypto），手写 WebSocket 握手。
 * 用作 ClaudeVoice 的首选 TTS 引擎，失败由调用方回落到 Azure / MiMo。
 *
 * 关键（2026 起的反滥用要求，缺一即 403）：
 *   - Sec-MS-GEC：时间派生的 SHA-256 token（按 5 分钟取整）
 *   - Sec-MS-GEC-Version 与 UA 的 Chromium 主版本一致（143）
 *   - Cookie: muid=<32位大写hex>（本地随机生成，无需向 bing 取）
 */

const tls = require('tls');
const crypto = require('crypto');

const TRUSTED = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const GEC_VERSION = '1-143.0.3650.75';
const CHROMIUM = '143.0.0.0';
const HOST = 'speech.platform.bing.com';
const PATH = '/consumer/speech/synthesize/readaloud/edge/v1';

// 项目内 4 个音色（MiMo 名）→ Edge 神经语音（与 Azure 同一套目录，男女保持一致）。
// 仅用 Edge 端点实测可用的 zh-CN 音色；它们读中文为母语、嵌入的英文项目名/工具名也明显比 MiMo 准。
const VOICE_MAP = {
  '茉莉': 'zh-CN-XiaoxiaoNeural', // f
  '冰糖': 'zh-CN-XiaoyiNeural',   // f
  '白桦': 'zh-CN-YunxiNeural',    // m
  '苏打': 'zh-CN-YunyangNeural',  // m
};
const DEFAULT_VOICE = 'zh-CN-XiaoxiaoNeural';

function resolveVoice(v) {
  if (!v) return DEFAULT_VOICE;
  if (VOICE_MAP[v]) return VOICE_MAP[v];
  if (/^[a-z]{2}-[A-Z]{2}-\w+Neural$/.test(v)) return v; // 已是 Edge/Azure 语音名
  return DEFAULT_VOICE;
}

function secMsGec(skewSeconds) {
  let ticks = Date.now() / 1000 + (skewSeconds || 0) + 11644473600;
  ticks -= ticks % 300;        // 取整到 5 分钟
  ticks *= 1e7;                // 100 纳秒
  return crypto.createHash('sha256').update(ticks.toFixed(0) + TRUSTED, 'ascii').digest('hex').toUpperCase();
}
function uuid() { return crypto.randomBytes(16).toString('hex'); }
function muid() { return crypto.randomBytes(16).toString('hex').toUpperCase(); }
function escXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
function outputFormat(format) {
  return format === 'wav' ? 'riff-24khz-16bit-mono-pcm' : 'audio-24khz-48kbitrate-mono-mp3';
}

function encodeFrame(opcode, payload) {
  const len = payload.length;
  const mask = crypto.randomBytes(4);
  let header;
  if (len < 126) header = Buffer.from([0x80 | opcode, 0x80 | len]);
  else if (len < 65536) { header = Buffer.alloc(4); header[0] = 0x80 | opcode; header[1] = 0x80 | 126; header.writeUInt16BE(len, 2); }
  else { header = Buffer.alloc(10); header[0] = 0x80 | opcode; header[1] = 0x80 | 127; header.writeUInt32BE(0, 2); header.writeUInt32BE(len, 6); }
  const masked = Buffer.alloc(len);
  for (let i = 0; i < len; i++) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function once(text, voice, format, skewSeconds) {
  return new Promise((resolve, reject) => {
    const q = `?TrustedClientToken=${TRUSTED}&ConnectionId=${uuid()}&Sec-MS-GEC=${secMsGec(skewSeconds)}&Sec-MS-GEC-Version=${GEC_VERSION}`;
    const wsKey = crypto.randomBytes(16).toString('base64');
    const sock = tls.connect(443, HOST, { servername: HOST }, () => {
      sock.write(
        `GET ${PATH}${q} HTTP/1.1\r\n` +
        `Host: ${HOST}\r\n` +
        `Upgrade: websocket\r\nConnection: Upgrade\r\n` +
        `Sec-WebSocket-Key: ${wsKey}\r\nSec-WebSocket-Version: 13\r\n` +
        `Origin: chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold\r\n` +
        `User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${CHROMIUM} Safari/537.36 Edg/${CHROMIUM}\r\n` +
        `Accept-Encoding: gzip, deflate, br, zstd\r\nAccept-Language: en-US,en;q=0.9\r\n` +
        `Cookie: muid=${muid()};\r\nPragma: no-cache\r\nCache-Control: no-cache\r\n\r\n`
      );
    });
    let upgraded = false, buf = Buffer.alloc(0), audio = [], settled = false;
    const done = (fn, arg) => { if (settled) return; settled = true; try { sock.destroy(); } catch (_) {} fn(arg); };
    sock.setTimeout(20000, () => done(reject, new Error('edge-tts 超时')));
    sock.on('error', (e) => done(reject, e));
    sock.on('close', () => { if (!settled) { if (audio.length) done(resolve, Buffer.concat(audio)); else done(reject, new Error('edge-tts 连接关闭无音频')); } });
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d]);
      if (!upgraded) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx < 0) return;
        const head = buf.slice(0, idx).toString('utf8');
        const status = head.split('\r\n')[0];
        if (!/ 101 /.test(status)) {
          // 403 等：尝试用服务器 Date 校正时钟后重试一次
          const m = /^date:\s*(.+)$/im.exec(head);
          const e = new Error('edge-tts 握手失败: ' + status);
          e.serverDate = m ? m[1].trim() : '';
          e.statusCode = (/(\d{3})/.exec(status) || [])[1];
          return done(reject, e);
        }
        upgraded = true;
        buf = buf.slice(idx + 4);
        const ts = new Date().toString();
        const cfg = `X-Timestamp:${ts}\r\nContent-Type:application/json; charset=utf-8\r\nPath:speech.config\r\n\r\n` +
          JSON.stringify({ context: { synthesis: { audio: { metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' }, outputFormat: outputFormat(format) } } } });
        const ssml = `<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xmlns:mstts='https://www.w3.org/2001/mstts' xml:lang='zh-CN'><voice name='${voice}'><prosody pitch='+0Hz' rate='+0%' volume='+0%'>${escXml(text)}</prosody></voice></speak>`;
        const ssmlMsg = `X-RequestId:${uuid()}\r\nContent-Type:application/ssml+xml\r\nX-Timestamp:${ts}Z\r\nPath:ssml\r\n\r\n${ssml}`;
        sock.write(encodeFrame(0x1, Buffer.from(cfg, 'utf8')));
        sock.write(encodeFrame(0x1, Buffer.from(ssmlMsg, 'utf8')));
        if (buf.length === 0) return;
      }
      while (buf.length >= 2) {
        const opcode = buf[0] & 0x0f;
        let len = buf[1] & 0x7f, off = 2;
        if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
        else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
        if (buf.length < off + len) break;
        const payload = buf.slice(off, off + len);
        buf = buf.slice(off + len);
        if (opcode === 0x2) {                       // 二进制 = 音频帧
          const hlen = payload.readUInt16BE(0);
          audio.push(payload.slice(2 + hlen));
        } else if (opcode === 0x1) {                // 文本控制帧
          if (/Path:turn\.end/.test(payload.toString('utf8'))) return done(resolve, Buffer.concat(audio));
        } else if (opcode === 0x8) {                // close
          return done(audio.length ? resolve : reject, audio.length ? Buffer.concat(audio) : new Error('edge-tts 被关闭'));
        }
      }
    });
  });
}

// 主入口：失败（含 403 时钟偏移）自动用服务器时间校正后重试一次
async function synthEdge(text, voice, format) {
  const v = resolveVoice(voice);
  try {
    return await once(text, v, format, 0);
  } catch (e) {
    if (e && e.statusCode === '403' && e.serverDate) {
      const serverMs = Date.parse(e.serverDate);
      if (!isNaN(serverMs)) {
        const skew = Math.round((serverMs - Date.now()) / 1000);
        return await once(text, v, format, skew);
      }
    }
    throw e;
  }
}

module.exports = { synthEdge, resolveVoice, VOICE_MAP, DEFAULT_VOICE };
