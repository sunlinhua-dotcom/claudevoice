import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as cardModule from '../cards.mjs';
import * as injectModule from '../inject.mjs';
import * as mediaModule from '../media.mjs';
import { createMessageHandler, LruSet } from '../router.mjs';
import { CardService } from '../cards.mjs';
import { BridgeController } from '../index.mjs';
import { SessionStore } from '../sessions.mjs';
import { deliveryPlan, normalizeBridgePayload } from '../../cloudflare/src/event-utils.mjs';

const OWNER = 'ou_owner';

function event({ id, type = 'text', content = {}, parentId = '', rootId = '' }) {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: id,
      message_type: type,
      content: typeof content === 'string' ? content : JSON.stringify(content),
      parent_id: parentId,
      root_id: rootId,
      chat_type: 'p2p',
    },
  };
}

test('input 附件走剪贴板、task 附件走 Claude，audio 两种模式都先走 STT', async () => {
  const calls = { attachments: [], tasks: [], stt: [], inputs: [] };
  const store = {
    state: { currentProject: 'demo', settings: { inputMode: 'input' } },
    projects: { demo: { path: '/project/demo' } },
    findTaskByMessage: () => null,
    findRecentTask: () => null,
  };
  const controller = {
    handleAskText: async () => false,
    handleAttachment: async (message) => calls.attachments.push(message.message_type),
    handleText: async (text, context) => calls.tasks.push({ text, context }),
    handleInput: async (text) => calls.inputs.push(text),
    handleCommand: async () => {},
  };
  const media = { prepareMediaMessage: async (message) => ({ prompt: `附件:${message.message_type}` }) };
  const cards = { replyText: async () => {}, sendVoiceConfirmation: async () => {} };
  const handler = createMessageHandler({
    ownerId: OWNER, store, controller, cards, media, dedupe: new LruSet(20), log: {},
    transcribeAudio: async (message) => { calls.stt.push(message.message_id); return '语音文字'; },
  });

  await handler(event({ id: 'input-file', type: 'file', content: { file_key: 'f1', file_name: 'a.pdf' } }));
  assert.deepEqual(calls.attachments, ['file']);
  assert.equal(calls.tasks.length, 0);

  store.state.settings.inputMode = 'task';
  await handler(event({ id: 'task-media', type: 'media', content: { file_key: 'v1', file_name: 'clip.mp4' } }));
  assert.equal(calls.tasks[0].text, '附件:media');

  await handler(event({ id: 'task-audio', type: 'audio', content: { file_key: 'a1' } }));
  store.state.settings.inputMode = 'input';
  await handler(event({ id: 'input-audio', type: 'audio', content: { file_key: 'a2' } }));
  assert.deepEqual(calls.stt, ['task-audio', 'input-audio']);
  assert.equal(calls.inputs.at(-1), '语音文字');
});

test('media/video/post 内嵌附件按 image_key 与 file_key 下载并返回元数据', async () => {
  assert.equal(typeof mediaModule.parseAttachmentMessage, 'function');
  const parsed = mediaModule.parseAttachmentMessage({
    message_type: 'post',
    content: JSON.stringify({
      zh_cn: {
        title: '资料',
        content: [[
          { tag: 'img', image_key: 'img-a' },
          { tag: 'file', file_key: 'file-a', file_name: '方案.pdf' },
        ]],
      },
    }),
  });
  assert.deepEqual(parsed.attachments.map((item) => [item.key, item.resourceType]), [
    ['img-a', 'image'],
    ['file-a', 'file'],
  ]);

  const root = await mkdtemp(join(tmpdir(), 'cc-all-attachments-'));
  const downloads = [];
  const client = { im: { messageResource: { get: async ({ path, params }) => ({
    headers: {
      'content-type': params.type === 'image' ? 'image/png' : 'video/mp4',
      'content-length': params.type === 'image' ? '16' : String(11 * 1024 * 1024),
    },
    writeFile: async (target) => {
      downloads.push({ key: path.file_key, type: params.type, target });
      await writeFile(target, params.type === 'image' ? Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex') : Buffer.from('video'));
    },
  }) } } };
  const large = [];
  const store = new mediaModule.MediaStore({ client, root });
  await store.init();
  const prepared = await store.prepareMediaMessage({
    message_id: 'm-video', message_type: 'video',
    content: JSON.stringify({ file_key: 'video-key', file_name: '测试视频.mp4' }),
  }, { onLargeDownload: async (meta) => large.push(meta) });
  assert.equal(downloads[0].type, 'file');
  assert.equal(prepared.attachments[0].name, '测试视频.mp4');
  assert.equal(prepared.attachments[0].resourceType, 'file');
  assert.equal(existsSync(prepared.attachments[0].path), true);
  assert.equal(large[0].size, 11 * 1024 * 1024);
  await rm(root, { recursive: true, force: true });
});

test('osascript 始终使用参数数组，恶意路径不进入 AppleScript，并以 clipboard info 验证', async () => {
  assert.equal(typeof injectModule.writeAttachmentsToClipboard, 'function');
  const calls = [];
  const malicious = '/tmp/a"; do shell script "touch /tmp/pwned"; $(echo x).pdf';
  const spawnImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (calls.length === 2) child.stdout.emit('data', Buffer.from('«class furl», 1'));
      child.emit('close', 0);
    });
    return child;
  };
  const result = await injectModule.writeAttachmentsToClipboard([
    { path: malicious, name: '危险文件.pdf', mime: 'application/pdf' },
  ], { spawnImpl });
  assert.equal(calls.length, 2);
  assert.ok(calls.every((call) => call.command === 'osascript' && Array.isArray(call.args)));
  assert.ok(calls.every((call) => call.options?.shell !== true));
  assert.equal(calls[0].args.includes(malicious), true);
  assert.equal(calls[0].args[1].includes(malicious), false);
  assert.match(result.clipboardInfo, /furl/);
  assert.equal(result.verified, true);
});

test('图片数据写剪贴板失败时退回文件引用，并重新读回验证', async () => {
  const calls = [];
  const spawnImpl = (_command, args) => {
    calls.push(args);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    queueMicrotask(() => {
      if (calls.length === 1) {
        child.stderr.emit('data', Buffer.from('图片格式失败'));
        child.emit('close', 1);
      } else {
        if (calls.length === 3) child.stdout.emit('data', Buffer.from('«class furl», 1'));
        child.emit('close', 0);
      }
    });
    return child;
  };
  const result = await injectModule.writeAttachmentsToClipboard([
    { path: '/tmp/测试.png', name: '测试.png', mime: 'image/png' },
  ], { spawnImpl });
  assert.equal(result.method, 'file-reference');
  assert.equal(result.fallback, true);
  assert.match(result.primaryError, /图片格式失败/);
  assert.match(calls[0][1], /PNGf/);
  assert.match(calls[1][1], /POSIX file/);
});

test('附件回执卡包含文件元数据、已验证状态、粘贴与转 Claude 按钮', () => {
  assert.equal(typeof cardModule.buildAttachmentReceiptCard, 'function');
  const value = cardModule.buildAttachmentReceiptCard({
    delivery: {
      id: 'attachment-1', status: 'clipboard', clipboardVerified: true,
      attachments: [{ name: '方案.pdf', size: 2048, mime: 'application/pdf' }],
    },
  }, {});
  const markdown = value.body.elements.find((item) => item.tag === 'markdown').content;
  const actions = value.body.elements.flatMap((item) => item.behaviors || []).map((item) => item.value);
  assert.match(markdown, /方案\.pdf/);
  assert.match(markdown, /2 KB/);
  assert.match(markdown, /application\/pdf/);
  assert.match(markdown, /✅ 已进剪贴板/);
  assert.deepEqual(actions, [
    { ns: 'cc.attachment.paste', did: 'attachment-1' },
    { ns: 'cc.attachment.claude', did: 'attachment-1' },
  ]);
});

test('所有文本、卡片、任务、完成、失败与产物只用 im.message.create 主流直发', async () => {
  const creates = [];
  const client = { im: {
    message: {
      create: async (value) => { creates.push(value); return { code: 0, data: { message_id: `m-${creates.length}` } }; },
      reply: async () => assert.fail('禁止调用 im.message.reply'),
    },
    image: { create: async () => ({ image_key: 'img-up' }) },
    file: { create: async () => ({ file_key: 'file-up' }) },
  } };
  const service = new CardService({ client, ownerId: OWNER, log: {} });
  const task = {
    id: 't1', number: 8, project: 'demo', prompt: '触发摘要', triggerMessageId: 'source',
    status: 'done', createdAt: 1, startedAt: 2, finishedAt: 3, pendingPrompts: [], eventCount: 1,
  };
  const root = await mkdtemp(join(tmpdir(), 'cc-direct-send-'));
  const artifact = join(root, 'result.txt');
  await writeFile(artifact, 'result');
  await service.replyText('source', '命令响应');
  await service.replyNotice('source', { kind: 'help', title: '帮助', markdown: '内容' });
  await service.createTaskCard(task);
  await service.sendComplete(task);
  await service.sendFailure({ ...task, status: 'failed', error: '失败' });
  await service.sendArtifacts(task, [artifact]);
  assert.equal(creates.length, 6);
  assert.ok(creates.every((item) => item.params.receive_id_type === 'open_id'));
  assert.ok(creates.every((item) => item.data.receive_id === OWNER));
  assert.ok(creates.every((item) => !('reply_in_thread' in item.data)));
  await rm(root, { recursive: true, force: true });
});

test('引用回复按 parent_id 命中任务；无引用 task 消息回退最近活动/可恢复任务', async () => {
  const active = { id: 'active', number: 3, status: 'running' };
  const quoted = { id: 'quoted', number: 2, status: 'done', sessionId: 'session-2' };
  const calls = [];
  const store = {
    state: { settings: { inputMode: 'task' } },
    findTaskByMessage: (...ids) => ids.includes('card-quoted') ? quoted : null,
    findRecentTask: () => active,
  };
  const controller = {
    handleAskText: async () => false,
    handleText: async (text, context) => calls.push({ text, task: context.task }),
    handleCommand: async () => {},
  };
  const handler = createMessageHandler({
    ownerId: OWNER, store, controller, cards: { replyText: async () => {} },
    dedupe: new LruSet(20), log: {},
  });
  await handler(event({ id: 'quote-followup', parentId: 'card-quoted', content: { text: '精准追问' } }));
  await handler(event({ id: 'plain-followup', content: { text: '普通追问' } }));
  assert.equal(calls[0].task, quoted);
  assert.equal(calls[1].task, active);
});

test('SessionStore 最近任务规则为 running 优先，否则最近完成且有 session', () => {
  const store = new SessionStore();
  store.state.tasks = {
    doneOld: { id: 'done-old', status: 'done', sessionId: 's1', updatedAt: 100 },
    doneNew: { id: 'done-new', status: 'done', sessionId: 's2', updatedAt: 200 },
    failed: { id: 'failed', status: 'failed', sessionId: 's3', updatedAt: 400 },
  };
  assert.equal(store.findRecentTask().id, 'done-new');
  store.state.tasks.running = { id: 'running', status: 'running', updatedAt: 50 };
  assert.equal(store.findRecentTask().id, 'running');
});

test('控制器下载 input 附件、验证剪贴板、PATCH 大文件卡并支持粘贴/转 Claude', async () => {
  const calls = { cards: [], patches: [], clipboard: [], keys: [], tasks: [] };
  const delivery = {
    id: 'did-1', sourceMessageId: 'source-1', project: 'demo', status: 'copying',
    prompt: '请先读取该文件：\n/project/demo/.cc-bridge/incoming/source-1/a.pdf',
    attachments: [{ path: '/project/demo/.cc-bridge/incoming/source-1/a.pdf', name: 'a.pdf', size: 12 * 1024 * 1024, mime: 'application/pdf', resourceType: 'file' }],
  };
  const store = {
    state: { currentProject: 'demo', settings: { inputMode: 'input' } },
    projects: { demo: { path: '/project/demo' } },
    findTaskByMessage: () => null,
    currentProject: () => ({ name: 'demo', path: '/project/demo' }),
    resolveProject: () => ({ name: 'demo', path: '/project/demo' }),
    createInputDelivery: async (value) => Object.assign(delivery, value),
    updateInputDelivery: async (_id, patch) => Object.assign(delivery, patch),
    getInputDelivery: () => delivery,
  };
  const media = { prepareMediaMessage: async (_message, options) => {
    await options.onLargeDownload({ name: 'a.pdf', size: 12 * 1024 * 1024, mime: 'application/pdf' });
    return { prompt: delivery.prompt, attachments: delivery.attachments };
  } };
  const cards = {
    sendAttachmentReceipt: async (value) => { calls.cards.push(structuredClone(value)); return 'attachment-card'; },
    patchAttachmentReceipt: async (id, value) => calls.patches.push({ id, value: structuredClone(value) }),
    replyText: async () => 'ack',
  };
  const controller = new BridgeController({
    store, runner: {}, cards, approval: {}, media,
    attachmentClipboard: async (items) => {
      calls.clipboard.push(items.map((item) => item.path));
      return { verified: true, method: 'file-reference', clipboardInfo: '«class furl», 1' };
    },
    injector: { injectKey: async (key) => { calls.keys.push(key); return { ok: true }; } },
    log: {},
  });
  await controller.handleAttachment(event({ id: 'source-1', type: 'file', content: { file_key: 'f', file_name: 'a.pdf' } }).message);
  assert.equal(calls.cards[0].status, 'downloading');
  assert.equal(calls.patches[0].id, 'attachment-card');
  assert.equal(calls.patches[0].value.status, 'clipboard');
  assert.equal(calls.patches[0].value.clipboardVerified, true);

  controller.handleText = async (text, context) => { calls.tasks.push({ text, context }); return { id: 'task', number: 9 }; };
  await controller.handleCardAction({ ns: 'cc.attachment.paste', did: 'did-1' });
  await controller.handleCardAction({ ns: 'cc.attachment.claude', did: 'did-1' });
  assert.deepEqual(calls.keys, ['paste']);
  assert.equal(calls.clipboard.length, 2);
  assert.equal(calls.tasks[0].context.projectName, 'demo');
});

test('任务、完成、失败与语音确认卡信息自足，包含项目、任务号与触发消息摘要', () => {
  const task = {
    id: 't-info', number: 12, project: 'claudevoice', prompt: '请修复附件剪贴板体验',
    status: 'running', createdAt: Date.now(), pendingPrompts: [], eventCount: 0,
  };
  const value = cardModule.buildTaskCard(task, Date.now(), {});
  const markdown = value.body.elements.find((item) => item.tag === 'markdown').content;
  assert.match(value.header.title.content, /#12.*claudevoice/);
  assert.match(markdown, /请修复附件剪贴板体验/);
  for (const card of [
    cardModule.buildCompleteCard({ ...task, status: 'done', result: '完成', sessionId: 's1' }, {}),
    cardModule.buildFailureCard({ ...task, status: 'failed', error: '失败原因' }, {}),
    cardModule.buildVoiceConfirmationCard({ text: '语音任务', task, inputMode: 'task' }, {}),
  ]) {
    const body = card.body.elements.find((item) => item.tag === 'markdown').content;
    assert.match(`${card.header.title.content}\n${body}`, /claudevoice/);
    assert.match(`${card.header.title.content}\n${body}`, /#12/);
    assert.match(body, /请修复附件剪贴板体验/);
  }
});

test('bridge Worker 事件只留面板/SSE，不再投递 Web Push、Telegram 或飞书', () => {
  const eventValue = normalizeBridgePayload({
    source: 'bridge', noLark: true, noNotify: true,
    project: 'claudevoice', kind: 'done', title: '完成', detail: '测试',
  });
  assert.deepEqual(deliveryPlan(eventValue), []);
  assert.deepEqual(deliveryPlan({ source: 'hook', noLark: false }), ['push', 'telegram', 'lark']);
});
