import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { BridgeController } from '../index.mjs';
import {
  buildInputReceiptCard,
  buildVoiceConfirmationCard,
} from '../cards.mjs';
import {
  copyTextToClipboard,
  RelayInjector,
} from '../inject.mjs';
import {
  classifyTextRoute,
  createCardActionHandler,
  createMessageHandler,
  LruSet,
  parseCommand,
} from '../router.mjs';
import { SessionStore } from '../sessions.mjs';

const OWNER = 'ou_owner';

function textEvent(text, { id = 'm1', type = 'text', rootId = '', content } = {}) {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: {
      message_id: id,
      message_type: type,
      content: content || JSON.stringify({ text }),
      root_id: rootId,
      chat_type: 'p2p',
    },
  };
}

function cardValues(card) {
  return card.body.elements.flatMap((element) => element.behaviors || []).map((behavior) => behavior.value);
}

test('pbcopy 使用 spawn 参数数组并通过 stdin 原样写入文本', async () => {
  const calls = [];
  const spawnImpl = (command, args, options) => {
    const child = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = new EventEmitter();
    child.stdin.end = (value) => {
      calls.push({ command, args, options, value: Buffer.from(value).toString('utf8') });
      queueMicrotask(() => child.emit('close', 0));
    };
    return child;
  };
  const payload = '原样文本; $(不会执行)\n第二行';
  await copyTextToClipboard(payload, { spawnImpl });
  assert.deepEqual(calls, [{
    command: 'pbcopy',
    args: [],
    options: { stdio: ['pipe', 'ignore', 'pipe'] },
    value: payload,
  }]);
});

test('relay inject_key 使用同一 id 等待 App inject_ack 经 Worker 转成的 inject_result', async () => {
  const frames = [];
  const injector = new RelayInjector({ url: 'wss://relay.invalid/ws', macId: 'mac-test', autoConnect: false, log: {} });
  injector.paired = true;
  injector.ws = {
    readyState: WebSocket.OPEN,
    send(json) {
      const frame = JSON.parse(json);
      frames.push(frame);
      queueMicrotask(() => injector.handleMessage({ type: 'inject_result', id: frame.id, ok: true, mode: 'type', delivered: true }));
    },
  };
  const result = await injector.injectKey('enter', { waitMs: 10, ackMs: 100 });
  assert.equal(frames.length, 1);
  assert.equal(frames[0].type, 'inject_key');
  assert.equal(frames[0].key, 'enter');
  assert.ok(frames[0].id);
  assert.deepEqual(result, { type: 'inject_result', id: frames[0].id, ok: true, mode: 'type', delivered: true });
  injector.close();
});

test('新 state 默认 input；旧版 task 一次性迁移 input，之后显式 task 仍持久化', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-input-state-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'cc-input-workspace-'));
  const first = await new SessionStore({ dir, workspaceRoot }).init();
  assert.equal(first.state.settings.inputMode, 'input');
  const delivery = await first.createInputDelivery({ text: '需要持久化', messageId: 'm-persist', origin: 'text' });
  await first.setInputMode('task');
  const second = await new SessionStore({ dir, workspaceRoot }).init();
  assert.equal(second.state.settings.inputMode, 'task');
  assert.equal(second.getInputDelivery(delivery.id).text, '需要持久化');
  assert.equal(JSON.parse(await readFile(join(dir, 'state.json'), 'utf8')).settings.inputMode, 'task');

  const legacyDir = await mkdtemp(join(tmpdir(), 'cc-input-legacy-'));
  await writeFile(join(legacyDir, 'state.json'), `${JSON.stringify({ version: 1, settings: { mode: 'default', model: '', inputMode: 'task' } })}\n`);
  const migrated = await new SessionStore({ dir: legacyDir, workspaceRoot }).init();
  assert.equal(migrated.state.version, 2);
  assert.equal(migrated.state.settings.inputMode, 'input');
  await migrated.setInputMode('task');
  const migratedAgain = await new SessionStore({ dir: legacyDir, workspaceRoot }).init();
  assert.equal(migratedAgain.state.settings.inputMode, 'task');
  await rm(dir, { recursive: true, force: true });
  await rm(legacyDir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test('进程重启时 running/stopping 任务都收敛为失败，避免永久僵尸态', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-restart-state-'));
  const workspaceRoot = await mkdtemp(join(tmpdir(), 'cc-restart-workspace-'));
  const first = await new SessionStore({ dir, workspaceRoot }).init();
  const running = await first.createTask({ project: 'demo', prompt: 'running', messageId: 'm-running' });
  const stopping = await first.createTask({ project: 'demo', prompt: 'stopping', messageId: 'm-stopping' });
  await first.updateTask(running.id, { status: 'running' });
  await first.updateTask(stopping.id, { status: 'stopping' });
  const second = await new SessionStore({ dir, workspaceRoot }).init();
  assert.equal(second.getTask(running.id).status, 'failed');
  assert.equal(second.getTask(stopping.id).status, 'failed');
  assert.match(second.getTask(stopping.id).error, /重启/);
  await rm(dir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
});

test('双模式命令与前缀覆盖具有确定优先级', () => {
  assert.deepEqual(parseCommand('/input'), { name: 'input', args: '' });
  assert.deepEqual(parseCommand('输入模式'), { name: 'input', args: '' });
  assert.deepEqual(parseCommand('/task'), { name: 'task', args: '' });
  assert.deepEqual(parseCommand('任务模式'), { name: 'task', args: '' });
  assert.deepEqual(classifyTextRoute('/status', 'input'), { kind: 'command', text: '/status' });
  assert.deepEqual(classifyTextRoute('/type hello', 'task'), { kind: 'input', text: 'hello', forced: true });
  assert.deepEqual(classifyTextRoute('注入 你好', 'task'), { kind: 'input', text: '你好', forced: true });
  assert.deepEqual(classifyTextRoute('任务 修复按钮', 'input'), { kind: 'task', text: '修复按钮', forced: true });
  assert.deepEqual(classifyTextRoute('普通文字', 'input'), { kind: 'input', text: '普通文字', forced: false });
  assert.deepEqual(classifyTextRoute('普通文字', 'task'), { kind: 'task', text: '普通文字', forced: false });
});

test('注入回执卡包含文本、三动作和当前模式切换，全部使用 cc.inject.* namespace', () => {
  const card = buildInputReceiptCard({
    delivery: { id: 'd1', text: '测试输入', status: 'typed', relayMode: 'type' },
    inputMode: 'input',
  }, {});
  const markdown = card.body.elements.find((element) => element.tag === 'markdown').content;
  assert.match(markdown, /测试输入/);
  assert.match(markdown, /已注入/);
  assert.deepEqual(cardValues(card), [
    { ns: 'cc.inject.paste', did: 'd1' },
    { ns: 'cc.inject.enter', did: 'd1' },
    { ns: 'cc.inject.claude', did: 'd1' },
    { ns: 'cc.inject.mode', mode: 'task', did: 'd1' },
  ]);
});

test('task 模式语音确认卡可改为电脑输入并可切换当前模式', () => {
  const card = buildVoiceConfirmationCard({ text: '语音任务内容', task: { id: 't1', number: 7 }, inputMode: 'task' }, {});
  assert.match(card.body.elements.find((element) => element.tag === 'markdown').content, /语音任务内容/);
  assert.deepEqual(cardValues(card), [
    { ns: 'cc.inject.convert', tid: 't1' },
    { ns: 'cc.inject.mode', mode: 'input', tid: 't1' },
  ]);
});

test('input 模式文字直达输入投递且不进入 Claude；任务前缀反向覆盖', async () => {
  const calls = { inputs: [], tasks: [], commands: [] };
  const store = {
    state: { settings: { inputMode: 'input' } },
    findTaskByMessage: () => ({ id: 'linked-task' }),
  };
  const controller = {
    handleAskText: async () => false,
    handleInput: async (text, context) => calls.inputs.push({ text, context }),
    handleText: async (text, context) => calls.tasks.push({ text, context }),
    handleCommand: async (command) => calls.commands.push(command),
  };
  const cards = { replyText: async () => {}, sendVoiceConfirmation: async () => {} };
  const handler = createMessageHandler({ ownerId: OWNER, store, controller, cards, dedupe: new LruSet(20), log: {} });
  await handler(textEvent('直接输入', { id: 'input-normal', rootId: 'known-thread' }));
  await handler(textEvent('任务 强制交给 Claude', { id: 'task-forced' }));
  assert.deepEqual(calls.inputs.map((item) => item.text), ['直接输入']);
  assert.equal(calls.inputs[0].context.task, null);
  assert.deepEqual(calls.tasks.map((item) => item.text), ['强制交给 Claude']);
});

test('task 模式语音创建 Claude 任务后发送带任务 id 的确认卡', async () => {
  const calls = { tasks: [], voiceCards: [] };
  const task = { id: 'voice-task', number: 9 };
  const store = { state: { settings: { inputMode: 'task' } }, findTaskByMessage: () => null };
  const controller = {
    handleAskText: async () => false,
    handleInput: async () => assert.fail('不应走输入'),
    handleText: async (text) => { calls.tasks.push(text); return task; },
    handleCommand: async () => {},
  };
  const cards = {
    replyText: async () => {},
    sendVoiceConfirmation: async (value) => calls.voiceCards.push(value),
  };
  const handler = createMessageHandler({
    ownerId: OWNER, store, controller, cards, dedupe: new LruSet(20), log: {},
    transcribeAudio: async () => '请检查项目',
  });
  await handler(textEvent('', { id: 'voice-1', type: 'audio', content: JSON.stringify({ file_key: 'audio' }) }));
  assert.deepEqual(calls.tasks, ['请检查项目']);
  assert.equal(calls.voiceCards[0].task, task);
  assert.equal(calls.voiceCards[0].inputMode, 'task');
});

test('cc.inject 四类按钮回调被接收并异步交给 controller', async () => {
  const actions = [];
  const handler = createCardActionHandler({
    ownerId: OWNER,
    controller: { handleCardAction: async (value) => actions.push(value) },
    log: {},
  });
  for (const ns of ['cc.inject.paste', 'cc.inject.enter', 'cc.inject.claude', 'cc.inject.mode']) {
    const response = await handler({ operator: { open_id: OWNER }, action: { value: { ns, did: 'd1' } } });
    assert.equal(response.toast.type, 'success');
  }
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(actions.map((item) => item.ns), ['cc.inject.paste', 'cc.inject.enter', 'cc.inject.claude', 'cc.inject.mode']);
});

test('controller 模拟粘贴、回车、转 Claude、切模式并停止语音任务改道', async () => {
  const calls = { copied: [], keys: [], modes: [], tasks: [], inputs: [], stops: [], replies: [] };
  const delivery = { id: 'd1', text: '回调文本', sourceMessageId: 'source-1' };
  const voiceTask = { id: 't1', number: 5, status: 'running', prompt: '语音任务', triggerMessageId: 'voice-source', rootId: 'voice-source' };
  const store = {
    state: { settings: { inputMode: 'task' } },
    getInputDelivery: (id) => id === 'd1' ? delivery : null,
    getTask: (id) => id === 't1' ? voiceTask : null,
    setInputMode: async (mode) => { store.state.settings.inputMode = mode; calls.modes.push(mode); },
    stopTask: async (id) => { calls.stops.push(id); voiceTask.status = 'stopping'; return voiceTask; },
  };
  const controller = new BridgeController({
    store,
    runner: {},
    cards: { replyText: async (id, text) => calls.replies.push({ id, text }) },
    approval: {},
    injector: {
      injectKey: async (key) => { calls.keys.push(key); return { ok: true, mode: 'type' }; },
      pasteText: async (text) => { calls.copied.push(text); return { ok: true }; },
    },
    log: {},
  });
  controller.handleText = async (text, context) => calls.tasks.push({ text, context });
  controller.handleInput = async (text, context) => calls.inputs.push({ text, context });

  await controller.handleCardAction({ ns: 'cc.inject.paste', did: 'd1' });
  await controller.handleCardAction({ ns: 'cc.inject.enter', did: 'd1' });
  await controller.handleCardAction({ ns: 'cc.inject.claude', did: 'd1' });
  await controller.handleCardAction({ ns: 'cc.inject.mode', mode: 'input', did: 'd1' });
  await controller.handleCardAction({ ns: 'cc.inject.convert', tid: 't1' });

  assert.deepEqual(calls.copied, ['回调文本']);
  assert.deepEqual(calls.keys, ['enter']);
  assert.deepEqual(calls.tasks.map((item) => item.text), ['回调文本']);
  assert.deepEqual(calls.modes, ['input']);
  assert.deepEqual(calls.stops, ['t1']);
  assert.deepEqual(calls.inputs.map((item) => item.text), ['语音任务']);
  assert.match(calls.replies.at(-1).text, /已停止.*#5.*输入到电脑/);
});
