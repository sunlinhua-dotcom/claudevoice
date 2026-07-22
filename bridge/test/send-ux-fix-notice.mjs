import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { buildNoticeCard, CardService } from '../cards.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(join(import.meta.dirname, '..', '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const ownerId = process.env.LARK_OPEN_ID;
assert.ok(appId && appSecret && ownerId, '缺少飞书应用或 BRIGHT 配置');

const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: silentLogger });
const cards = new CardService({ client, ownerId });
const card = buildNoticeCard({
  kind: 'help',
  title: '🔔 系统通知 · Remote Voice 体验修复',
  markdown: [
    '默认已改回输入模式：现在说话或发文字会直接进入电脑。',
    '只读操作不再弹审批；危险或无法确认的操作仍会请求授权。',
    '审批卡支持直接回复“允许”或“拒绝”；决策问题也可回复选项或序号。',
    '',
    '需要给 Claude 下任务时，请发 `任务 xxx`，或用 `/task` 切换任务模式。',
    '',
    '_系统通知_',
  ].join('\n\n'),
});
const messageId = await cards.sendDirect(ownerId, card);
assert.ok(messageId, '飞书未返回 message_id');
console.log(JSON.stringify({ messageId, sent: true, type: 'system-notice' }));
