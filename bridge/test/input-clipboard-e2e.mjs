import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { copyTextToClipboard } from '../inject.mjs';
import { createMessageHandler, LruSet } from '../router.mjs';
import { SessionStore } from '../sessions.mjs';

function readClipboard() {
  return new Promise((resolve, reject) => {
    const child = spawn('pbpaste', [], { stdio: ['ignore', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve(Buffer.concat(stdout).toString('utf8'))
      : reject(new Error(`pbpaste 退出码 ${code}：${Buffer.concat(stderr).toString('utf8')}`)));
  });
}

const dir = await mkdtemp(join(tmpdir(), 'cc-input-e2e-state-'));
const workspaceRoot = await mkdtemp(join(tmpdir(), 'cc-input-e2e-workspace-'));
try {
  const store = await new SessionStore({ dir, workspaceRoot }).init();
  await store.setInputMode('input');
  const cards = { replyText: async () => {} };
  const controller = {
    handleAskText: async () => false,
    handleInput: async (text, { message, origin, postprocess }) => {
      const delivery = await store.createInputDelivery({ text, messageId: message.message_id, origin, postprocess });
      await copyTextToClipboard(text);
      await store.updateInputDelivery(delivery.id, {
        status: 'clipboard', relayReason: 'clipboard-e2e-no-relay', cardMessageId: 'input-card-e2e',
      });
      return delivery;
    },
    handleText: async () => assert.fail('input 模式不应创建 Claude 任务'),
    handleCommand: async () => assert.fail('普通文字不应进入命令'),
  };
  const handler = createMessageHandler({
    ownerId: 'ou_e2e', store, controller, cards, log: {}, dedupe: new LruSet(10),
  });
  const expected = `【cc-bridge input 模式 pbcopy 真测】${Date.now()}\n第二行; $(保持原样)`;
  await handler({
    sender: { sender_id: { open_id: 'ou_e2e' } },
    message: { message_id: 'om_input_clipboard_e2e', message_type: 'text', content: JSON.stringify({ text: expected }) },
  });
  const actual = await readClipboard();
  assert.equal(actual, expected);
  const delivery = Object.values(store.state.inputDeliveries)[0];
  assert.equal(delivery.status, 'clipboard');
  console.log(JSON.stringify({ expected, actual, equal: actual === expected, routeMode: store.state.settings.inputMode, deliveryStatus: delivery.status }, null, 2));
} finally {
  await rm(dir, { recursive: true, force: true });
  await rm(workspaceRoot, { recursive: true, force: true });
}
