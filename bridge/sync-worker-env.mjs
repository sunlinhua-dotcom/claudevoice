#!/usr/bin/env node
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const bridgeDir = dirname(fileURLToPath(import.meta.url));
const rootEnv = join(bridgeDir, '..', '.env');
const bridgeEnv = join(bridgeDir, '.env');

function valueOf(text, key) {
  const line = text.split(/\r?\n/).find((item) => item.startsWith(`${key}=`));
  return line ? line.slice(key.length + 1).trim() : '';
}

function setValue(text, key, value) {
  const line = `${key}=${value}`;
  const pattern = new RegExp(`^${key}=.*$`, 'm');
  if (pattern.test(text)) return text.replace(pattern, line);
  return `${text.trimEnd()}\n${line}\n`;
}

const [rootText, bridgeText] = await Promise.all([
  readFile(rootEnv, 'utf8'),
  readFile(bridgeEnv, 'utf8'),
]);
const secret = valueOf(rootText, 'HOOK_SECRET');
if (!secret) throw new Error('根目录 .env 缺少 HOOK_SECRET');

const next = setValue(bridgeText, 'HOOK_SECRET', secret);
const tmp = `${bridgeEnv}.${process.pid}.tmp`;
await writeFile(tmp, next, { mode: 0o600 });
await rename(tmp, bridgeEnv);
console.log('已同步 HOOK_SECRET 到 bridge/.env（值未输出）');
