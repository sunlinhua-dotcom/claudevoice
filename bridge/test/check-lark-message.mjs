import * as lark from '@larksuiteoapi/node-sdk';
import { join } from 'node:path';
import { loadEnvFile } from '../utils.mjs';

loadEnvFile(join(import.meta.dirname, '..', '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
const messageId = process.argv[2];
if (!appId || !appSecret || !messageId) throw new Error('用法：node test/check-lark-message.mjs <message_id>');

const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, loggerLevel: lark.LoggerLevel.error });
const response = await client.im.message.get({ path: { message_id: messageId } });
if (response?.code != null && response.code !== 0) throw new Error(`消息读取失败 ${response.code}: ${response.msg}`);
const item = response?.data?.items?.[0] || {};
console.log(JSON.stringify({
  message_id: item.message_id || messageId,
  msg_type: item.msg_type || '',
  root_id: item.root_id || '',
  parent_id: item.parent_id || '',
  thread_id: item.thread_id || '',
  main_flow: !item.root_id && !item.parent_id && !item.thread_id,
}));
