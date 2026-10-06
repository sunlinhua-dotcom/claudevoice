import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

import { attachmentKind, BridgeController } from '../index.mjs';
import { buildMacCommand, describeRelayFailure, readMacPasteResult, RelayInjector } from '../inject.mjs';
import { SessionStore } from '../sessions.mjs';

const ack = (pasted, total, app = 'Claude', reason = '') => ({
  ok: pasted === total, mode: `cv:${JSON.stringify({ pasted, total, app, reason })}`,
});

function imageMessage(id) {
  return { message_id: id, message_type: 'image', content: JSON.stringify({ image_key: `img_${id}` }), parent_id: '', root_id: '' };
}

function fakeStore() {
  let seq = 0;
  const store = {
    state: { currentProject: 'demo', settings: { inputMode: 'input' }, inputDeliveries: {} },
    projects: { demo: { path: '/project/demo' } },
    findTaskByMessage: () => null,
    currentProject: () => ({ name: 'demo', path: '/project/demo' }),
    resolveProject: () => ({ name: 'demo', path: '/project/demo' }),
    createInputDelivery: async (value) => {
      const delivery = { id: `d${++seq}`, cardMessageId: '', status: 'copying', ...value };
      delivery.kind = value.kind || (value.attachments?.length ? 'attachment' : 'text');
      store.state.inputDeliveries[delivery.id] = delivery;
      return delivery;
    },
    updateInputDelivery: async (id, patch) => Object.assign(store.state.inputDeliveries[id], patch),
    getInputDelivery: (id) => store.state.inputDeliveries[id] || null,
  };
  return store;
}

function fakeCards() {
  const log = [];
  return {
    log,
    sendAttachmentReceipt: async (delivery) => { log.push({ op: 'send', ...structuredClone(delivery) }); return `card-${delivery.id}`; },
    patchAttachmentReceipt: async (id, delivery) => { log.push({ op: 'patch', card: id, ...structuredClone(delivery) }); },
    sendInputReceipt: async () => 'input-card',
    patchInputReceipt: async () => {},
    replyText: async () => 'ack',
  };
}

const media = {
  prepareMediaMessage: async (message) => {
    const path = `/project/demo/.cc-bridge/incoming/${message.message_id}/${message.message_id}.jpg`;
    return {
      prompt: `请先读取该图片：\n${path}`,
      attachments: [{ path, name: `${message.message_id}.jpg`, size: 1000, mime: 'image/jpeg', resourceType: 'image' }],
    };
  },
};

function fakeInjector({ paste = (items) => ack(items.length, items.length), text = { ok: true, mode: 'type' }, key = { ok: true, mode: 'type' } } = {}) {
  const calls = { paste: [], text: [], keys: [] };
  return {
    calls,
    pasteItems: async (items) => { calls.paste.push(items); return paste(items); },
    injectText: async (value) => { calls.text.push(value); if (text instanceof Error) throw text; return text; },
    injectKey: async (value) => { calls.keys.push(value); return key; },
  };
}

function makeController(options = {}) {
  const store = fakeStore();
  const cards = fakeCards();
  const injector = fakeInjector(options);
  const controller = new BridgeController({
    store, cards, injector, media, runner: {}, approval: {}, log: {}, batchIdleMs: options.batchIdleMs ?? 60_000,
  });
  return { store, cards, injector, controller };
}

test('连发两张图攒成一批：只发一张卡、一次指令贴两张，回一句话接在图后并回车', async () => {
  const { store, cards, injector, controller } = makeController();
  await controller.handleAttachment(imageMessage('m1'));
  await controller.handleAttachment(imageMessage('m2'));
  await controller.flushAttachmentBatch();

  assert.equal(injector.calls.paste.length, 1);
  assert.deepEqual(injector.calls.paste[0].map((item) => item.kind), ['image', 'image']);
  assert.equal(cards.log.filter((item) => item.op === 'send').length, 1);
  const [delivery] = Object.values(store.state.inputDeliveries);
  assert.equal(delivery.batchNumber, 1);
  assert.equal(delivery.status, 'pasted');
  assert.equal(delivery.pasteApp, 'Claude');
  assert.equal(delivery.pendingSubmit, true);
  assert.deepEqual(delivery.sourceMessageIds, ['m1', 'm2']);
  assert.equal(cards.log.at(-1).status, 'pasted');

  await controller.handleInput('对比这两张图', { message: { message_id: 'm3' } });
  assert.deepEqual(injector.calls.text, ['对比这两张图']);
  assert.deepEqual(injector.calls.keys, ['enter']);
  assert.equal(delivery.status, 'sent');
  assert.equal(delivery.submitText, '对比这两张图');
  assert.equal(delivery.pendingSubmit, false);
  assert.equal(Object.keys(store.state.inputDeliveries).length, 1, '指令并入批次，不另开文字投递');
  assert.equal(cards.log.at(-1).status, 'sent');

  await controller.handleInput('下一句是普通输入', { message: { message_id: 'm4' } });
  assert.equal(Object.keys(store.state.inputDeliveries).length, 2);
  assert.deepEqual(injector.calls.keys, ['enter'], '普通输入不自动回车');
});

test('停 batchIdleMs 没有新图就自动封批，第三张之后另开新批次', async () => {
  const { store, injector, controller } = makeController({ batchIdleMs: 20 });
  await controller.handleAttachment(imageMessage('a1'));
  await controller.handleAttachment(imageMessage('a2'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(injector.calls.paste.length, 1);
  assert.equal(injector.calls.paste[0].length, 2);

  await controller.handleAttachment(imageMessage('a3'));
  await new Promise((resolve) => setTimeout(resolve, 80));
  assert.equal(injector.calls.paste.length, 2);
  const numbers = Object.values(store.state.inputDeliveries).map((item) => item.batchNumber);
  assert.deepEqual(numbers, [1, 2]);
});

test('卡片「⏎ 发送」只按回车；两批都贴在同一个输入框时一起标为已发送', async () => {
  const { store, injector, controller } = makeController();
  await controller.handleAttachment(imageMessage('b1'));
  await controller.flushAttachmentBatch();
  await controller.handleAttachment(imageMessage('b2'));
  await controller.flushAttachmentBatch();
  const [first, second] = Object.values(store.state.inputDeliveries);
  await controller.handleCardAction({ ns: 'cc.attachment.enter', did: second.id });
  assert.deepEqual(injector.calls.text, []);
  assert.deepEqual(injector.calls.keys, ['enter']);
  assert.equal(first.status, 'sent');
  assert.equal(second.status, 'sent');
});

test('指令没打进输入框时不回车，免得只把图发出去', async () => {
  const { store, injector, controller } = makeController({ text: { ok: true, mode: 'clipboard' } });
  await controller.handleAttachment(imageMessage('c1'));
  await controller.flushAttachmentBatch();
  await controller.handleInput('帮我看看', { message: { message_id: 'c2' } });
  const [delivery] = Object.values(store.state.inputDeliveries);
  assert.deepEqual(injector.calls.keys, []);
  assert.equal(delivery.status, 'pasted');
  assert.equal(delivery.pendingSubmit, true);
  assert.match(delivery.submitError, /没有回车/);
});

test('旧版 App 不认识贴图指令：卡片写清原因，不进入待发送，下一句照常输入', async () => {
  const { store, injector, controller } = makeController({ paste: () => ({ ok: false, mode: 'failed' }) });
  await controller.handleAttachment(imageMessage('e1'));
  await controller.flushAttachmentBatch();
  const [delivery] = Object.values(store.state.inputDeliveries);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.error, /版本太旧/);
  assert.equal(delivery.pendingSubmit, false);
  await controller.handleInput('普通文字', { message: { message_id: 'e2' } });
  assert.equal(Object.keys(store.state.inputDeliveries).length, 2);
  assert.deepEqual(injector.calls.keys, []);
});

test('只贴进一部分：标 partial 并写原因，「重新粘贴」再走一次', async () => {
  let round = 0;
  const { store, injector, controller } = makeController({
    paste: (items) => (++round === 1 ? ack(1, items.length, 'Claude', '前台窗口中途切走了') : ack(items.length, items.length)),
  });
  await controller.handleAttachment(imageMessage('p1'));
  await controller.handleAttachment(imageMessage('p2'));
  await controller.flushAttachmentBatch();
  const [delivery] = Object.values(store.state.inputDeliveries);
  assert.equal(delivery.status, 'partial');
  assert.equal(delivery.pastedCount, 1);
  assert.match(delivery.error, /切走/);
  await controller.handleCardAction({ ns: 'cc.attachment.paste', did: delivery.id });
  assert.equal(injector.calls.paste.length, 2);
  assert.equal(delivery.status, 'pasted');
  assert.equal(delivery.error, '');
});

test('下载失败的附件写进卡片；整批都失败就不发贴图指令', async () => {
  const { store, injector, controller } = makeController();
  controller.media = { prepareMediaMessage: async () => { throw new Error('飞书资源已过期'); } };
  await controller.handleAttachment(imageMessage('x1'));
  await controller.flushAttachmentBatch();
  const [delivery] = Object.values(store.state.inputDeliveries);
  assert.equal(injector.calls.paste.length, 0);
  assert.equal(delivery.status, 'failed');
  assert.match(delivery.errors[0], /飞书资源已过期/);
});

test('文字输入不再依赖 cc-bridge 本机剪贴板：中继不通时如实标 failed', async () => {
  const { store, controller } = makeController({ text: new Error('RemoteVoice relay 未就绪（未配对或连接断开）') });
  const delivery = await controller.handleInput('你好', { message: { message_id: 't1' } });
  assert.equal(store.state.inputDeliveries[delivery.id].status, 'failed');
  assert.match(store.state.inputDeliveries[delivery.id].relayReason, /relay 未就绪/);
});

test('读回执：App 的 cv: 结果、中继的离线原因、旧版 App、超时', () => {
  assert.deepEqual(readMacPasteResult(ack(2, 2, 'Terminal'), 2), {
    ok: true, unconfirmed: false, pasted: 2, total: 2, app: 'Terminal', reason: '',
  });
  const partial = readMacPasteResult({ ok: false, mode: 'cv:{"pasted":1,"total":3,"app":"Claude","reason":"前台窗口中途切走了"}' }, 3);
  assert.equal(partial.ok, false);
  assert.equal(partial.pasted, 1);
  assert.match(readMacPasteResult({ ok: false, reason: 'mac_offline' }, 1).reason, /不在线/);
  assert.match(readMacPasteResult({ ok: false, mode: 'failed' }, 1).reason, /版本太旧/);
  assert.equal(readMacPasteResult({ ok: true, unconfirmed: true }, 1).unconfirmed, true);
  assert.match(describeRelayFailure({ ok: false, mode: 'failed' }), /辅助功能/);
});

test('RelayInjector.pasteItems 把贴图指令装进 inject_key 的 cv: 前缀', async () => {
  const frames = [];
  const injector = new RelayInjector({ url: 'wss://relay.invalid/ws', macId: 'mac-test', autoConnect: false, log: {} });
  injector.paired = true;
  injector.ws = {
    readyState: WebSocket.OPEN,
    send(json) {
      const frame = JSON.parse(json);
      frames.push(frame);
      queueMicrotask(() => injector.handleMessage({ type: 'inject_result', id: frame.id, ok: true, mode: ack(2, 2).mode }));
    },
  };
  const result = await injector.pasteItems([{ path: '/a b.jpg', kind: 'image' }, { path: '/c.pdf', kind: 'file', name: 'x' }], { waitMs: 10 });
  assert.equal(frames[0].type, 'inject_key');
  assert.equal(frames[0].key, buildMacCommand('paste_items', { items: [{ path: '/a b.jpg', kind: 'image' }, { path: '/c.pdf', kind: 'file' }] }));
  assert.equal(readMacPasteResult(result, 2).ok, true);
  await injector.pasteText('一段文字', { waitMs: 10, ackMs: 50 });
  assert.deepEqual(JSON.parse(frames[1].key.slice(3)), { op: 'paste_text', text: '一段文字' });
  injector.close();
});

test('附件类型判断与批次号持久化', async () => {
  assert.equal(attachmentKind({ mime: 'image/png' }), 'image');
  assert.equal(attachmentKind({ path: '/x/IMG_1.HEIC', mime: 'application/octet-stream' }), 'image');
  assert.equal(attachmentKind({ path: '/x/a.pdf', mime: 'application/pdf' }), 'file');
  const dir = await mkdtemp(join(tmpdir(), 'cc-batch-seq-'));
  try {
    const store = new SessionStore({ dir });
    assert.equal(store.nextBatchNumber(), 1);
    assert.equal(store.nextBatchNumber(), 2);
    const delivery = await store.createInputDelivery({ text: '', messageId: '', kind: 'attachment' });
    assert.equal(delivery.kind, 'attachment');
    const saved = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
    assert.equal(saved.batchSeq, 2, '批次号随 save 落盘，重启后接着编');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
