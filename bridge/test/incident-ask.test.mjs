import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  ApprovalServer,
  isBridgeMediaPermission,
} from '../approval-server.mjs';
import {
  buildApprovalCard,
  buildAskUserCard,
  buildTaskCard,
  CardService,
} from '../cards.mjs';
import { MediaStore } from '../media.mjs';
import { ClaudeRunner } from '../runner.mjs';
import { createMessageHandler, parseCommand } from '../router.mjs';
import { BridgeController } from '../index.mjs';

const task = (patch = {}) => ({
  id: 'task-1', number: 7, project: 'claudevoice', prompt: '请检查用户发来的图片并说明问题',
  triggerMessageId: 'trigger-1', taskCardMessageId: 'task-card-1', status: 'running',
  mode: 'default', model: '', createdAt: Date.now(), startedAt: Date.now(), finishedAt: 0,
  currentTool: '', toolHistory: [], pendingPrompts: [], eventCount: 0, round: 1,
  ...patch,
});

test('媒体存进项目内 .cc-bridge/incoming 并清理 24h 旧目录', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'cc-media-project-'));
  const oldDir = join(projectPath, '.cc-bridge', 'incoming', 'old-message');
  await mkdir(oldDir, { recursive: true });
  await writeFile(join(oldDir, 'old.jpg'), 'old');
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  await import('node:fs/promises').then(({ utimes }) => utimes(oldDir, old, old));

  const writes = [];
  const client = {
    im: { messageResource: { get: async () => ({
      headers: { 'content-type': 'image/jpeg' },
      writeFile: async (path) => { writes.push(path); await writeFile(path, Buffer.from('ffd8ff', 'hex')); },
    }) } },
  };
  const media = new MediaStore({ client, projectPaths: [projectPath] });
  assert.equal(await media.init(), 1);
  const prepared = await media.prepareMediaMessage({
    message_id: 'om-image', message_type: 'image', content: JSON.stringify({ image_key: 'img-key' }),
  }, { projectPath });
  assert.match(prepared.paths[0], new RegExp(`${projectPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/\\.cc-bridge/incoming/om-image/`));
  assert.equal(writes.length, 1);
  const preparedFile = await media.prepareMediaMessage({
    message_id: 'om-file', message_type: 'file', content: JSON.stringify({ file_key: 'file-key', file_name: '需求.pdf' }),
  }, { projectPath });
  assert.match(preparedFile.paths[0], /\.cc-bridge\/incoming\/om-file\/需求\.pdf$/);
  assert.match(preparedFile.prompt, /请先读取该文件/);
  await assert.rejects(readFile(join(oldDir, 'old.jpg')), /ENOENT/);
  await rm(projectPath, { recursive: true, force: true });
});

test('启动清理不为尚未收过媒体的项目创建空 .cc-bridge', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'cc-media-empty-project-'));
  const media = new MediaStore({ client: {}, projectPaths: [projectPath] });
  assert.equal(await media.init(), 0);
  assert.equal(existsSync(join(projectPath, '.cc-bridge')), false);
  await rm(projectPath, { recursive: true, force: true });
});

test('Read/Glob 仅对 bridge 自存新旧媒体路径自动放行', () => {
  const projectPath = '/path/to/claudevoice';
  assert.equal(isBridgeMediaPermission('Read', { file_path: `${projectPath}/.cc-bridge/incoming/m1/a.jpg` }, { projectPaths: [projectPath] }), true);
  assert.equal(isBridgeMediaPermission('Glob', { path: `${projectPath}/.cc-bridge/incoming/m1`, pattern: '*.jpg' }, { projectPaths: [projectPath] }), true);
  assert.equal(isBridgeMediaPermission('Read', { file_path: '/Users/test/.claude/cc-bridge-tmp/m1/a.jpg' }, { legacyRoot: '/Users/test/.claude/cc-bridge-tmp' }), true);
  assert.equal(isBridgeMediaPermission('Write', { file_path: `${projectPath}/.cc-bridge/incoming/m1/a.jpg` }, { projectPaths: [projectPath] }), false);
  assert.equal(isBridgeMediaPermission('Read', { file_path: `${projectPath}/README.md` }, { projectPaths: [projectPath] }), false);
});

test('模拟 image 事件端到端完成，项目内媒体 Read 自动放行且不发审批卡', async () => {
  const projectPath = await mkdtemp(join(tmpdir(), 'cc-image-e2e-'));
  const taskValue = task({
    id: 'image-task', project: 'demo', prompt: '', pendingPrompts: [], status: 'running', taskCardMessageId: 'task-card',
  });
  let approvals = 0;
  let completes = 0;
  const store = {
    state: { currentProject: 'demo', settings: { inputMode: 'task' } }, projects: { demo: { path: projectPath } },
    getTask: () => taskValue, findTaskByMessage: () => null, mapMessage() {}, save: async () => {}, recordSession: async () => {},
    updateTask: async (_id, patch) => Object.assign(taskValue, patch),
  };
  const cards = {
    sendApproval: async () => { approvals += 1; return 'unexpected-approval'; },
    updateTaskCard() {}, sendComplete: async () => { completes += 1; return 'complete-card'; }, sendFailure: async () => 'failure-card',
  };
  const approval = new ApprovalServer({ store, cards, token: 'token', port: 0, timeoutMs: 20, log: {} });
  const address = await approval.start();
  const runner = { run: ({ prompt }) => ({
    promise: (async () => {
      const mediaPath = prompt.trim().split('\n').at(-1);
      const response = await fetch(`http://127.0.0.1:${address.port}/permission`, {
        method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
        body: JSON.stringify({ taskId: taskValue.id, toolName: 'Read', input: { file_path: mediaPath } }),
      });
      const decision = await response.json();
      assert.equal(decision.behavior, 'allow');
      return { ok: true, result: '图片已读取并完成分析', sessionId: 's-image', eventCount: 2, stderrTail: '' };
    })(),
    stop() {}, pauseTimeout() {}, resumeTimeout() {},
  }) };
  const controller = new BridgeController({ store, runner, cards, approval, log: {} });
  let execution;
  controller.handleText = async (text) => {
    taskValue.prompt = text;
    taskValue.pendingPrompts = [{ text, messageId: 'om-image-e2e', rootId: 'om-image-e2e' }];
    execution = controller.executeTask(taskValue, {});
    return taskValue;
  };
  const media = new MediaStore({
    projectPaths: [projectPath],
    client: { im: { messageResource: { get: async () => ({
      headers: { 'content-type': 'image/jpeg' }, writeFile: async (path) => writeFile(path, Buffer.from('ffd8ff', 'hex')),
    }) } } },
  });
  await media.init();
  const handler = createMessageHandler({
    ownerId: 'owner', store, controller, cards: { ...cards, replyText: async () => {} }, injector: {}, media, log: {},
  });
  await handler({
    sender: { sender_id: { open_id: 'owner' } },
    message: { message_id: 'om-image-e2e', message_type: 'image', content: JSON.stringify({ image_key: 'img' }) },
  });
  await execution;
  assert.equal(taskValue.status, 'done');
  assert.equal(approvals, 0);
  assert.equal(completes, 1);
  await approval.close();
  await rm(projectPath, { recursive: true, force: true });
});

test('审批超时毫秒级 deny、恢复任务计时并 PATCH 终态', async () => {
  const value = task();
  const events = [];
  const patches = [];
  const store = {
    getTask: () => value, mapMessage() {}, save: async () => {},
    beginTaskWait: async (_id, kind) => events.push(`pause:${kind}`),
    endTaskWait: async (_id, kind) => events.push(`resume:${kind}`),
  };
  const cards = {
    sendApproval: async () => 'approval-card-1',
    patchApproval: async (...args) => patches.push(args),
    updateTaskCard() {},
  };
  const server = new ApprovalServer({ store, cards, token: 'x', timeoutMs: 15, log: {} });
  const result = await server.request({ task: value, toolName: 'Write', input: { file_path: '/tmp/x' } });
  assert.equal(result.behavior, 'deny');
  assert.match(result.message, /超时/);
  assert.deepEqual(events, ['pause:approval', 'resume:approval']);
  assert.equal(patches[0][0], 'approval-card-1');
  assert.equal(patches[0][1].status, 'denied');
});

test('任务超时 SIGTERM；暂停等待期间不消耗任务预算', async () => {
  const runner = new ClaudeRunner({ claudeBin: process.execPath, timeoutMs: 30 });
  runner.buildArgs = () => ['-e', 'setInterval(() => {}, 1000)'];
  const running = runner.run({ taskId: 't', cwd: tmpdir(), prompt: 'x' });
  running.pauseTimeout('approval');
  const early = await Promise.race([running.promise.then(() => 'settled'), new Promise((resolve) => setTimeout(() => resolve('waiting'), 55))]);
  assert.equal(early, 'waiting');
  running.resumeTimeout('approval');
  const result = await running.promise;
  assert.equal(result.timedOut, true);
  assert.equal(result.signal, 'SIGTERM');
});

test('审批卡、ask_user 卡与任务卡全在主聊天流直发，包含项目、任务号和触发摘要', async () => {
  const creates = [];
  const replies = [];
  const client = { im: { message: {
    create: async (value) => { creates.push(value); return { code: 0, data: { message_id: `direct-${creates.length}` } }; },
    reply: async (value) => { replies.push(value); return { code: 0, data: { message_id: `thread-${replies.length}` } }; },
  } } };
  const cards = new CardService({ client, ownerId: 'owner-1' });
  const value = task();
  await cards.sendApproval(value, { rid: 'r1', toolName: 'Write', input: {} });
  await cards.sendAskUser(value, { rid: 'r2', question: '选 A 还是 B？', options: ['A', 'B'], allowCustom: true });
  await cards.createTaskCard(value);
  assert.equal(creates.length, 3);
  assert.equal(replies.length, 0);
  const approvalJson = creates[0].data.content;
  assert.match(approvalJson, /claudevoice/);
  assert.match(approvalJson, /#7/);
  assert.match(approvalJson, /请检查用户发来的图片/);
  const ask = JSON.parse(creates[1].data.content);
  const values = ask.body.elements.flatMap((item) => item.behaviors || []).map((item) => item.value);
  assert.deepEqual(values, [
    { ns: 'cc.ask', act: 'select', rid: 'r2', index: 0 },
    { ns: 'cc.ask', act: 'select', rid: 'r2', index: 1 },
  ]);
});

test('ask_user 按钮选 B 返回 B、PATCH 所选并恢复与审批一致的计时策略', async () => {
  const value = task();
  const waits = [];
  const patches = [];
  const store = {
    getTask: () => value, mapMessage() {}, save: async () => {},
    beginTaskWait: async (_id, kind) => waits.push(`pause:${kind}`),
    endTaskWait: async (_id, kind) => waits.push(`resume:${kind}`),
  };
  const cards = {
    sendAskUser: async () => 'ask-card-1', patchAskUser: async (...args) => patches.push(args), updateTaskCard() {},
  };
  const server = new ApprovalServer({ store, cards, token: 'x', askTimeoutMs: 1000, log: {} });
  const pending = server.requestAsk({ task: value, question: '选 A 还是 B？', options: ['A', 'B'], allowCustom: true });
  await new Promise((resolve) => setImmediate(resolve));
  const rid = server.pendingAsk.keys().next().value;
  assert.equal(await server.resolveAsk(rid, { index: 1 }), true);
  const result = await pending;
  assert.equal(result.answer, 'B');
  assert.deepEqual(waits, ['pause:ask', 'resume:ask']);
  assert.equal(patches[0][1].answer, 'B');
});

test('ask_user 15 分钟策略可毫秒快测并返回最佳判断兜底', async () => {
  const value = task();
  const store = { mapMessage() {}, save: async () => {}, beginTaskWait: async () => {}, endTaskWait: async () => {} };
  const cards = { sendAskUser: async () => 'ask-card-2', patchAskUser: async () => {}, updateTaskCard() {} };
  const server = new ApprovalServer({ store, cards, token: 'x', askTimeoutMs: 12, log: {} });
  const result = await server.requestAsk({ task: value, question: '选 A 还是 B？', options: ['A', 'B'], allowCustom: true });
  assert.equal(result.answer, '用户未回应，请按你的最佳判断继续');
  assert.equal(result.timedOut, true);
});

test('任务卡等待 ask_user 时显示专用状态且 active 耗时扣除等待', () => {
  const now = Date.now();
  const value = buildTaskCard(task({ startedAt: now - 10_000, waitingFor: 'ask', waitingStartedAt: now - 6_000, waitAccumulatedMs: 1_000 }), now, {});
  const markdown = value.body.elements.find((item) => item.tag === 'markdown').content;
  assert.match(markdown, /⏳ 等待你在飞书选择/);
  assert.match(markdown, /3 秒/);
});

test('失败任务卡展示事故修复说明', () => {
  const value = buildTaskCard(task({ status: 'failed', finishedAt: Date.now(), error: '图片审批链路缺陷已修复，请重发' }), Date.now(), {});
  const markdown = value.body.elements.find((item) => item.tag === 'markdown').content;
  assert.match(markdown, /图片审批链路缺陷已修复，请重发/);
});

test('中文命令别名覆盖帮助/状态/项目列表/新建/停止/清空/模式/模型', () => {
  assert.deepEqual(parseCommand('新建 claudevoice 修复问题'), { name: 'new', args: 'claudevoice 修复问题' });
  assert.deepEqual(parseCommand('清空'), { name: 'clear', args: '' });
  assert.deepEqual(parseCommand('模式 plan'), { name: 'mode', args: 'plan' });
  assert.deepEqual(parseCommand('模型 sonnet'), { name: 'model', args: 'sonnet' });
});

test('ask_user 卡构造限制 2-6 个选项', () => {
  assert.throws(() => buildAskUserCard({ task: task(), rid: 'r', question: 'x', options: ['A'] }), /2-6/);
  assert.doesNotThrow(() => buildAskUserCard({ task: task(), rid: 'r', question: 'x', options: ['A', 'B', 'C', 'D', 'E', 'F'] }));
});
