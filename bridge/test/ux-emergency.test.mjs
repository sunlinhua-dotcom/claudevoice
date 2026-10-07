import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { ApprovalServer } from '../approval-server.mjs';
import { BridgeController } from '../index.mjs';
import { createMessageHandler, LruSet } from '../router.mjs';

const OWNER = 'ou_owner';

function task(number = 1) {
  return {
    id: `task-${number}`, number, project: 'claudevoice', prompt: `任务 ${number}`,
    status: 'running', waitingFor: '', pendingPrompts: [], createdAt: Date.now(),
  };
}

function storeFor(tasks = [task()]) {
  const values = new Map(tasks.map((value) => [value.id, value]));
  return {
    state: { settings: { inputMode: 'input' }, currentProject: 'claudevoice' },
    projects: { claudevoice: { path: '/path/to/claudevoice' } },
    getTask: (id) => values.get(id) || null,
    findTaskByMessage: () => null,
    mapMessage() {}, save: async () => {},
    beginTaskWait: async (id, kind) => { const value = values.get(id); if (value) value.waitingFor = kind; },
    endTaskWait: async (id, kind) => { const value = values.get(id); if (value?.waitingFor === kind) value.waitingFor = ''; return value; },
  };
}

function cardsHarness() {
  const calls = { approvals: [], asks: [], patches: [], askPatches: [], replies: [] };
  return {
    calls,
    cards: {
      sendApproval: async (_task, request) => { calls.approvals.push(request); return `approval-card-${calls.approvals.length}`; },
      patchApproval: async (...args) => calls.patches.push(args),
      sendAskUser: async (_task, request) => { calls.asks.push(request); return `ask-card-${calls.asks.length}`; },
      patchAskUser: async (...args) => calls.askPatches.push(args),
      updateTaskCard() {},
      replyText: async (id, text) => calls.replies.push({ id, text }),
    },
  };
}

function message(text, id = `m-${Math.random()}`) {
  return {
    sender: { sender_id: { open_id: OWNER } },
    message: { message_id: id, message_type: 'text', content: JSON.stringify({ text }), chat_type: 'p2p' },
  };
}

async function postPermission(port, taskId, toolName, input) {
  const response = await fetch(`http://127.0.0.1:${port}/permission`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer token' },
    body: JSON.stringify({ taskId, toolName, input }),
  });
  return response.json();
}

async function waitFor(check, timeoutMs = 250) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) throw new Error('waitFor timeout');
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

test('默认自动放行无害工具与纯只读 Bash 管道，不创建审批卡', async (t) => {
  const value = task();
  const store = storeFor([value]);
  const { cards, calls } = cardsHarness();
  const logs = [];
  const server = new ApprovalServer({ store, cards, token: 'token', port: 0, timeoutMs: 12, log: { info: (...args) => logs.push(args) } });
  const address = await server.start();
  t.after(() => server.close());
  for (const toolName of ['Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'TodoWrite', 'NotebookRead', 'Task', 'Agent']) {
    const result = await postPermission(address.port, value.id, toolName, { path: '/tmp/x' });
    assert.equal(result.behavior, 'allow', `${toolName} 应自动放行`);
  }
  for (const command of ['pm2 list | cat', 'ls -la | head -3']) {
    const result = await postPermission(address.port, value.id, 'Bash', { command });
    assert.equal(result.behavior, 'allow', `${command} 应自动放行`);
  }
  assert.equal(calls.approvals.length, 0);
  assert.ok(logs.some(([message]) => String(message).startsWith('自动放行:只读')));
  await server.close();
});

test('危险否决优先且未知 pm2 子命令弹卡，绕过样例全部不自动放行', async (t) => {
  const value = task();
  const store = storeFor([value]);
  const { cards, calls } = cardsHarness();
  const server = new ApprovalServer({ store, cards, token: 'token', port: 0, timeoutMs: 500, log: {} });
  const address = await server.start();
  t.after(() => server.close());
  const commands = [
    'ls; rm -rf /tmp/x', 'cat a > b', 'grep x $(rm y)', 'pm2 delete',
    'sudo ls', 'mkfs /dev/disk9', 'dd if=/dev/zero of=/tmp/x', 'cat a >> b', 'ls | tee out',
    'mv a b', 'cp -f a b', 'chmod 777 a', 'chown root a', 'kill 123', 'pkill node',
    'launchctl unload x', 'npm install x', 'pip install x', 'curl -X POST https://example.com',
    'curl -X PUT https://example.com', 'curl -X DELETE https://example.com', 'git push', 'git reset --hard',
    'echo `whoami`', 'ls | sh',
  ];
  for (const command of commands) {
    const response = postPermission(address.port, value.id, 'Bash', { command });
    await waitFor(() => server.pending.size === 1);
    const rid = server.pending.keys().next().value;
    await server.resolve(rid, 'deny');
    assert.equal((await response).behavior, 'deny');
  }
  value.alwaysAllow = true;
  const alwaysResponse = postPermission(address.port, value.id, 'Bash', { command: 'ls | sh' });
  await waitFor(() => server.pending.size === 1);
  await server.resolve(server.pending.keys().next().value, 'deny');
  assert.equal((await alwaysResponse).behavior, 'deny');
  assert.equal(calls.approvals.length, commands.length + 1);
  await server.close();
});

test('CC_AUTO_ALLOW_READONLY=0 等价配置会让只读调用继续弹卡', async (t) => {
  const value = task();
  const store = storeFor([value]);
  const { cards, calls } = cardsHarness();
  const server = new ApprovalServer({ store, cards, token: 'token', port: 0, timeoutMs: 500, autoAllowReadonly: false, log: {} });
  const address = await server.start();
  t.after(() => server.close());
  const response = postPermission(address.port, value.id, 'Bash', { command: 'pm2 list | cat' });
  await waitFor(() => server.pending.size === 1);
  await server.resolve(server.pending.keys().next().value, 'deny');
  assert.equal((await response).behavior, 'deny');
  assert.equal(calls.approvals.length, 1);
  await server.close();
});

test('readonly-allow.json 可用完整正则扩展工具与 Bash，只在显式命中时放行', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-readonly-policy-'));
  const configPath = join(dir, 'readonly-allow.json');
  await writeFile(configPath, `${JSON.stringify({ tools: ['CustomRead'], bashPatterns: ['^uptime$'] })}\n`);
  const value = task();
  const store = storeFor([value]);
  const { cards, calls } = cardsHarness();
  const server = new ApprovalServer({ store, cards, token: 'token', port: 0, timeoutMs: 20, readonlyConfigPath: configPath, log: {} });
  const address = await server.start();
  t.after(() => server.close());
  assert.equal((await postPermission(address.port, value.id, 'CustomRead', {})).behavior, 'allow');
  assert.equal((await postPermission(address.port, value.id, 'Bash', { command: 'uptime' })).behavior, 'allow');
  assert.equal(calls.approvals.length, 0);
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

function textRouteHarness(server, store, cards) {
  const calls = { inputs: [], tasks: [] };
  const controller = new BridgeController({ store, runner: {}, cards, approval: server, log: {} });
  controller.handleInput = async (text) => calls.inputs.push(text);
  controller.handleText = async (text) => calls.tasks.push(text);
  const handler = createMessageHandler({ ownerId: OWNER, store, controller, cards, dedupe: new LruSet(30), log: {} });
  return { calls, handler };
}

test('pending 审批时文字“允许/拒绝”点击最新卡片等效动作，且不进入任务或注入', async (t) => {
  for (const [text, expected] of [[' 允许 ', 'allow'], ['拒绝', 'deny']]) {
    const value = task();
    const store = storeFor([value]);
    const { cards, calls: cardCalls } = cardsHarness();
    const server = new ApprovalServer({ store, cards, token: 'token', timeoutMs: 500, log: {} });
    t.after(() => server.close());
    const pendingResult = server.request({ task: value, toolName: 'Write', input: { file_path: '/tmp/x' } });
    await waitFor(() => server.pending.size === 1);
    const { calls, handler } = textRouteHarness(server, store, cards);
    await handler(message(text, `approval-${expected}`));
    if (server.pending.size) await server.resolve(server.pending.keys().next().value, 'deny');
    assert.equal((await pendingResult).behavior, expected);
    assert.deepEqual(calls, { inputs: [], tasks: [] });
    assert.match(cardCalls.replies.at(-1)?.text || '', expected === 'allow' ? /已允许/ : /已拒绝/);
    await server.close();
  }
});

test('无 pending 时“允许”按 input 模式正常进入剪贴板输入路由', async (t) => {
  const store = storeFor();
  const { cards } = cardsHarness();
  const server = new ApprovalServer({ store, cards, token: 'token', log: {} });
  t.after(() => server.close());
  const { calls, handler } = textRouteHarness(server, store, cards);
  await handler(message('允许', 'no-pending-allow'));
  assert.deepEqual(calls.inputs, ['允许']);
  assert.deepEqual(calls.tasks, []);
  await server.close();
});

test('多个 pending 只处理最新审批；未命中或超过 8 字符的文字不被审批层吞掉', async (t) => {
  const first = task(1);
  const latest = task(2);
  const store = storeFor([first, latest]);
  const { cards } = cardsHarness();
  const server = new ApprovalServer({ store, cards, token: 'token', timeoutMs: 500, log: {} });
  t.after(() => server.close());
  const firstResult = server.request({ task: first, toolName: 'Write', input: { file_path: '/tmp/first' } });
  const latestResult = server.request({ task: latest, toolName: 'Write', input: { file_path: '/tmp/latest' } });
  await waitFor(() => server.pending.size === 2);
  const { calls, handler } = textRouteHarness(server, store, cards);
  await handler(message('我只是补充一个说明', 'approval-long-text'));
  assert.deepEqual(calls.inputs, ['我只是补充一个说明']);
  assert.equal(server.pending.size, 2);
  await handler(message('允许', 'approval-latest-allow'));
  assert.equal((await latestResult).behavior, 'allow');
  assert.equal(server.pending.size, 1);
  await server.resolve(server.pending.keys().next().value, 'deny');
  assert.equal((await firstResult).behavior, 'deny');
  assert.deepEqual(calls.tasks, []);
  await server.close();
});

test('ask_user pending 支持序号、选项文本和 allow_custom，均不进入普通路由', async (t) => {
  for (const [text, expected] of [['2', 'B'], ['A', 'A'], ['我选折中方案', '我选折中方案']]) {
    const value = task();
    const store = storeFor([value]);
    const { cards, calls: cardCalls } = cardsHarness();
    const server = new ApprovalServer({ store, cards, token: 'token', askTimeoutMs: 500, log: {} });
    t.after(() => server.close());
    const pendingResult = server.requestAsk({ task: value, question: '选 A 还是 B？', options: ['A', 'B'], allowCustom: true });
    await waitFor(() => server.pendingAsk.size === 1);
    const { calls, handler } = textRouteHarness(server, store, cards);
    await handler(message(text, `ask-${text}`));
    if (server.pendingAsk.size) await server.resolveAsk(server.pendingAsk.keys().next().value, { answer: 'cleanup' });
    assert.equal((await pendingResult).answer, expected);
    assert.deepEqual(calls, { inputs: [], tasks: [] });
    assert.match(cardCalls.replies.at(-1)?.text || '', /已记录|已选择/);
    await server.close();
  }
});
