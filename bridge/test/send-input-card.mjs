import assert from 'node:assert/strict';
import { join } from 'node:path';
import * as lark from '@larksuiteoapi/node-sdk';
import { CardService } from '../cards.mjs';
import { loadEnvFile } from '../utils.mjs';

const dir = join(import.meta.dirname, '..');
loadEnvFile(join(dir, '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const ownerId = process.env.LARK_OPEN_ID;
assert.ok(appId && appSecret && ownerId, '缺少飞书应用或 BRIGHT 配置');

const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error });
const cards = new CardService({ client, ownerId });
const delivery = {
  id: `inject_card_test_${Date.now()}`,
  text: '【测试】cc-bridge RemoteVoice 核心回执卡：按钮仅用于本轮回归展示，自动化将另行模拟四类回调。',
  status: 'clipboard',
  relayMode: 'clipboard',
  relayReason: '测试卡：未对当前前台窗口执行自动注入',
};
const messageId = await cards.sendInputReceipt(delivery, 'task');
assert.ok(messageId, '飞书未返回 message_id');
console.log(JSON.stringify({ messageId, test: true, actions: ['paste', 'enter', 'claude', 'mode'] }, null, 2));
