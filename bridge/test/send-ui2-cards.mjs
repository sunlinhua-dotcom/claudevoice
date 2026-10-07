import * as lark from '@larksuiteoapi/node-sdk';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  buildApprovalCard, buildCompleteCard, buildFailureCard, buildNoticeCard, buildTaskCard, CardService,
} from '../cards.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(join(import.meta.dirname, '..', '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const openId = process.env.LARK_OPEN_ID;
assert.ok(appId && appSecret && openId, '缺少飞书配置');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: silentLogger });
const cards = new CardService({ client });
const now = Date.now();
const base = {
  id: 'ui2-smoke', number: 20, project: 'UI 2.0 测试', mode: 'default', model: '',
  createdAt: now - 8000, startedAt: now - 6000, finishedAt: 0, pendingPrompts: [], eventCount: 9,
  currentTool: 'Read', toolHistory: [
    { name: 'Read', summary: '{"file_path":"bridge/cards.mjs"}' },
    { name: 'Bash', summary: '{"command":"npm test"}' },
  ],
  sessionId: 'ui2-test-session', result: 'UI 2.0 测试完成。新版卡片 banner 与内容区均已展示。',
  error: 'UI 2.0 测试失败态，仅用于视觉联调。', stderrTail: 'visual smoke only', round: 1,
  costUsd: 0.0123, claudeDurationMs: 4321,
};

const cardsByKind = {
  queued: buildTaskCard({ ...base, status: 'queued', startedAt: 0 }),
  running: buildTaskCard({ ...base, status: 'running' }),
  permission: buildApprovalCard({ task: { ...base, status: 'running' }, rid: 'ui2-test', toolName: 'Write', input: { file_path: '/tmp/ui2-test.txt' } }),
  voice: buildNoticeCard({ kind: 'voice', title: '🎤 UI 2.0 测试 · 语音识别', markdown: '识别：请检查新版语音确认卡。' }),
  help: buildNoticeCard({ kind: 'help', title: '🧭 UI 2.0 测试 · 指挥台帮助', markdown: '**项目与任务**\n/projects · /use · /status\n\n**会话与设置**\n/sessions · /resume · /mode' }),
  done: buildCompleteCard({ ...base, status: 'done', finishedAt: now }),
  failed: buildFailureCard({ ...base, status: 'failed', finishedAt: now }),
};

const messageIds = {};
for (const [kind, value] of Object.entries(cardsByKind)) {
  messageIds[kind] = await cards.sendDirect(openId, value);
}
console.log(JSON.stringify(messageIds));
