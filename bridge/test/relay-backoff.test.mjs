import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { formatRelayDuration, RelayInjector } from '../inject.mjs';

const MIN = 60_000;

/** 注入式时钟：now / setTimeout / setInterval 全由 advance() 驱动，不碰真实时间。 */
function makeClock() {
  let t = 1_000_000;
  let seq = 0;
  const timers = new Map();
  const timeoutDelays = [];
  const clock = {
    timeoutDelays,
    now: () => t,
    setTimeoutFn(fn, ms) {
      const id = ++seq;
      timeoutDelays.push(ms);
      timers.set(id, { at: t + ms, fn, every: null });
      return id;
    },
    clearTimeoutFn(id) { timers.delete(id); },
    setIntervalFn(fn, ms) {
      const id = ++seq;
      timers.set(id, { at: t + ms, fn, every: ms });
      return id;
    },
    clearIntervalFn(id) { timers.delete(id); },
    pendingTimeouts() { return [...timers.values()].filter((timer) => timer.every === null).length; },
    advance(ms) {
      const target = t + ms;
      for (;;) {
        let nextId = null;
        for (const [id, timer] of timers) {
          if (timer.at <= target && (nextId === null || timer.at < timers.get(nextId).at)) nextId = id;
        }
        if (nextId === null) break;
        const timer = timers.get(nextId);
        t = timer.at;
        if (timer.every === null) timers.delete(nextId); else timer.at += timer.every;
        timer.fn();
      }
      t = target;
    },
  };
  return clock;
}

function makeFakeWS() {
  return class FakeWS extends EventEmitter {
    static OPEN = 1;
    static instances = [];
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0;
      this.sent = [];
      FakeWS.instances.push(this);
    }
    send(data) { this.sent.push(data); }
    open() { this.readyState = 1; this.emit('open'); }
    recv(message) { this.emit('message', Buffer.from(JSON.stringify(message))); }
    drop(error) {
      if (error) this.emit('error', error);
      this.readyState = 3;
      this.emit('close');
    }
    terminate() { this.drop(); }
    close() { this.drop(); }
  };
}

function setup({ random = () => 0.5 } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'relay-backoff-'));
  const clock = makeClock();
  const WS = makeFakeWS();
  const logs = [];
  const log = {
    info: (...args) => logs.push({ level: 'info', text: args.join(' ') }),
    warn: (...args) => logs.push({ level: 'warn', text: args.join(' ') }),
  };
  const injector = new RelayInjector({
    url: 'wss://relay.invalid/ws', macId: 'mac-test', dir, log,
    WebSocketImpl: WS, now: clock.now, random,
    setTimeoutFn: clock.setTimeoutFn, clearTimeoutFn: clock.clearTimeoutFn,
    setIntervalFn: clock.setIntervalFn, clearIntervalFn: clock.clearIntervalFn,
  });
  const last = () => WS.instances.at(-1);
  /** 让最新一条连接失败，并按刚排的重连延迟推进时钟，触发下一次 connect。 */
  const failAndReconnect = (error = new Error('ECONNREFUSED')) => {
    last().drop(error);
    const delay = clock.timeoutDelays.at(-1);
    clock.advance(delay);
    return delay;
  };
  const pair = () => { last().open(); last().recv({ type: 'paired' }); };
  const cleanup = () => { injector.close(); rmSync(dir, { recursive: true, force: true }); };
  return { injector, clock, WS, logs, last, failAndReconnect, pair, cleanup };
}

test('formatRelayDuration 把毫秒读成中文时长', () => {
  assert.equal(formatRelayDuration(21_000), '21 秒');
  assert.equal(formatRelayDuration(65_000), '1 分 5 秒');
  assert.equal(formatRelayDuration(3 * 3600_000 + 7 * MIN), '3 小时 7 分');
});

test('退避序列 3→6→12→24→48→60→60 秒（无抖动）', () => {
  const { failAndReconnect, WS, cleanup } = setup();
  try {
    const delays = [];
    for (let i = 0; i < 8; i += 1) delays.push(failAndReconnect());
    assert.deepEqual(delays, [3000, 6000, 12000, 24000, 48000, 60000, 60000, 60000]);
    assert.equal(WS.instances.length, 9); // 初始 1 次 + 8 次重连，每次失败后恰好重连一次
  } finally { cleanup(); }
});

test('抖动 ±20%：随机数取两端时延迟落在 0.8x 与 1.2x', () => {
  const low = setup({ random: () => 0 });
  const high = setup({ random: () => 0.999999 });
  try {
    low.last().drop();
    high.last().drop();
    assert.equal(low.clock.timeoutDelays.at(-1), 2400);
    assert.ok(Math.abs(high.clock.timeoutDelays.at(-1) - 3600) <= 1);
    // 封顶后抖动仍围绕 60 秒：48–72 秒
    for (let i = 0; i < 10; i += 1) { low.failAndReconnect(); high.failAndReconnect(); }
    assert.equal(low.clock.timeoutDelays.at(-1), 48_000);
    assert.ok(Math.abs(high.clock.timeoutDelays.at(-1) - 72_000) <= 1);
    assert.ok(Math.max(...high.clock.timeoutDelays) <= 72_000);
  } finally { low.cleanup(); high.cleanup(); }
});

test('收到 paired 后退避重置回 3 秒，并写一条带断线时长的恢复日志', () => {
  const { failAndReconnect, pair, last, clock, logs, cleanup } = setup();
  try {
    failAndReconnect(); // 3s
    failAndReconnect(); // 6s
    failAndReconnect(); // 12s
    pair();
    const recovered = logs.filter((entry) => entry.text.includes('已恢复配对'));
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].level, 'info');
    assert.match(recovered[0].text, /断开 21 秒/);
    assert.match(recovered[0].text, /重连 3 次/);
    // 同一连接重复 paired 不再重复写
    last().recv({ type: 'paired' });
    assert.equal(logs.filter((entry) => entry.text.includes('已恢复配对')).length, 1);
    // 再次断开：退避从 3 秒重新开始，并重新写一条首次断开 warn
    last().drop(new Error('ECONNRESET'));
    assert.equal(clock.timeoutDelays.at(-1), 3000);
    assert.equal(logs.filter((entry) => entry.level === 'warn' && entry.text.includes('已断开')).length, 2);
  } finally { cleanup(); }
});

test('首次正常配对只写「已配对」，不当成恢复', () => {
  const { pair, logs, cleanup } = setup();
  try {
    pair();
    assert.deepEqual(logs.map((entry) => entry.text), ['RemoteVoice relay 已配对']);
  } finally { cleanup(); }
});

test('connect 不再写「连接中」；首次断开只写一条 warn，带原因和下次重试秒数', () => {
  const { failAndReconnect, logs, cleanup } = setup();
  try {
    for (let i = 0; i < 5; i += 1) failAndReconnect(new Error('ECONNREFUSED')); // 累计约 93 秒，< 10 分钟
    assert.equal(logs.length, 1);
    assert.equal(logs[0].level, 'warn');
    assert.match(logs[0].text, /已断开/);
    assert.match(logs[0].text, /ECONNREFUSED/);
    assert.match(logs[0].text, /3 秒后重连/);
    assert.ok(!logs.some((entry) => entry.text.includes('连接中')));
  } finally { cleanup(); }
});

test('连续失败 100 次：日志按 10 分钟节流汇总，不随重连次数线性增长', () => {
  const { failAndReconnect, WS, clock, logs, cleanup } = setup();
  try {
    const startedAt = clock.now();
    for (let i = 0; i < 100; i += 1) failAndReconnect(new Error(i === 99 ? 'ETIMEDOUT' : 'ECONNREFUSED'));
    const elapsed = clock.now() - startedAt;
    assert.equal(WS.instances.length, 101);
    assert.ok(elapsed > 60 * MIN, `模拟时长应覆盖一小时以上，实际 ${elapsed}`);
    assert.ok(logs.length <= 1 + Math.floor(elapsed / (10 * MIN)), `日志 ${logs.length} 行，elapsed=${elapsed}`);
    assert.ok(logs.length <= 12);
    assert.ok(logs.every((entry) => entry.level === 'warn'));
    assert.ok(!logs.some((entry) => entry.text.includes('连接中')));
    const summaries = logs.filter((entry) => entry.text.includes('已连续重连'));
    assert.ok(summaries.length >= 1);
    assert.match(summaries.at(-1).text, /最近错误 (ECONNREFUSED|ETIMEDOUT)/);
    assert.match(summaries.at(-1).text, /已连续重连 \d+ 次/);
  } finally { cleanup(); }
});

test('汇总日志间隔至少 10 分钟', () => {
  const { failAndReconnect, clock, logs, cleanup } = setup();
  try {
    const stamps = [];
    let seen = 0;
    for (let i = 0; i < 60; i += 1) {
      failAndReconnect();
      if (logs.length > seen) { stamps.push(clock.now()); seen = logs.length; }
    }
    assert.ok(stamps.length >= 3);
    for (let i = 1; i < stamps.length; i += 1) {
      // 每条汇总发生在某次 close 时刻，而 stamps 记在其后的重连延迟之后，故容差一个封顶延迟
      assert.ok(stamps[i] - stamps[i - 1] >= 10 * MIN - 72_000, `间隔 ${stamps[i] - stamps[i - 1]}`);
    }
  } finally { cleanup(); }
});

test('close() 之后不再重连：撤销待定定时器，晚到的 close 事件也不排重连', () => {
  const { injector, failAndReconnect, last, clock, WS, logs, cleanup } = setup();
  try {
    failAndReconnect();
    last().drop(new Error('ECONNREFUSED')); // 已排下一次重连
    assert.equal(clock.pendingTimeouts(), 1);
    const instances = WS.instances.length;
    const logged = logs.length;
    injector.close();
    assert.equal(clock.pendingTimeouts(), 0);
    clock.advance(10 * MIN);
    assert.equal(WS.instances.length, instances);
    // 手动再触发 connect / 晚到 close 也不起新连接、不写日志
    injector.connect();
    last().drop(new Error('late'));
    assert.equal(clock.pendingTimeouts(), 0);
    assert.equal(WS.instances.length, instances);
    assert.equal(logs.length, logged);
  } finally { cleanup(); }
});

test('已配对时 close()：不进入重连、不写断线日志', () => {
  const { injector, pair, clock, logs, WS, cleanup } = setup();
  try {
    pair();
    const logged = logs.length;
    injector.close();
    assert.equal(clock.pendingTimeouts(), 0);
    assert.equal(WS.instances.length, 1);
    assert.equal(logs.length, logged);
  } finally { cleanup(); }
});

test('断开时 pending 的注入照旧 reject，随后按退避重连', async () => {
  const { injector, pair, last, clock, cleanup } = setup();
  try {
    pair();
    const result = injector.injectKey('enter', { waitMs: 100, ackMs: 5000 });
    last().drop(new Error('ECONNRESET'));
    await assert.rejects(result, /RemoteVoice relay disconnected/);
    assert.equal(injector.pending.size, 0);
    assert.equal(clock.timeoutDelays.at(-1), 3000);
  } finally { cleanup(); }
});

test('心跳 70 秒无消息主动 terminate，由 close 事件按退避重连并带上「心跳超时」原因', () => {
  const { last, clock, WS, logs, cleanup } = setup();
  try {
    last().open();
    last().recv({ type: 'paired' });
    clock.advance(80_000); // 25s / 50s 发 ping，75s 超过 70s 判超时
    assert.equal(logs.filter((entry) => entry.level === 'warn').length, 1);
    assert.match(logs.at(-1).text, /心跳超时/);
    assert.equal(clock.timeoutDelays.at(-1), 3000);
    clock.advance(3000);
    assert.equal(WS.instances.length, 2);
  } finally { cleanup(); }
});
