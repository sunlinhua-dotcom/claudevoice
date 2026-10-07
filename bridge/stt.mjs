import { spawn, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function checkFfmpeg(ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg') {
  const result = spawnSync(ffmpegPath, ['-version'], { stdio: 'ignore' });
  return result.error || result.status !== 0
    ? { ok: false, path: ffmpegPath, error: result.error?.message || `退出码 ${result.status}` }
    : { ok: true, path: ffmpegPath };
}

export function opusToPcm(opusBuffer, { ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg' } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, [
      '-hide_banner', '-loglevel', 'error', '-i', 'pipe:0',
      '-f', 's16le', '-ar', '16000', '-ac', '1', 'pipe:1',
    ], { stdio: ['pipe', 'pipe', 'pipe'] });
    const output = [];
    const errors = [];
    let settled = false;
    const finishError = (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    child.stdout.on('data', (chunk) => output.push(chunk));
    child.stderr.on('data', (chunk) => errors.push(chunk));
    child.on('error', (error) => finishError(new Error(`ffmpeg 不可用：${error.message}`)));
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      if (code === 0) resolve(Buffer.concat(output));
      else reject(new Error(`ffmpeg 转换失败（退出码 ${code}）：${Buffer.concat(errors).toString('utf8').slice(-300)}`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(opusBuffer);
  });
}

export async function transcribeLarkAudio({
  client,
  messageId,
  fileKey,
  ffmpegPath = process.env.FFMPEG_PATH || 'ffmpeg',
  tempRoot = join(tmpdir(), 'cc-bridge-stt'),
}) {
  if (!client || !messageId || !fileKey) throw new Error('语音消息缺少 message_id 或 file_key');
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const sourceFile = join(tempRoot, `${randomUUID()}.opus`);
  try {
    const response = await client.im.messageResource.get({
      path: { message_id: messageId, file_key: fileKey },
      params: { type: 'file' },
    });
    await response.writeFile(sourceFile);
    const opus = await readFile(sourceFile);
    const pcm = await opusToPcm(opus, { ffmpegPath });
    const recognized = await client.speech_to_text.speech.fileRecognize({
      data: {
        speech: { speech: pcm.toString('base64') },
        config: { file_id: randomUUID(), format: 'pcm', engine_type: '16k_auto' },
      },
    });
    if (recognized?.code != null && recognized.code !== 0) {
      throw new Error(`飞书 STT ${recognized.code}: ${recognized.msg || 'unknown'}`);
    }
    return String(recognized?.data?.recognition_text || '').trim();
  } finally {
    await unlink(sourceFile).catch(() => {});
  }
}
