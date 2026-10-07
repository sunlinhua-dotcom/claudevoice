import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { ApprovalServer } from '../approval-server.mjs';
import { BridgeController } from '../index.mjs';
import { ClaudeRunner } from '../runner.mjs';
import { createMessageHandler, LruSet } from '../router.mjs';
import { SessionStore } from '../sessions.mjs';

const dir = await mkdtemp(join(tmpdir(), 'cc-readonly-task-e2e-'));
const token = randomBytes(24).toString('hex');
const logs = [];
const calls = { approvalCards: 0, completeCards: 0, failureCards: 0 };
let approval;

try {
  process.env.CC_SEND_FILES = '0';
  const store = await new SessionStore({ dir, workspaceRoot: '/path/to/workspace', globalLimit: 1 }).init();
  assert.equal(store.state.settings.inputMode, 'input');
  const cards = {
    createTaskCard: async () => 'task-card-e2e',
    updateTaskCard() {},
    replyText: async () => {},
    sendApproval: async () => { calls.approvalCards += 1; return `approval-e2e-${calls.approvalCards}`; },
    patchApproval: async () => {},
    sendAskUser: async () => 'ask-e2e',
    patchAskUser: async () => {},
    sendComplete: async () => { calls.completeCards += 1; return 'complete-e2e'; },
    sendFailure: async () => { calls.failureCards += 1; return 'failure-e2e'; },
    sendArtifacts: async () => [],
  };
  const log = {
    info: (...args) => logs.push(['info', ...args]),
    warn: (...args) => logs.push(['warn', ...args]),
    error: (...args) => logs.push(['error', ...args]),
  };
  approval = new ApprovalServer({ store, cards, token, port: 0, timeoutMs: 2500, askTimeoutMs: 2500, log });
  const address = await approval.start();
  const runner = new ClaudeRunner({ timeoutMs: 120_000, approvalPort: address.port, approvalToken: token });
  const controller = new BridgeController({ store, runner, cards, approval, log });
  controller.start();
  const handler = createMessageHandler({
    ownerId: 'ou_e2e', store, controller, cards, dedupe: new LruSet(10), log,
  });

  const sourceText = '任务 检查 pm2 状态。必须使用 Bash 工具且只执行 `pm2 list | cat`，不要使用其他工具，最后用一句简体中文报告。';
  await handler({
    sender: { sender_id: { open_id: 'ou_e2e' } },
    message: { message_id: 'om_readonly_task_e2e', message_type: 'text', content: JSON.stringify({ text: sourceText }), chat_type: 'p2p' },
  });
  const task = store.listTasks()[0];
  const started = Date.now();
  while (['queued', 'running', 'stopping'].includes(task.status)) {
    if (Date.now() - started > 125_000) throw new Error('真实只读任务等待超时');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }

  assert.equal(task.prompt.startsWith('检查 pm2 状态。'), true);
  assert.equal(task.status, 'done', task.error || task.stderrTail);
  assert.ok(task.toolHistory.some((item) => item.name === 'Bash' && item.summary.includes('pm2 list | cat')), 'stream-json 未捕获指定 Bash 工具调用');
  assert.equal(calls.approvalCards, 0, '纯只读 Bash 不应创建审批卡');
  assert.equal(calls.completeCards, 1, '应发送一张完成卡');
  assert.equal(calls.failureCards, 0);
  console.log(JSON.stringify({
    routeMode: store.state.settings.inputMode,
    taskNumber: task.number,
    taskStatus: task.status,
    sessionIdCaptured: Boolean(task.sessionId),
    streamJsonTools: task.toolHistory,
    approvalCards: calls.approvalCards,
    autoAllowLog: logs.find((entry) => String(entry[1] || '').startsWith('自动放行:只读'))?.[1] || 'Claude 内建只读规则未发起 PermissionRequest',
    completeCards: calls.completeCards,
    result: String(task.result || '').slice(0, 240),
  }, null, 2));
} finally {
  await approval?.close().catch(() => {});
  await rm(dir, { recursive: true, force: true });
}
