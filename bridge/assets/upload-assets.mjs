#!/usr/bin/env node
import * as lark from '@larksuiteoapi/node-sdk';
import { createReadStream } from 'node:fs';
import { readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEnvFile } from '../utils.mjs';
import { buildUploadPlan } from './asset-cache.mjs';

const dir = import.meta.dirname;
loadEnvFile(join(dir, '..', '.env'));
const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID;
const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET;
if (!appId || !appSecret) throw new Error('缺少飞书应用配置');

const kinds = ['running', 'permission', 'failed', 'queued', 'voice', 'help', 'done'];
const files = Object.fromEntries(kinds.map((kind) => [kind, join(dir, 'banners', `${kind}.png`)]));
const cacheFile = join(dir, 'img-keys.json');
let cache = { version: 1, images: {} };
try { cache = JSON.parse(await readFile(cacheFile, 'utf8')); } catch {}
cache.images ||= {};

const plan = await buildUploadPlan({ files, cache });
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };
const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: silentLogger });
for (const item of plan) {
  const response = await client.im.image.create({
    data: { image_type: 'message', image: createReadStream(item.file) },
  });
  if (response?.code != null && response.code !== 0) throw new Error(`${item.kind} 上传失败 ${response.code}: ${response.msg}`);
  const imageKey = response?.image_key || response?.data?.image_key;
  if (!imageKey) throw new Error(`${item.kind} 上传未返回 image_key`);
  cache.images[item.kind] = {
    file: `banners/${item.kind}.png`, sha256: item.sha256, image_key: imageKey,
  };
  console.log(`${item.kind}: uploaded`);
}
cache.version = 1;
cache.updatedAt = new Date().toISOString();
const temp = `${cacheFile}.${process.pid}.tmp`;
await writeFile(temp, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
await rename(temp, cacheFile);
console.log(`完成：上传 ${plan.length} 张，缓存 ${Object.keys(cache.images).length} 张`);
