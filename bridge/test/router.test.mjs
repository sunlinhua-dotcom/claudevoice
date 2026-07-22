import test from 'node:test';
import assert from 'node:assert/strict';
import { createCardActionHandler, createMessageHandler, LruSet, parseCommand } from '../router.mjs';

const OWNER = 'ou_owner';

function event({ id = 'm1', openId = OWNER, text = '你好', rootId = '', parentId = '', type = 'text', content } = {}) {
  return {
    sender: { sender_id: { open_id: openId } },
    message: { message_id: id, message_type: type, content: content || JSON.stringify({ text }), root_id: rootId, parent_id: parentId, chat_type: 'p2p' },
  };
}

function harness({ transcribeAudio, media, askText } = {}) {
  const calls = { replies: [], notices: [], voiceCards: [], commands: [], texts: [], injects: [], actions: [] };
  const task = { id: 'task_1', number: 1, status: 'running', rootId: 'root_1' };
  const store = { state: { settings: { inputMode: 'task' } }, findTaskByMessage: (...ids) => ids.includes('root_1') ? task : null };
  const cards = {
    replyText: async (id, text) => calls.replies.push({ id, text }),
    replyNotice: async (id, notice) => calls.notices.push({ id, notice }),
    sendVoiceConfirmation: async (value) => calls.voiceCards.push(value),
  };
  const controller = {
    handleCommand: async (command, context) => calls.commands.push({ command, context }),
    handleText: async (text, context) => { calls.texts.push({ text, context }); return task; },
    handleInput: async (text, context) => calls.injects.push({ text, context }),
    handleCardAction: async (value) => calls.actions.push(value),
  };
  if (askText) controller.handleAskText = askText;
  const injector = { injectText: async (text) => { calls.injects.push(text); return { ok: true }; } };
  const handler = createMessageHandler({ ownerId: OWNER, store, controller, cards, injector, transcribeAudio, media, dedupe: new LruSet(10), log: {} });
  return { calls, task, handler, controller };
}

test('命令解析支持斜杠与中文别名', () => {
  assert.deepEqual(parseCommand('/use 2'), { name: 'use', args: '2' });
  assert.deepEqual(parseCommand('项目列表'), { name: 'projects', args: '' });
  assert.deepEqual(parseCommand('切到 remotevoice'), { name: 'use', args: 'remotevoice' });
  assert.deepEqual(parseCommand('停止 7'), { name: 'stop', args: '7' });
  assert.equal(parseCommand('普通任务'), null);
});

test('非主人只能收到固定拒绝回复', async () => {
  const { calls, handler } = harness();
  await handler(event({ openId: 'ou_other', text: '/status' }));
  assert.equal(calls.replies[0].text, '此机器人仅服务主人');
  assert.equal(calls.commands.length, 0);
  assert.equal(calls.texts.length, 0);
});

test('message_id LRU 去重避免重复执行', async () => {
  const { calls, handler } = harness();
  const data = event({ id: 'same', text: '任务 A' });
  await handler(data);
  await handler(data);
  assert.equal(calls.texts.length, 1);
});

test('parent_id 引用任务卡时路由为精准追问', async () => {
  const { calls, task, handler } = harness();
  await handler(event({ id: 'followup', parentId: 'root_1', text: '继续解释' }));
  assert.equal(calls.texts.length, 1);
  assert.equal(calls.texts[0].context.task, task);
});

test('注入前缀优先于 Claude 命令路由', async () => {
  const { calls, handler } = harness();
  await handler(event({ id: 'inject', text: '/type hello' }));
  assert.deepEqual(calls.injects.map((item) => item.text), ['hello']);
  assert.equal(calls.commands.length, 0);
});

test('task 模式语音引用任务卡后路由为追问并发送可改道确认卡', async () => {
  const transcribeAudio = async (message) => {
    assert.equal(JSON.parse(message.content).file_key, 'audio-key');
    return '继续解释语音内容';
  };
  const { calls, task, handler } = harness({ transcribeAudio });
  await handler(event({ id: 'audio-1', type: 'audio', content: JSON.stringify({ file_key: 'audio-key' }), parentId: 'root_1' }));
  assert.equal(calls.texts[0].text, '继续解释语音内容');
  assert.equal(calls.texts[0].context.task, task);
  assert.equal(calls.voiceCards[0].text, '继续解释语音内容');
  assert.equal(calls.voiceCards[0].task, task);
});

test('语音识别为空或失败时友好提示且不创建任务', async () => {
  const empty = harness({ transcribeAudio: async () => '  ' });
  await empty.handler(event({ id: 'audio-empty', type: 'audio', content: JSON.stringify({ file_key: 'a' }) }));
  assert.match(empty.calls.replies[0].text, /没有识别到清晰文字/);
  assert.equal(empty.calls.texts.length, 0);

  const failed = harness({ transcribeAudio: async () => { throw new Error('ffmpeg 不可用'); } });
  await failed.handler(event({ id: 'audio-failed', type: 'audio', content: JSON.stringify({ file_key: 'b' }) }));
  assert.match(failed.calls.replies[0].text, /语音识别失败.*ffmpeg 不可用/);
  assert.equal(failed.calls.texts.length, 0);
});

test('图片与图文消息下载后用增强 prompt 进入普通任务路径', async () => {
  const media = { prepareImageMessage: async (message) => ({ prompt: `看图任务\n\n请先读取该图片：\n/tmp/${message.message_id}.png` }) };
  const { calls, handler } = harness({ media });
  await handler(event({ id: 'image-1', type: 'image', content: JSON.stringify({ image_key: 'img' }) }));
  assert.match(calls.texts[0].text, /^看图任务/);
  assert.match(calls.texts[0].text, /请先读取该图片/);
});

test('文件消息使用项目内媒体管道进入普通任务路径', async () => {
  const media = { prepareMediaMessage: async (_message, options) => {
    assert.equal(options.projectPath, '/project/demo');
    return { prompt: '阅读文件\n\n请先读取该文件：\n/project/demo/.cc-bridge/incoming/m/file.pdf' };
  } };
  const { calls, handler } = harness({ media });
  handler;
  const store = {
    state: { currentProject: 'demo', settings: { inputMode: 'task' } }, projects: { demo: { path: '/project/demo' } },
    findTaskByMessage: () => null,
  };
  const controller = { handleText: async (text) => calls.texts.push({ text }), handleAskText: async () => false };
  const cards = { replyText: async () => {} };
  const fileHandler = createMessageHandler({ ownerId: OWNER, store, controller, cards, injector: {}, media, log: {} });
  await fileHandler(event({ id: 'file-1', type: 'file', content: JSON.stringify({ file_key: 'f', file_name: 'file.pdf' }) }));
  assert.match(calls.texts[0].text, /\.cc-bridge\/incoming/);
});

test('回复 ask_user 主流卡的文字优先作为答案，不创建新任务', async () => {
  const answered = [];
  const { calls, handler } = harness({ askText: async (text, message) => {
    answered.push({ text, parent: message.parent_id });
    return true;
  } });
  await handler(event({ id: 'ask-reply', parentId: 'ask-card-1', text: '自定义答案' }));
  assert.deepEqual(answered, [{ text: '自定义答案', parent: 'ask-card-1' }]);
  assert.equal(calls.texts.length, 0);
});

test('cc 卡片动作快速 ACK 后异步执行', async () => {
  const { calls, controller } = harness();
  const handler = createCardActionHandler({ ownerId: OWNER, controller, log: {} });
  const response = await handler({ operator: { open_id: OWNER }, action: { value: { ns: 'cc', act: 'approve', rid: 'r1' } } });
  assert.equal(response.toast.type, 'success');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.actions[0].rid, 'r1');

  const askResponse = await handler({ operator: { open_id: OWNER }, action: { value: { ns: 'cc.ask', act: 'select', rid: 'r2', index: 1 } } });
  assert.equal(askResponse.toast.content, '已记录选择');
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.actions[1].index, 1);
});
