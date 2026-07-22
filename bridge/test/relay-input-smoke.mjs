import assert from 'node:assert/strict';
import { join } from 'node:path';
import { RelayInjector } from '../inject.mjs';
import { loadEnvFile } from '../utils.mjs';

const dir = join(import.meta.dirname, '..');
loadEnvFile(join(dir, '.env'));
assert.ok(process.env.RELAY_URL, '缺少 RELAY_URL');
assert.ok(process.env.MAC_ID, '缺少 MAC_ID');

const injector = new RelayInjector({
  url: process.env.RELAY_URL,
  macId: process.env.MAC_ID,
  name: 'cc-bridge 注入链路真测',
  dir,
  log: { info: () => {}, warn: (...args) => console.error(...args) },
});
try {
  const text = `【cc-bridge inject_text 真测】${new Date().toISOString()}`;
  const result = await injector.injectText(text, { postprocess: false, waitMs: 12_000, ackMs: 12_000 });
  assert.equal(result?.ok, true, `注入失败：${result?.reason || 'unknown'}`);
  assert.equal(result?.unconfirmed, undefined, '只发出未收到 App ACK');
  console.log(JSON.stringify({ text, ack: result }, null, 2));
} finally {
  injector.close();
}
