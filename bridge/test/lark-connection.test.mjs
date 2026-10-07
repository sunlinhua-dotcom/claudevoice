import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createObservedDispatcher,
  createSdkLogger,
  LarkConnectionManager,
  reconnectDelay,
} from '../lark-connection.mjs';

test('EventDispatcher 入口只记录事件类型、id 尾 8 位与到达时间', async () => {
  const lines = [];
  const health = { connectedAt: 0, lastEventAt: 0 };
  const raw = {
    invoke: async (data, params) => ({ data, params }),
  };
  const dispatcher = createObservedDispatcher(raw, {
    health,
    now: () => Date.parse('2026-07-23T08:00:00.000Z'),
    log: { info: (...args) => lines.push(args.join(' ')) },
  });
  const data = {
    schema: '2.0',
    header: { event_type: 'im.message.receive_v1', event_id: 'evt_1234567890abcdef' },
    event: { message: { content: '{"text":"绝不能进入日志"}' } },
  };
  const result = await dispatcher.invoke(data, { needCheck: false });
  assert.equal(health.lastEventAt, Date.parse('2026-07-23T08:00:00.000Z'));
  assert.equal(lines[0], '事件到达 im.message.receive_v1 id=90abcdef');
  assert.doesNotMatch(lines[0], /绝不能进入日志/);
  assert.equal(result.data, data);
});

test('SDK error 保留脱敏后的 120 字符诊断，warn 仍隐藏细节', () => {
  const lines = [];
  const sdkLogger = createSdkLogger({
    log: {
      warn: (...args) => lines.push(['warn', ...args].join(' ')),
      error: (...args) => lines.push(['error', ...args].join(' ')),
    },
    secrets: ['cli_0123456789abcdef', 'super-secret-value'],
  });
  sdkLogger.warn('[ws]', 'Bearer private-token');
  sdkLogger.error('[ws]', `app=cli_0123456789abcdef secret=super-secret-value ${'x'.repeat(180)}`);
  assert.equal(lines[0], 'warn 飞书 SDK 警告（敏感细节已隐藏）');
  assert.match(lines[1], /^error 飞书 SDK 请求失败：/);
  assert.doesNotMatch(lines[1], /cli_0123456789abcdef|super-secret-value|private-token/);
  assert.ok(lines[1].replace('error 飞书 SDK 请求失败：', '').length <= 120);
});

test('例行重建使用全新 WSClient，先 force close 旧实例再绑定 dispatcher', async () => {
  const actions = [];
  const instances = [];
  const dispatcher = { invoke: async () => {} };
  const health = { connectedAt: 0, lastEventAt: 0 };
  let now = 1000;
  const manager = new LarkConnectionManager({
    dispatcher,
    health,
    now: () => now,
    log: { info: (line) => actions.push(line), warn: () => {}, error: () => {} },
    schedule: () => ({ unref() {} }),
    cancelSchedule: () => {},
    clientFactory: (callbacks) => {
      const instance = {
        start: async ({ eventDispatcher }) => {
          actions.push(`start:${instances.indexOf(instance)}`);
          assert.equal(eventDispatcher, dispatcher);
          callbacks.onReady();
        },
        close: ({ force }) => actions.push(`close:${instances.indexOf(instance)}:${force}`),
      };
      instances.push(instance);
      return instance;
    },
  });
  await manager.start();
  now = 2000;
  await manager.rebuild('例行');
  assert.equal(instances.length, 2);
  assert.deepEqual(actions.slice(-4), [
    '主动重建飞书长连接（例行）',
    'close:0:true',
    'start:1',
    '飞书长连接重建完成',
  ]);
  assert.equal(health.connectedAt, 2000);
  manager.close();
});

test('重建失败按指数退避持续换新实例，退避封顶 5 分钟', async () => {
  assert.equal(reconnectDelay(1), 5000);
  assert.equal(reconnectDelay(2), 10000);
  assert.equal(reconnectDelay(20), 300000);
  const waits = [];
  const errors = [];
  let attempt = 0;
  const manager = new LarkConnectionManager({
    dispatcher: {},
    health: { connectedAt: 0, lastEventAt: 0 },
    secrets: ['super-secret-value'],
    log: { info: () => {}, warn: () => {}, error: (line) => errors.push(line) },
    schedule: () => ({ unref() {} }),
    cancelSchedule: () => {},
    sleep: async (ms) => waits.push(ms),
    clientFactory: (callbacks) => ({
      start: async () => {
        attempt += 1;
        if (attempt === 1) callbacks.onError(new Error('temporary network failure token=super-secret-value'));
        else callbacks.onReady();
      },
      close: () => {},
    }),
  });
  await manager.start();
  assert.equal(attempt, 2);
  assert.deepEqual(waits, [5000]);
  assert.match(errors[0], /第 1 次.*5 秒后重试/);
  assert.doesNotMatch(errors[0], /super-secret-value/);
  manager.close();
});
