import * as lark from '@larksuiteoapi/node-sdk';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { buildCompleteCard, buildTaskCard, CardService } from '../cards.mjs';
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
const task = {
  id: 'lark-integration-test', number: 0, project: 'M3 联调测试 · claudevoice', status: 'queued', mode: 'default', model: '',
  createdAt: now, startedAt: 0, finishedAt: 0, pendingPrompts: [], eventCount: 0, currentTool: '', toolHistory: [],
  sessionId: 'integration-test', result: '', round: 0, costUsd: 0, claudeDurationMs: 0,
};

try {
  const taskMessageId = await cards.sendDirect(openId, buildTaskCard(task));
  task.status = 'running'; task.startedAt = now; task.currentTool = 'Read'; task.eventCount = 3;
  task.toolHistory = [
    { name: 'Read', summary: '{"file_path":"bridge/cards.mjs"}' },
    { name: 'Bash', summary: '{"command":"npm test"}' },
    { name: 'Write', summary: '{"file_path":"/tmp/m3-demo.txt"}' },
  ];
  const runningPatch = await client.im.message.patch({ path: { message_id: taskMessageId }, data: { content: JSON.stringify(buildTaskCard(task)) } });
  assert.ok(runningPatch?.code == null || runningPatch.code === 0, `running PATCH 失败 ${runningPatch?.code}: ${runningPatch?.msg}`);
  task.status = 'done'; task.finishedAt = Date.now(); task.result = 'M3 联调测试完成。任务卡已更新为绿色终态，并展示最近工具、成本与 Claude 耗时。';
  task.costUsd = 0.0123; task.claudeDurationMs = 4321; task.eventCount = 12;
  const donePatch = await client.im.message.patch({ path: { message_id: taskMessageId }, data: { content: JSON.stringify(buildTaskCard(task)) } });
  assert.ok(donePatch?.code == null || donePatch.code === 0, `done PATCH 失败 ${donePatch?.code}: ${donePatch?.msg}`);
  const completeMessageId = await cards.sendDirect(openId, buildCompleteCard(task));
  console.log(JSON.stringify({ taskMessageId, runningPatched: true, donePatched: true, completeMessageId }));
} catch (error) {
  const api = error?.response?.data || {};
  console.error(JSON.stringify({ error: error.message, code: api.code, msg: api.msg, logId: api?.error?.log_id }));
  process.exitCode = 1;
}
