import * as lark from '@larksuiteoapi/node-sdk';
import { join } from 'node:path';
import { CardService } from '../cards.mjs';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(join(import.meta.dirname, '..', '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const ownerId = process.env.LARK_OPEN_ID;
if (!appId || !appSecret || !ownerId) throw new Error('缺少飞书配置');

const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error });
const cards = new CardService({ client, ownerId, log: console });
const messageId = await cards.sendAttachmentReceipt({
  id: `attachment-card-test-${Date.now()}`,
  status: 'clipboard', clipboardVerified: true, clipboardInfo: '«class furl», 1',
  project: 'claudevoice · 测试',
  attachments: [{ name: '新版附件回执卡（测试）.pdf', size: 2048, mime: 'application/pdf' }],
});
console.log(`message_id=${messageId}`);
