import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import { unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { ApprovalServer } from '../approval-server.mjs';
import { ClaudeRunner } from '../runner.mjs';

const token = randomBytes(32).toString('hex');
const task = { id: 'approval-smoke', number: 0, project: 'claudevoice', triggerMessageId: 'mock', alwaysAllow: false };
const store = {
  getTask: (id) => id === task.id ? task : null,
  updateTask: async (_id, patch) => Object.assign(task, patch),
  mapMessage: () => {},
  save: async () => {},
};
let nextAction = 'approve';
let approvalCount = 0;
let server;
const cards = {
  sendApproval: async (_task, request) => {
    approvalCount += 1;
    const action = nextAction;
    setImmediate(() => server.resolve(request.rid, action));
    return `mock-card-${approvalCount}`;
  },
};
server = new ApprovalServer({ store, cards, port: 0, token, timeoutMs: 5000, log: console });
const address = await server.start();
const port = address.port;

function startMcp() {
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', 'approve-mcp.mjs')], {
    env: { ...process.env, CC_APPROVAL_PORT: String(port), CC_APPROVAL_TOKEN: token, CC_BRIDGE_TASK_ID: task.id },
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const waits = new Map();
  createInterface({ input: child.stdout, crlfDelay: Infinity }).on('line', (line) => {
    const message = JSON.parse(line);
    const waiter = waits.get(message.id);
    if (waiter) { waits.delete(message.id); waiter.resolve(message); }
  });
  return {
    call: (message) => new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waits.delete(message.id); reject(new Error(`MCP 响应超时 id=${message.id}`)); }, 7000);
      waits.set(message.id, { resolve: (value) => { clearTimeout(timer); resolve(value); } });
      child.stdin.write(`${JSON.stringify(message)}\n`);
    }),
    close: () => child.kill('SIGTERM'),
  };
}

const mcp = startMcp();
const init = await mcp.call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } } });
assert.equal(init.result.serverInfo.name, 'cc-bridge-approval');

nextAction = 'approve';
const allow = await mcp.call({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'permission_prompt', arguments: { tool_name: 'Write', input: { file_path: '/tmp/allow' } } } });
const allowDecision = JSON.parse(allow.result.content[0].text);
assert.deepEqual(allowDecision, { behavior: 'allow', updatedInput: { file_path: '/tmp/allow' } });
console.log('[approval-smoke] MCP allow PASS');

nextAction = 'deny';
const deny = await mcp.call({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'permission_prompt', arguments: { tool_name: 'Write', input: { file_path: '/tmp/deny' } } } });
const denyDecision = JSON.parse(deny.result.content[0].text);
assert.equal(denyDecision.behavior, 'deny');
console.log('[approval-smoke] MCP deny PASS');
mcp.close();

// 真 Claude 审批链路：要求模型实际请求写文件，分别自动模拟飞书按钮允许/拒绝。
const cwd = '/path/to/claudevoice';
const allowFile = join(cwd, '.cc-bridge-approval-allow.tmp');
const denyFile = join(cwd, '.cc-bridge-approval-deny.tmp');
await unlink(allowFile).catch(() => {});
await unlink(denyFile).catch(() => {});
const runner = new ClaudeRunner({ timeoutMs: 5 * 60_000, approvalPort: port, approvalToken: token });

try {
nextAction = 'approve';
const beforeAllow = approvalCount;
const allowRun = runner.run({ taskId: task.id, cwd, mode: 'default', prompt: `必须使用 Write 工具创建 ${allowFile}，内容只能是 approved，然后报告完成。` });
const allowResult = await allowRun.promise;
console.log('[approval-smoke] claude allow=', JSON.stringify({ ok: allowResult.ok, sessionId: allowResult.sessionId, approvals: approvalCount - beforeAllow, error: allowResult.error?.slice(0, 180) }));
assert.equal(allowResult.ok, true, allowResult.error);
assert.ok(approvalCount > beforeAllow, 'Claude 写文件未触发 permission-prompt-tool');
assert.equal(existsSync(allowFile), true, '允许后文件未创建');
await unlink(allowFile).catch(() => {});

task.alwaysAllow = false;
nextAction = 'deny';
const beforeDeny = approvalCount;
const denyRun = runner.run({ taskId: task.id, cwd, mode: 'default', prompt: `必须使用 Write 工具创建 ${denyFile}，内容只能是 denied；如果权限被拒绝就立即停止，不要换别的方法。` });
const denyResult = await denyRun.promise;
console.log('[approval-smoke] claude deny=', JSON.stringify({ ok: denyResult.ok, sessionId: denyResult.sessionId, approvals: approvalCount - beforeDeny, fileExists: existsSync(denyFile), error: denyResult.error?.slice(0, 180) }));
assert.ok(approvalCount > beforeDeny, '拒绝分支未触发 permission-prompt-tool');
assert.equal(existsSync(denyFile), false, '拒绝后文件仍被创建');
console.log('[approval-smoke] PASS allow/deny');
} finally {
  await unlink(allowFile).catch(() => {});
  await unlink(denyFile).catch(() => {});
  await server.close();
}
