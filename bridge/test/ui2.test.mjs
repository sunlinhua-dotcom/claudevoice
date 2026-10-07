import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildUploadPlan } from '../assets/asset-cache.mjs';
import { BridgeEventClient, buildBridgeEvent } from '../worker-events.mjs';
import { BridgeController } from '../index.mjs';
import { ApprovalServer } from '../approval-server.mjs';
import {
  buildApprovalCard, buildCompleteCard, buildFailureCard, buildNoticeCard, buildTaskCard,
} from '../cards.mjs';
import { deliveryPlan, normalizeBridgePayload } from '../../cloudflare/src/event-utils.mjs';

const KEYS = {
  running: 'img-running', permission: 'img-permission', failed: 'img-failed',
  queued: 'img-queued', voice: 'img-voice', help: 'img-help', done: 'img-done',
};

function task(status = 'running') {
  return {
    id: 't-ui', number: 20, project: 'UI 2.0 测试', status, mode: 'default', model: '',
    createdAt: 1000, startedAt: 2000, finishedAt: status === 'done' ? 4000 : 0,
    pendingPrompts: [], eventCount: 2, toolHistory: [], result: '已完成。', error: '失败。',
  };
}

test('banner 映射覆盖任务终态、审批、语音和帮助，缺 key 时无图降级', () => {
  assert.equal(buildTaskCard(task('running'), 3000, KEYS).body.elements[0].img_key, 'img-running');
  assert.equal(buildTaskCard(task('queued'), 3000, KEYS).body.elements[0].img_key, 'img-queued');
  assert.equal(buildTaskCard(task('done'), 4000, KEYS).body.elements[0].img_key, 'img-done');
  assert.equal(buildTaskCard(task('failed'), 4000, KEYS).body.elements[0].img_key, 'img-failed');
  assert.equal(buildApprovalCard({ task: task(), rid: 'r', toolName: 'Write', input: {} }, KEYS).body.elements[0].img_key, 'img-permission');
  assert.equal(buildCompleteCard(task('done'), KEYS).body.elements[0].img_key, 'img-done');
  assert.equal(buildFailureCard(task('failed'), KEYS).body.elements[0].img_key, 'img-failed');
  assert.equal(buildNoticeCard({ kind: 'voice', title: '语音识别', markdown: '识别内容' }, KEYS).body.elements[0].img_key, 'img-voice');
  assert.equal(buildNoticeCard({ kind: 'help', title: '指挥台帮助', markdown: '帮助' }, KEYS).body.elements[0].img_key, 'img-help');
  assert.equal(buildTaskCard(task('running'), 3000, {}).body.elements[0].tag, 'markdown');
});

test('上传计划以 sha256 + image_key 命中缓存，文件变化才重传', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'cc-ui2-cache-'));
  const file = join(dir, 'running.png');
  await writeFile(file, 'first');
  const first = await buildUploadPlan({ files: { running: file }, cache: {} });
  assert.equal(first.length, 1);
  const cache = { images: { running: { sha256: first[0].sha256, image_key: 'img-cached' } } };
  assert.deepEqual(await buildUploadPlan({ files: { running: file }, cache }), []);
  await writeFile(file, 'changed');
  assert.equal((await buildUploadPlan({ files: { running: file }, cache })).length, 1);
  await rm(dir, { recursive: true, force: true });
});

test('bridge 生命周期 kind 映射带 source/noLark，POST 失败静默', async () => {
  const base = task('running');
  assert.equal(buildBridgeEvent('start', base).kind, 'notification');
  assert.equal(buildBridgeEvent('permission', base).kind, 'permission');
  assert.equal(buildBridgeEvent('done', base).kind, 'done');
  const failed = buildBridgeEvent('failed', base);
  assert.equal(failed.kind, 'failed');
  assert.equal(failed.source, 'bridge');
  assert.equal(failed.noLark, true);
  assert.equal(failed.noNotify, true);

  const calls = [];
  const client = new BridgeEventClient({ url: 'https://worker.example/hook', secret: 'test-secret', fetchImpl: async (...args) => { calls.push(args); return { ok: true }; } });
  assert.equal(await client.emit('done', base), true);
  assert.equal(calls[0][0], 'https://worker.example/hook');
  assert.equal(calls[0][1].headers['x-cv-secret'], 'test-secret');
  assert.equal(JSON.parse(calls[0][1].body).noLark, true);
  const broken = new BridgeEventClient({ url: 'https://worker.example/hook', secret: 'x', fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(await broken.emit('failed', base), false);
});

test('Worker 保留 bridge failed 事件但 bridge 生命周期不再外送任何通知渠道', () => {
  const event = normalizeBridgePayload({
    source: 'bridge', noLark: true, noNotify: true, project: 'claudevoice', kind: 'failed',
    title: '任务失败', detail: '测试失败', ts: 123,
  });
  assert.equal(event.kind, 'failed');
  assert.equal(event.source, 'bridge');
  assert.deepEqual(deliveryPlan(event), []);
  assert.deepEqual(deliveryPlan({ source: 'hook', noLark: false }), ['push', 'telegram', 'lark']);
});

test('控制器在开始/完成节点上报 Worker，help 使用图片卡', async () => {
  const emitted = [];
  const taskValue = {
    ...task('running'), prompt: '测试任务', triggerMessageId: 'm1', rootId: 'm1',
    pendingPrompts: [{ text: '测试任务', messageId: 'm1', rootId: 'm1' }],
  };
  const store = {
    projects: { [taskValue.project]: { path: '/tmp' } },
    updateTask: async (_id, patch) => Object.assign(taskValue, patch),
    recordSession: async () => {}, save: async () => {}, mapMessage: () => {},
  };
  const runner = { run: () => ({
    stop() {},
    promise: Promise.resolve({ ok: true, result: '完成。', eventCount: 1, costUsd: 0.01, claudeDurationMs: 10 }),
  }) };
  const cards = {
    updateTaskCard() {}, sendComplete: async () => 'm-complete', sendArtifacts: async () => [],
    replyNotice: async (id, notice) => ({ id, notice }),
  };
  const controller = new BridgeController({ store, runner, cards, approval: {}, events: { emit: async (stage) => emitted.push(stage) }, log: {} });
  await controller.executeTask(taskValue, {});
  assert.deepEqual(emitted, ['start', 'done']);
  const help = await controller.handleCommand({ name: 'help', args: '' }, { message: { message_id: 'm-help' } });
  assert.equal(help.notice.kind, 'help');
});

test('审批请求上报 permission 节点', async () => {
  const emitted = [];
  const taskValue = task('running');
  const store = { mapMessage() {}, save: async () => {}, updateTask: async () => {}, getTask: () => taskValue };
  const cards = { sendApproval: async () => 'm-approval' };
  const approval = new ApprovalServer({ store, cards, token: 'x', timeoutMs: 1000, events: { emit: async (stage) => emitted.push(stage) }, log: {} });
  const pending = approval.request({ task: taskValue, toolName: 'Write', input: {} });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(emitted, ['permission']);
  const rid = approval.pending.keys().next().value;
  await approval.resolve(rid, 'deny');
  await pending;
});
