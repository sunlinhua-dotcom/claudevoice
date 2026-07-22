import { readFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';

export function loadEnvFile(file, { override = false } = {}) {
  try {
    const text = readFileSync(file, 'utf8');
    for (const raw of text.split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(raw);
      if (!m || (!override && process.env[m[1]] !== undefined)) continue;
      let value = m[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      process.env[m[1]] = value;
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

export function clip(value, max = 240) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

export function safeJson(value, fallback = {}) {
  if (value && typeof value === 'object') return value;
  try { return JSON.parse(String(value || '')); } catch { return fallback; }
}

export function redact(value) {
  const text = String(value ?? '');
  if (!text) return '';
  if (text.length < 9) return '***';
  return `${text.slice(0, 4)}…${text.slice(-4)}`;
}

export function stableHash(value) {
  return createHash('sha256').update(String(value)).digest('hex');
}

export function id(prefix = '') {
  return `${prefix}${randomUUID()}`;
}

export function formatDuration(ms) {
  const sec = Math.max(0, Math.floor(ms / 1000));
  if (sec < 60) return `${sec} 秒`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return `${min} 分 ${rest} 秒`;
}

export function createLogger(scope = 'bridge') {
  const prefix = `[${scope}]`;
  return {
    info: (...args) => console.log(new Date().toISOString(), prefix, ...args),
    warn: (...args) => console.warn(new Date().toISOString(), prefix, ...args),
    error: (...args) => console.error(new Date().toISOString(), prefix, ...args),
  };
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
