import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkFfmpeg, opusToPcm, transcribeLarkAudio } from '../stt.mjs';

function synthesizeOpus() {
  const made = spawnSync('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'sine=frequency=880:sample_rate=16000',
    '-t', '0.15', '-c:a', 'libopus', '-f', 'ogg', 'pipe:1',
  ], { encoding: null });
  assert.equal(made.status, 0, made.stderr?.toString());
  return made.stdout;
}

test('ffmpeg 可用性检查与 Opus→16k mono s16le 真转换', async () => {
  assert.equal(checkFfmpeg('ffmpeg').ok, true);
  const pcm = await opusToPcm(synthesizeOpus(), { ffmpegPath: 'ffmpeg' });
  assert.ok(pcm.length >= 4000, `PCM 太短：${pcm.length}`);
  assert.equal(pcm.length % 2, 0);
});

test('ffmpeg 缺失时返回可直接展示给用户的错误', async () => {
  await assert.rejects(() => opusToPcm(Buffer.from('x'), { ffmpegPath: '/definitely/missing/ffmpeg' }), /ffmpeg 不可用/);
});

test('语音链下载资源、转换 PCM 并调用飞书 fileRecognize', async () => {
  const opus = synthesizeOpus();
  const root = await mkdtemp(join(tmpdir(), 'cc-stt-test-'));
  let recognizePayload;
  const client = {
    im: { messageResource: { get: async ({ path, params }) => {
      assert.equal(path.message_id, 'm-audio');
      assert.equal(path.file_key, 'file-audio');
      assert.equal(params.type, 'file');
      return { writeFile: async (file) => writeFile(file, opus), headers: { 'content-type': 'audio/ogg' } };
    } } },
    speech_to_text: { speech: { fileRecognize: async (payload) => {
      recognizePayload = payload;
      return { code: 0, msg: 'success', data: { recognition_text: '测试语音指令' } };
    } } },
  };
  const text = await transcribeLarkAudio({ client, messageId: 'm-audio', fileKey: 'file-audio', tempRoot: root });
  assert.equal(text, '测试语音指令');
  assert.equal(recognizePayload.data.config.format, 'pcm');
  assert.equal(recognizePayload.data.config.engine_type, '16k_auto');
  assert.ok(Buffer.from(recognizePayload.data.speech.speech, 'base64').length >= 4000);
  assert.deepEqual(await readFile(join(root, '.keep')).catch(() => null), null);
  await rm(root, { recursive: true, force: true });
});

test('飞书 STT code 非零时不吞错', async () => {
  const opus = synthesizeOpus();
  const root = await mkdtemp(join(tmpdir(), 'cc-stt-test-'));
  const client = {
    im: { messageResource: { get: async () => ({ writeFile: async (file) => writeFile(file, opus) }) } },
    speech_to_text: { speech: { fileRecognize: async () => ({ code: 1040101, msg: 'invalid param' }) } },
  };
  await assert.rejects(() => transcribeLarkAudio({ client, messageId: 'm', fileKey: 'f', tempRoot: root }), /1040101.*invalid param/);
  await rm(root, { recursive: true, force: true });
});
