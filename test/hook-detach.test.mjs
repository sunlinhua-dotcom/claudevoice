// hook.js 「脱离子进程」回归测试。
// 过去 hook 主进程要等 Worker 回包（实测 ~5.7 秒）才退出，Claude Code 的 Stop 卡几秒、慢时本机那一声直接丢。
// 现在主进程做完本地判断就把 POST + 读回包 + enqueueDesktop 交给 detached 子进程并立刻退出。
// 全部用例用临时 HOME + 本地假 Worker，绝不碰线上；互相独立，并发跑。
// 跑：npm test（即 node --test test/*.test.mjs）
import { describe, test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HOOK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'hook.js');
const EVENT = { speak: '测试播报：任务已完成', voice: '晓晓', project: 'demoproj' };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs = 8000, step = 50) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const v = fn();
    if (v) return v;
    await sleep(step);
  }
  return fn();
}

// 临时 HOME + 假配置 + 本地假 Worker。delayMs = 回包延迟；up=false 时端口关掉（模拟 Worker 不可达）。
async function sandbox({ delayMs = 0, up = true, reply = { event: EVENT } } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cvhook-'));
  const secret = 'SECRET-' + Math.random().toString(36).slice(2) + '-' + Date.now();
  const requests = [];
  let replied = 0;
  const server = http.createServer((req, res) => {
    const ch = [];
    req.on('data', (c) => ch.push(c));
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, headers: req.headers, body: Buffer.concat(ch).toString('utf8') });
      setTimeout(() => {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(reply), () => { replied++; });
      }, delayMs);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  if (!up) await new Promise((r) => server.close(r));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(
    path.join(home, '.claude', 'claudevoice.json'),
    JSON.stringify({ url: `http://127.0.0.1:${port}/hook`, secret }),
    { mode: 0o600 },
  );
  const queueDir = path.join(home, '.claude', 'cv-queue');
  return {
    home, secret, requests, port,
    cwd: path.join(home, 'demoproj', 'src'),
    queue: () => (fs.existsSync(queueDir) ? fs.readdirSync(queueDir) : []),
    readQueue: () => fs.readdirSync(queueDir).map((f) => JSON.parse(fs.readFileSync(path.join(queueDir, f), 'utf8'))),
    async close() {
      // 等所有在途回包发完再多给子进程一点落盘时间，免得它在 HOME 被删后又把目录建回来
      await waitFor(() => replied >= requests.length, 10000);
      await sleep(400);
      if (up) await new Promise((r) => { server.close(r); server.closeAllConnections?.(); });
      fs.rmSync(home, { recursive: true, force: true });
    },
  };
}

// 起 hook 主进程。env 显式构造（只给 PATH / HOME），防止测试机上的 CLAUDEVOICE_URL / SECRET / CC_BRIDGE 漏进来
// 把请求发到线上。等 'close'（stdout/stderr 管道都关）才算退出，这正是 Claude Code 判断 hook 结束的口径。
function runHook(sb, stdinStr, { env = {}, argv = ['Stop'] } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = Date.now();
    const child = spawn(process.execPath, [HOOK, ...argv], {
      env: {
        PATH: process.env.PATH,
        HOME: sb.home,
        CLAUDEVOICE_NATIVE: '0',      // 不弹 Mac 横幅
        CLAUDEVOICE_IMSG: '0',        // 不发 iMessage
        CLAUDEVOICE_ORIGIN: 'desktop', // 跳过 ps 父进程链判定
        ...env,
      },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.stdin.on('error', () => {});   // CC_BRIDGE=1 时 hook 一上来就退，写 stdin 会 EPIPE
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, ms: Date.now() - t0, out }));
    child.stdin.end(stdinStr);
  });
}

const stopEvent = (sb, extra = {}) => JSON.stringify({
  hook_event_name: 'Stop', session_id: 'sess-123', cwd: sb.cwd, ...extra,
});

function writeTranscript(sb, text, minutesAgo = 0) {
  const p = path.join(sb.home, 't.jsonl');
  const ts = new Date(Date.now() - minutesAgo * 60000).toISOString();
  fs.writeFileSync(p, [
    JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: '开始干活' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  ].join('\n') + '\n');
  return p;
}

describe('hook.js 脱离子进程', { concurrency: true }, () => {
  test('Worker 慢 3 秒回包：主进程 1 秒内退出，事件仍由子进程写进 cv-queue', async () => {
    const sb = await sandbox({ delayMs: 3000 });
    try {
      const r = await runHook(sb, stopEvent(sb));
      assert.equal(r.code, 0);
      assert.ok(r.ms < 1000, `主进程应 1 秒内退出，实际 ${r.ms}ms`);
      assert.equal(r.out, '', '主进程不许有任何输出');
      assert.deepEqual(sb.queue(), [], '回包还没到，此刻队列应为空（说明 enqueue 不在主进程里）');

      assert.ok(await waitFor(() => sb.queue().length === 1, 10000), '子进程应在回包后把事件写进 cv-queue');
      assert.deepEqual(sb.readQueue()[0], EVENT);

      // 请求体 / header 格式不变：子进程自己读配置拿到了 secret
      assert.equal(sb.requests.length, 1);
      const q = sb.requests[0];
      assert.equal(q.method, 'POST');
      assert.equal(q.url, '/hook');
      assert.equal(q.headers['x-cv-secret'], sb.secret);
      assert.equal(q.headers['content-type'], 'application/json');
      assert.equal(Number(q.headers['content-length']), Buffer.byteLength(q.body));
      const body = JSON.parse(q.body);
      assert.equal(body.hook_event_name, 'Stop');
      assert.equal(body.session_id, 'sess-123');
      assert.equal(body.cv_project, 'demoproj');

      // 不留临时文件：.claude 下只有配置和 cv-queue
      assert.deepEqual(fs.readdirSync(path.join(sb.home, '.claude')).sort(), ['claudevoice.json', 'cv-queue']);
    } finally { await sb.close(); }
  });

  test('secret 不出现在子进程 argv / 环境变量里', async () => {
    const sb = await sandbox({ delayMs: 3000 });
    try {
      const r = await runHook(sb, stopEvent(sb));
      assert.equal(r.code, 0);
      // 子进程此刻还在等 Worker 的延迟回包，正好抓它
      assert.ok(await waitFor(() => sb.requests.length === 1), '请求应已到达假 Worker');
      // -E 让 macOS 的 ps 把环境变量也带出来；各行形如 "<pid> <argv...> <ENV=...>"
      const lines = execFileSync('ps', ['-axwwE', '-o', 'pid=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 })
        .split('\n');
      const mine = lines.filter((l) => l.includes('--cv-detached') && l.includes(HOOK) && l.includes(`HOME=${sb.home}`));
      const anyDetached = lines.filter((l) => l.includes('--cv-detached') && l.includes(HOOK));
      assert.ok(anyDetached.length >= 1, '应能在进程表里看到脱离的子进程（argv 带 --cv-detached）');
      for (const l of lines) assert.ok(!l.includes(sb.secret), 'secret 不得出现在任何进程的 argv / 环境里');
      if (mine.length) {   // ps 肯把环境带出来时，额外确认就是我们这个子进程且干净
        assert.equal(mine.length, 1);
        assert.ok(!mine[0].includes('CLAUDEVOICE_SECRET'));
      }
      assert.ok(await waitFor(() => sb.queue().length === 1, 10000));
    } finally { await sb.close(); }
  });

  test('CC_BRIDGE=1：直接退出，不发请求、不写队列、不起子进程', async () => {
    const sb = await sandbox();
    try {
      const r = await runHook(sb, stopEvent(sb), { env: { CC_BRIDGE: '1' } });
      assert.equal(r.code, 0);
      assert.ok(r.ms < 1000);
      await sleep(1500);
      assert.equal(sb.requests.length, 0);
      assert.deepEqual(sb.queue(), []);
    } finally { await sb.close(); }
  });

  test('CLAUDEVOICE_VOICE=0：照常 POST，但不进桌面播放队列', async () => {
    const sb = await sandbox();
    try {
      const r = await runHook(sb, stopEvent(sb), { env: { CLAUDEVOICE_VOICE: '0' } });
      assert.equal(r.code, 0);
      assert.ok(await waitFor(() => sb.requests.length === 1));
      await sleep(1000);   // 假 Worker 立即回包，子进程若要写早写完了
      assert.deepEqual(sb.queue(), []);
    } finally { await sb.close(); }
  });

  test('静音事件（silent）不进播放队列', async () => {
    const sb = await sandbox({ reply: { event: { ...EVENT, silent: true } } });
    try {
      await runHook(sb, stopEvent(sb));
      assert.ok(await waitFor(() => sb.requests.length === 1));
      await sleep(1000);
      assert.deepEqual(sb.queue(), []);
    } finally { await sb.close(); }
  });

  test('Worker 不可达：主进程照样秒退、退出码 0', async () => {
    const sb = await sandbox({ up: false });
    try {
      const r = await runHook(sb, stopEvent(sb));
      assert.equal(r.code, 0);
      assert.ok(r.ms < 1000, `实际 ${r.ms}ms`);
      assert.equal(r.out, '');
      await sleep(500);
      assert.deepEqual(sb.queue(), []);
    } finally { await sb.close(); }
  });

  test('中文末句：cv_preview 由主进程读 transcript 填好后随请求发出', async () => {
    const sb = await sandbox();
    try {
      const text = '已经完成了全部改动，测试都通过了。';
      const transcript_path = writeTranscript(sb, text);
      const r = await runHook(sb, stopEvent(sb, { transcript_path }));
      assert.equal(r.code, 0);
      assert.ok(await waitFor(() => sb.requests.length === 1));
      assert.equal(JSON.parse(sb.requests[0].body).cv_preview, text);
      assert.ok(await waitFor(() => sb.queue().length === 1));
    } finally { await sb.close(); }
  });

  test('stdin 不是合法 JSON：原样透传给 Worker', async () => {
    const sb = await sandbox();
    try {
      const r = await runHook(sb, 'not-json{');
      assert.equal(r.code, 0);
      assert.ok(await waitFor(() => sb.requests.length === 1));
      assert.equal(sb.requests[0].body, 'not-json{');
    } finally { await sb.close(); }
  });

  test('超过管道缓冲的大 payload（30 万字 prompt）完整送达', async () => {
    const sb = await sandbox({ delayMs: 500 });
    try {
      const prompt = '测'.repeat(300000);
      const r = await runHook(sb, JSON.stringify({ hook_event_name: 'UserPromptSubmit', cwd: sb.cwd, prompt }), { argv: ['UserPromptSubmit'] });
      assert.equal(r.code, 0);
      assert.ok(r.ms < 2500, `实际 ${r.ms}ms`);
      assert.ok(await waitFor(() => sb.requests.length === 1));
      const body = JSON.parse(sb.requests[0].body);
      assert.equal(body.prompt.length, 300000);
      assert.equal(body.hook_event_name, 'UserPromptSubmit');
    } finally { await sb.close(); }
  });

  // CloudCLI 静音口径：网页会话 noLark=true；桌面不带；CLAUDEVOICE_LARK=1 强制恢复推送
  for (const [name, env, expected] of [
    ['CloudCLI 网页会话 → noLark=true', { CLAUDEVOICE_ORIGIN: 'web' }, true],
    ['桌面会话 → 不带 noLark', { CLAUDEVOICE_ORIGIN: 'desktop' }, undefined],
    ['网页会话 + CLAUDEVOICE_LARK=1 → 不带 noLark', { CLAUDEVOICE_ORIGIN: 'web', CLAUDEVOICE_LARK: '1' }, undefined],
  ]) {
    test(name, async () => {
      const sb = await sandbox();
      try {
        await runHook(sb, stopEvent(sb), { env });
        assert.ok(await waitFor(() => sb.requests.length === 1));
        assert.equal(JSON.parse(sb.requests[0].body).noLark, expected);
      } finally { await sb.close(); }
    });
  }

  test('iMessage 深链仍由主进程发出（耗时超门槛），且不拖慢退出', async () => {
    const sb = await sandbox({ delayMs: 2000 });
    try {
      const out = path.join(sb.home, 'imsg.out');
      const bin = path.join(sb.home, 'fake-imsg');
      fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`, { mode: 0o755 });
      const transcript_path = writeTranscript(sb, '全部搞定。', 10);
      const env = { CLAUDEVOICE_IMSG: '1', CLAUDEVOICE_IMSG_BIN: bin, CC_WEB_URL: 'https://cc.example.test/' };
      const r = await runHook(sb, stopEvent(sb, { transcript_path }), { env });
      assert.equal(r.code, 0);
      assert.ok(r.ms < 1000, `实际 ${r.ms}ms`);
      assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').length > 0), 'fake imsg 应被调用');
      const line = fs.readFileSync(out, 'utf8');
      assert.match(line, /「demoproj」跑完了（约10分钟）：全部搞定。 https:\/\/cc\.example\.test\/session\/sess-123$/);
      assert.ok(await waitFor(() => sb.requests.length === 1), '云端链路照常');
    } finally { await sb.close(); }
  });

  test('没配 CC_WEB_URL / webUrl：通知只有摘要，不带链接', async () => {
    const sb = await sandbox();
    try {
      const out = path.join(sb.home, 'imsg.out');
      const bin = path.join(sb.home, 'fake-imsg');
      fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`, { mode: 0o755 });
      const transcript_path = writeTranscript(sb, '全部搞定。', 10);
      const env = { CLAUDEVOICE_IMSG: '1', CLAUDEVOICE_IMSG_BIN: bin };
      const r = await runHook(sb, stopEvent(sb, { transcript_path }), { env });
      assert.equal(r.code, 0);
      assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').length > 0), 'fake imsg 应被调用');
      const line = fs.readFileSync(out, 'utf8');
      assert.match(line, /^「demoproj」跑完了（约10分钟）：全部搞定。$/);
      assert.doesNotMatch(line, /https?:\/\//);
    } finally { await sb.close(); }
  });

  test('claudevoice.json 里的 webUrl 生效，环境变量 CC_WEB_URL 优先', async () => {
    const sb = await sandbox();
    try {
      const cfgFile = path.join(sb.home, '.claude', 'claudevoice.json');
      const cfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
      fs.writeFileSync(cfgFile, JSON.stringify({ ...cfg, webUrl: 'https://from-config.example///' }));
      const bin = path.join(sb.home, 'fake-imsg');
      const out = path.join(sb.home, 'imsg.out');
      fs.writeFileSync(bin, `#!/bin/sh\nprintf '%s' "$1" > '${out}'\n`, { mode: 0o755 });
      const transcript_path = writeTranscript(sb, '全部搞定。', 10);
      await runHook(sb, stopEvent(sb, { transcript_path }), { env: { CLAUDEVOICE_IMSG: '1', CLAUDEVOICE_IMSG_BIN: bin } });
      assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').length > 0));
      assert.match(fs.readFileSync(out, 'utf8'), / https:\/\/from-config\.example\/session\/sess-123$/);
      fs.rmSync(out);
      await runHook(sb, stopEvent(sb, { transcript_path }), { env: { CLAUDEVOICE_IMSG: '1', CLAUDEVOICE_IMSG_BIN: bin, CC_WEB_URL: 'https://from-env.example' } });
      assert.ok(await waitFor(() => fs.existsSync(out) && fs.readFileSync(out, 'utf8').length > 0));
      assert.match(fs.readFileSync(out, 'utf8'), / https:\/\/from-env\.example\/session\/sess-123$/);
    } finally { await sb.close(); }
  });
});
