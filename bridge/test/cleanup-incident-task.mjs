#!/usr/bin/env node
import * as lark from '@larksuiteoapi/node-sdk';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { buildTaskCard } from '../cards.mjs';
import { loadEnvFile } from '../utils.mjs';

const INCIDENT_ID = 'task_7a1ac0d9-64b8-42ab-803f-bc169aa0aff2';
const stateFile = new URL('../state.json', import.meta.url);
loadEnvFile(new URL('../.env', import.meta.url).pathname);
const state = JSON.parse(await readFile(stateFile, 'utf8'));
const task = state.tasks?.[INCIDENT_ID];
if (!task) throw new Error(`未找到事故任务 ${INCIDENT_ID}`);
const before = {
  status: task.status, finishedAt: task.finishedAt, error: task.error,
  currentTool: task.currentTool, taskCardMessageId: task.taskCardMessageId,
};
Object.assign(task, {
  status: 'failed',
  error: '图片审批链路缺陷已修复，请重发',
  alwaysAllow: false,
  currentTool: '', waitingFor: '', waitingStartedAt: 0,
  finishedAt: Date.now(), updatedAt: Date.now(), pendingPrompts: [],
});
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error('缺少飞书配置');
const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: { debug() {}, info() {}, warn() {}, error() {} } });
const response = await client.im.message.patch({
  path: { message_id: task.taskCardMessageId },
  data: { content: JSON.stringify(buildTaskCard(task)) },
});
if (response?.code != null && response.code !== 0) throw new Error(`任务卡 PATCH 失败 ${response.code}: ${response.msg}`);
const temporary = new URL(`../state.json.${process.pid}.tmp`, import.meta.url);
await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
await rename(temporary, stateFile);
console.log(JSON.stringify({
  taskId: INCIDENT_ID,
  patchMessageId: task.taskCardMessageId,
  before,
  after: { status: task.status, finishedAt: task.finishedAt, error: task.error, currentTool: task.currentTool },
}, null, 2));
