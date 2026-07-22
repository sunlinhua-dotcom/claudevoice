import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApprovalCard, buildTaskCard, CardService, cleanSummary } from '../cards.mjs';
import { inspectClaudeEvent, ClaudeRunner } from '../runner.mjs';
import { SessionStore } from '../sessions.mjs';

test('Claude NDJSON 事件解析捕获 session/tool/result', () => {
  assert.equal(inspectClaudeEvent({ type: 'system', subtype: 'init', session_id: 's1' }).sessionId, 's1');
  const tool = inspectClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'pwd' } }] } });
  assert.match(tool.tool, /Bash/);
  const result = inspectClaudeEvent({ type: 'result', is_error: false, result: 'ok', session_id: 's1' });
  assert.equal(result.done, true);
  assert.equal(result.result, 'ok');
});

test('Claude result 事件提取 cost/duration，工具调用保留名称和参数摘要', () => {
  const tool = inspectClaudeEvent({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Write', input: { file_path: '/tmp/a.txt', content: 'hello' } }] } });
  assert.deepEqual(tool.toolCall, { name: 'Write', summary: '{"file_path":"/tmp/a.txt","content":"hello"}' });
  const result = inspectClaudeEvent({ type: 'result', result: '完成', total_cost_usd: 0.01234, duration_ms: 4321 });
  assert.equal(result.costUsd, 0.01234);
  assert.equal(result.claudeDurationMs, 4321);
});

test('runner 参数使用数组并按模式挂载审批 MCP', () => {
  const runner = new ClaudeRunner({ approvalToken: 'test', approvalPort: 18791 });
  const normal = runner.buildArgs({ prompt: 'hello; rm -rf /', taskId: 't1', mode: 'default' });
  assert.equal(normal[1], 'hello; rm -rf /');
  assert.ok(normal.includes('--permission-prompt-tool'));
  assert.ok(normal.includes('mcp__cc_bridge__permission_prompt'));
  assert.ok(normal.includes('mcp__cc_bridge__ask_user'));
  assert.match(normal[normal.indexOf('--append-system-prompt') + 1], /调用 ask_user 工具/);
  const yolo = runner.buildArgs({ prompt: 'hello', taskId: 't1', mode: 'yolo' });
  assert.equal(yolo.includes('--permission-prompt-tool'), false);
  assert.equal(yolo[yolo.indexOf('--permission-mode') + 1], 'bypassPermissions');
});

test('卡片动作使用 cc 命名空间且摘要清洗 markdown', () => {
  const task = { id: 't1', number: 1, project: 'demo', status: 'running', mode: 'default', model: '', createdAt: Date.now(), pendingPrompts: [], eventCount: 2 };
  const taskCard = buildTaskCard(task);
  assert.equal(taskCard.header.template, 'blue');
  const approval = buildApprovalCard({ task, rid: 'r1', toolName: 'Write', input: { file_path: '/tmp/a' } });
  const values = approval.body.elements
    .filter((element) => element.tag === 'button')
    .map((element) => element.behaviors[0].value);
  assert.ok(values.every((value) => value.ns === 'cc'));
  assert.equal(cleanSummary('**完成** `code`。'), '完成 。');
});

test('任务卡展示最近三条工具，完成终态显示成本和 Claude duration', () => {
  const task = {
    id: 't2', number: 2, project: 'demo', status: 'done', mode: 'default', model: '',
    createdAt: 1000, startedAt: 2000, finishedAt: 9000, pendingPrompts: [], eventCount: 12,
    toolHistory: [
      { name: 'Read', summary: '{"file_path":"a"}' },
      { name: 'Bash', summary: '{"command":"npm test"}' },
      { name: 'Write', summary: '{"file_path":"b"}' },
      { name: 'Edit', summary: '{"file_path":"c"}' },
    ],
    costUsd: 0.01234, claudeDurationMs: 4321,
  };
  const value = buildTaskCard(task, 9000);
  const markdown = value.body.elements.find((element) => element.tag === 'markdown').content;
  assert.equal(value.header.template, 'green');
  assert.doesNotMatch(markdown, /Read/);
  assert.match(markdown, /Bash[\s\S]*Write[\s\S]*Edit/);
  assert.match(markdown, /\$0\.0123/);
  assert.match(markdown, /Claude 耗时：.*4秒/);
});

test('完成摘要中文句子优先且在句子边界截断', () => {
  const summary = cleanSummary('English preface. 中文结论已经完成。第二句也已验证！ English tail.', 20);
  assert.match(summary, /^中文结论已经完成。/);
  assert.doesNotMatch(summary, /English preface/);
});

test('state.json 原子持久化并自动发现一层项目', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-bridge-store-'));
  const dir = join(root, 'bridge');
  const projectsRoot = join(root, 'projects');
  await mkdir(join(projectsRoot, 'Alpha'), { recursive: true });
  await mkdir(join(projectsRoot, '.cc-bridge'), { recursive: true });
  const store = await new SessionStore({ dir, workspaceRoot: projectsRoot }).init();
  assert.ok(store.resolveProject('alpha'));
  assert.equal(store.resolveProject('.cc-bridge'), null);
  await store.setMode('plan');
  const reload = await new SessionStore({ dir, workspaceRoot: projectsRoot }).init();
  assert.equal(reload.state.settings.mode, 'plan');
  await rm(root, { recursive: true, force: true });
});

test('任务卡 PATCH 至少节流 2.5 秒且相同内容不重复', async () => {
  let patches = 0;
  const client = { im: { message: { patch: async () => { patches += 1; return { code: 0 }; } } } };
  const service = new CardService({ client, throttleMs: 2500, log: {} });
  const task = { id: 't1', taskCardMessageId: 'm1', number: 1, project: 'demo', status: 'running', mode: 'default', model: '', createdAt: Date.now(), startedAt: Date.now(), pendingPrompts: [], eventCount: 0, currentTool: '', round: 1 };
  service.updates.set(task.id, { messageId: 'm1', lastSentAt: Date.now(), lastJson: JSON.stringify(buildTaskCard(task)), timer: null, pending: null });
  task.eventCount = 1;
  service.updateTaskCard(task);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(patches, 0);
  await new Promise((resolve) => setTimeout(resolve, 2500));
  assert.equal(patches, 1);
  service.updateTaskCard(task);
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(patches, 1);
});

test('产物回传按图片和文件分别上传，并在主聊天流直发', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cc-bridge-artifacts-'));
  const image = join(root, 'preview.png');
  const file = join(root, 'report.txt');
  await writeFile(image, Buffer.from('89504e470d0a1a0a', 'hex'));
  await writeFile(file, 'report');
  const creates = [];
  const client = { im: {
    image: { create: async ({ data }) => { assert.equal(data.image_type, 'message'); return { image_key: 'img-up' }; } },
    file: { create: async ({ data }) => { assert.equal(data.file_type, 'stream'); assert.equal(data.file_name, 'report.txt'); return { file_key: 'file-up' }; } },
    message: { create: async (value) => { creates.push(value); return { code: 0, data: { message_id: `m-${creates.length}` } }; } },
  } };
  const service = new CardService({ client, ownerId: 'owner-1', log: {} });
  const sent = await service.sendArtifacts({ triggerMessageId: 'trigger-1' }, [image, file]);
  assert.equal(sent.length, 2);
  assert.deepEqual(creates.map((item) => item.data.msg_type), ['image', 'file']);
  assert.ok(creates.every((item) => item.params.receive_id_type === 'open_id' && item.data.receive_id === 'owner-1'));
  assert.equal(JSON.parse(creates[0].data.content).image_key, 'img-up');
  assert.equal(JSON.parse(creates[1].data.content).file_key, 'file-up');
  await rm(root, { recursive: true, force: true });
});
