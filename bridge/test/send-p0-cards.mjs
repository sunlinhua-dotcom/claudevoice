#!/usr/bin/env node
import * as lark from '@larksuiteoapi/node-sdk';
import { CardService } from '../cards.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(new URL('../.env', import.meta.url).pathname);
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const openId = process.env.LARK_OPEN_ID;
if (!appId || !appSecret || !openId) throw new Error('缺少飞书配置');
const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: { debug() {}, info() {}, warn() {}, error() {} } });
const cards = new CardService({ client, ownerId: openId });
const task = {
  id: 'p0-card-test', number: 999, project: 'claudevoice', status: 'running',
  prompt: '【测试】P0 事故修复后的主聊天流交互卡', triggerMessageId: '',
  createdAt: Date.now(), startedAt: Date.now(), pendingPrompts: [], toolHistory: [], eventCount: 0, round: 1,
};
const approvalMessageId = await cards.sendApproval(task, {
  rid: 'p0-display-test-approval', toolName: 'Write', input: { file_path: '/tmp/cc-bridge-card-test.txt', note: '【测试】无需操作' },
});
const askUserMessageId = await cards.sendAskUser(task, {
  rid: 'p0-display-test-ask', question: '【测试】新版 ask_user 选项卡：请选择 A 或 B（按钮仅作展示）', options: ['A（测试）', 'B（测试）'], allowCustom: true,
});
console.log(JSON.stringify({ approvalMessageId, askUserMessageId }));
