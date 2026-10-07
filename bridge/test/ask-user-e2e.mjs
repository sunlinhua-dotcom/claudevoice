#!/usr/bin/env node
import { ApprovalServer } from '../approval-server.mjs';
import { ClaudeRunner } from '../runner.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(new URL('../.env', import.meta.url).pathname);
process.env.CC_ASK_TIMEOUT_MS = process.env.CC_ASK_TIMEOUT_MS || '5000';

const task = {
  id: 'ask-user-e2e', number: 999, project: 'claudevoice',
  prompt: '【测试】调用 ask_user 询问 A/B', status: 'running',
  createdAt: Date.now(), startedAt: Date.now(), waitingFor: '', waitingStartedAt: 0, waitAccumulatedMs: 0,
};
let running;
let approval;
let askCardMessageId = '';
let patchedAnswer = '';
const store = {
  projects: { claudevoice: { path: new URL('../..', import.meta.url).pathname.replace(/\/$/, '') } },
  getTask: () => task,
  mapMessage() {}, save: async () => {}, updateTask: async (_id, patch) => Object.assign(task, patch),
  beginTaskWait: async (_id, kind) => {
    task.waitingFor = kind; task.waitingStartedAt = Date.now(); running?.pauseTimeout(kind); return task;
  },
  endTaskWait: async (_id, kind) => {
    task.waitingFor = ''; task.waitingStartedAt = 0; running?.resumeTimeout(kind); return task;
  },
};
const cards = {
  updateTaskCard() {},
  sendAskUser: async (_task, request) => {
    askCardMessageId = `local-ask-${request.rid}`;
    setTimeout(() => approval.resolveAsk(request.rid, { index: 1 }), 50);
    return askCardMessageId;
  },
  patchAskUser: async (_messageId, value) => { patchedAnswer = value.answer; },
};

approval = new ApprovalServer({ store, cards, port: 0, token: 'ask-user-e2e-token', askTimeoutMs: 5000, log: console });
const address = await approval.start();
const runner = new ClaudeRunner({
  timeoutMs: 120_000,
  approvalPort: address.port,
  approvalToken: 'ask-user-e2e-token',
});
const stream = [];
running = runner.run({
  taskId: task.id,
  cwd: store.projects.claudevoice.path,
  prompt: '必须调用 ask_user 工具问我“选 A 还是 B”，选项严格是 A 和 B；收到答案后只回复：你选择了<答案>。',
  onEvent: (event) => {
    if (event.toolCall) stream.push({ type: 'tool_use', name: event.toolCall.name, summary: event.toolCall.summary });
    if (event.done) stream.push({ type: 'result', result: event.result });
  },
});
const result = await running.promise;
await approval.close();
const evidence = {
  ok: result.ok,
  askCardMessageId,
  selected: patchedAnswer,
  stream,
  result: result.result,
  error: result.error,
};
console.log(JSON.stringify(evidence, null, 2));
const usedAsk = stream.some((item) => item.type === 'tool_use' && item.name.includes('ask_user'));
if (!result.ok || !usedAsk || patchedAnswer !== 'B' || !/B/.test(result.result || '')) process.exitCode = 1;
