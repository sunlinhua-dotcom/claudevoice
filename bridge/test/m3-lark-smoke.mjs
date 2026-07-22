import * as lark from '@larksuiteoapi/node-sdk';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { opusToPcm } from '../stt.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(join(import.meta.dirname, '..', '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const openId = process.env.LARK_OPEN_ID;
assert.ok(appId && appSecret && openId, '缺少飞书配置');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}: ${stderr.slice(-300)}`)));
  });
}

function assertApi(response, operation) {
  if (response?.code != null && response.code !== 0) throw new Error(`${operation}失败 ${response.code}: ${response.msg}`);
  return response;
}

async function sttRecognize(data) {
  for (const waitMs of [0, 3000, 7000]) {
    if (waitMs) await new Promise((resolve) => setTimeout(resolve, waitMs));
    try { return await client.speech_to_text.speech.fileRecognize({ data }); }
    catch (error) {
      const code = error?.response?.data?.code;
      if (code !== 99991400 || waitMs === 7000) throw error;
    }
  }
}

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: silentLogger });
const stamp = `${process.pid}-${Date.now()}`;
const aiff = join(tmpdir(), `cc-bridge-m3-${stamp}.aiff`);
const opus = join(tmpdir(), `cc-bridge-m3-${stamp}.opus`);

try {
  await run('/usr/bin/say', ['-v', 'Tingting', '-o', aiff, '你好，这是飞书语音识别联调测试']);
  if ((await stat(aiff)).size > 4096) {
    await run(process.env.FFMPEG_PATH || 'ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', '-i', aiff, '-c:a', 'libopus', opus]);
  } else {
    // 某些受控沙箱中 say 只能生成零时长 AIFF；退化为真实音频数据以验证 STT API 往返。
    await run(process.env.FFMPEG_PATH || 'ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=1', '-c:a', 'libopus', opus,
    ]);
  }
  const pcm = await opusToPcm(await readFile(opus));
  let sttText = '';
  let sttError = null;
  try {
    const stt = assertApi(await sttRecognize({
      speech: { speech: pcm.toString('base64') },
      config: { file_id: randomUUID(), format: 'pcm', engine_type: '16k_auto' },
    }), 'STT');
    sttText = String(stt?.data?.recognition_text || '').trim();
  } catch (error) {
    const api = error?.response?.data || {};
    sttError = { error: error.message, code: api.code, msg: api.msg, logId: api?.error?.log_id };
  }

  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
  const imageUpload = assertApi(await client.im.image.create({ data: { image_type: 'message', image: png } }), '图片上传');
  const imageKey = imageUpload?.image_key || imageUpload?.data?.image_key;
  const imageMessage = assertApi(await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'image', content: JSON.stringify({ image_key: imageKey }) },
  }), '图片发送');

  const report = Buffer.from('cc-bridge M3 联调测试文件\n', 'utf8');
  const fileUpload = assertApi(await client.im.file.create({
    data: { file_type: 'stream', file_name: 'cc-bridge-m3-test.txt', file: report },
  }), '文件上传');
  const fileKey = fileUpload?.file_key || fileUpload?.data?.file_key;
  const fileMessage = assertApi(await client.im.message.create({
    params: { receive_id_type: 'open_id' },
    data: { receive_id: openId, msg_type: 'file', content: JSON.stringify({ file_key: fileKey }) },
  }), '文件发送');

  console.log(JSON.stringify({
    sttText,
    sttError,
    pcmBytes: pcm.length,
    imageMessageId: imageMessage?.data?.message_id || '',
    fileMessageId: fileMessage?.data?.message_id || '',
  }));
  if (sttError) process.exitCode = 2;
} catch (error) {
  const api = error?.response?.data || {};
  console.error(JSON.stringify({ error: error.message, code: api.code, msg: api.msg, logId: api?.error?.log_id }));
  process.exitCode = 1;
} finally {
  const { rm } = await import('node:fs/promises');
  await rm(aiff, { force: true }).catch(() => {});
  await rm(opus, { force: true }).catch(() => {});
}
