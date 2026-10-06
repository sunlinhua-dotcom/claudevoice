import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  buildApprovalCard, buildCompleteCard, buildFailureCard, buildTaskCard,
} from '../cards.mjs';
import { buildSessionUrl, formatRelativeTime, normalizeWebUrl, probeCloudCli } from '../cloudcli.mjs';
import { BridgeController } from '../index.mjs';
import {
  discoverDiskSessions, encodeClaudeProjectPath, mergeProjectSessions, SessionStore,
} from '../sessions.mjs';

function dashboardButtons(card) {
  return card.body.elements.filter((element) => element.tag === 'button' && element.text?.content === '🖥 打开驾驶舱');
}

async function runHook(payload, env = {}) {
  const received = [];
  const server = createServer((request, response) => {
    let body = '';
    request.setEncoding('utf8');
    request.on('data', (chunk) => { body += chunk; });
    request.on('end', () => {
      received.push(JSON.parse(body));
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ ok: true, event: null }));
    });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  const childEnv = { ...process.env };
  delete childEnv.CC_BRIDGE;
  delete childEnv.CLAUDEVOICE_LARK;
  delete childEnv.CLAUDEVOICE_ORIGIN;
  // iMessage 分支的开关也清掉，跑测试的机器环境不至于让用例失真
  delete childEnv.CLAUDEVOICE_IMSG;
  delete childEnv.CLAUDEVOICE_IMSG_BIN;
  delete childEnv.CLAUDEVOICE_IMSG_MIN_SECS;
  delete childEnv.CC_WEB_URL;
  const child = spawn(process.execPath, [join(import.meta.dirname, '..', '..', 'hook.js')], {
    env: {
      ...childEnv,
      CLAUDEVOICE_URL: `http://127.0.0.1:${address.port}/hook`,
      CLAUDEVOICE_NATIVE: '0', CLAUDEVOICE_VOICE: '0',
      ...env,
    },
    stdio: ['pipe', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  child.stdin.end(JSON.stringify(payload));
  const [code] = await once(child, 'exit');
  // hook 主进程只做本地判断就退出，POST 由脱离的子进程稍后发出：
  // 等假 Worker 收到请求再关；本就不该发请求的用例最多静置 2 秒。
  const deadline = Date.now() + 2_000;
  while (!received.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 40));
  server.close();
  await once(server, 'close');
  assert.equal(code, 0, stderr);
  return received;
}

test('discoverDiskSessions 流式读取编码目录，跳过坏行并按 mtime 排序、截断和标注来源', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'cc-cloudcli-sessions-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectsRoot = join(root, '.claude', 'projects');
  const projectPath = '/Volumes/ProjectsAPFS/HZ LIB';
  const encoded = encodeClaudeProjectPath(projectPath);
  assert.equal(encoded, '-Volumes-ProjectsAPFS-HZ-LIB');
  const projectDir = join(projectsRoot, encoded);
  await mkdir(projectDir, { recursive: true });

  const bridgeId = '11111111-1111-4111-8111-111111111111';
  const diskId = '22222222-2222-4222-8222-222222222222';
  const badId = '33333333-3333-4333-8333-333333333333';
  const longPrompt = `请分析${'很长的项目资料'.repeat(30)}`;
  await writeFile(join(projectDir, `${bridgeId}.jsonl`), [
    '不是 JSON',
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: longPrompt }] } }),
  ].join('\n'));
  await writeFile(join(projectDir, `${diskId}.jsonl`), `${JSON.stringify({ type: 'summary', summary: '网页会话摘要' })}\n`);
  await writeFile(join(projectDir, `${badId}.jsonl`), '坏行一\n坏行二\n');
  await writeFile(join(projectDir, 'ignore.txt'), '{}');
  await utimes(join(projectDir, `${bridgeId}.jsonl`), new Date(1000), new Date(1000));
  await utimes(join(projectDir, `${diskId}.jsonl`), new Date(3000), new Date(3000));
  await utimes(join(projectDir, `${badId}.jsonl`), new Date(2000), new Date(2000));

  const sessions = await discoverDiskSessions(projectPath, {
    projectsRoot, limit: 3, bridgeSessions: [{ sessionId: bridgeId }],
  });
  assert.deepEqual(sessions.map((item) => item.sessionId), [diskId, badId, bridgeId]);
  assert.deepEqual(sessions.map((item) => item.source), ['网页/桌面', '网页/桌面', '飞书']);
  assert.equal(sessions[0].preview, '网页会话摘要');
  assert.equal(sessions[1].preview, '');
  assert.ok(sessions[2].preview.length <= 121);
  assert.ok(sessions[2].preview.endsWith('…'));
  assert.deepEqual(await discoverDiskSessions('/missing/project', { projectsRoot }), []);
  const emptyPath = '/empty/project';
  await mkdir(join(projectsRoot, encodeClaudeProjectPath(emptyPath)), { recursive: true });
  assert.deepEqual(await discoverDiskSessions(emptyPath, { projectsRoot }), []);
});

test('合并视图同 id 以 bridge 为准，/resume 序号使用已持久化映射', async (t) => {
  const bridge = [
    { sessionId: 'same', preview: '飞书摘要', updatedAt: 2000 },
    { sessionId: 'bridge-only', preview: '飞书独有', updatedAt: 1000 },
  ];
  const disk = [
    { sessionId: 'disk-only', preview: '网页摘要', mtime: 3000, source: '网页/桌面' },
    { sessionId: 'same', preview: '盘面摘要', mtime: 4000, source: '飞书' },
  ];
  const merged = mergeProjectSessions(bridge, disk);
  assert.deepEqual(merged.map((item) => item.sessionId), ['disk-only', 'same', 'bridge-only']);
  assert.equal(merged.find((item) => item.sessionId === 'same').preview, '飞书摘要');
  assert.equal(merged.find((item) => item.sessionId === 'same').source, '飞书');

  const dir = await mkdtemp(join(tmpdir(), 'cc-cloudcli-map-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new SessionStore({ dir, workspaceRoot: join(dir, 'workspace') });
  await store.setSessionMenu('demo', merged);
  assert.equal((await store.selectResume('demo', 1)).sessionId, 'disk-only');
  assert.equal(store.state.resumeNext.demo, 'disk-only');
  const reloaded = new SessionStore({ dir, workspaceRoot: join(dir, 'workspace') });
  reloaded.state = await reloaded.init().then((value) => value.state);
  assert.deepEqual(reloaded.state.sessionMenus.demo, ['disk-only', 'same', 'bridge-only']);
});

test('CC_WEB_URL 默认值与尾斜杠归一后生成会话深链', () => {
  assert.equal(normalizeWebUrl(), 'https://cc.nforce.top');
  assert.equal(normalizeWebUrl('https://dash.example///'), 'https://dash.example');
  assert.equal(buildSessionUrl('session-1', 'https://dash.example/'), 'https://dash.example/session/session-1');
  assert.equal(buildSessionUrl('', 'https://dash.example/'), '');
});

test('任务、完成、失败和审批卡有 sessionId 时包含合法 schema 2.0 驾驶舱 URL 按钮', () => {
  const previous = process.env.CC_WEB_URL;
  process.env.CC_WEB_URL = 'https://dash.example/';
  try {
    const task = {
      id: 'task-1', number: 7, project: 'demo', prompt: '验证深链', sessionId: 'session-7',
      status: 'running', mode: 'default', model: '', createdAt: 1000, startedAt: 1000,
      finishedAt: 2000, pendingPrompts: [], eventCount: 1, result: '中文摘要必须保留。',
      error: '测试失败', stderrTail: 'stderr',
    };
    const cards = [
      buildTaskCard(task, 2000, {}),
      buildCompleteCard({ ...task, status: 'done' }, {}),
      buildFailureCard({ ...task, status: 'failed' }, {}),
      buildApprovalCard({ task, rid: 'rid-1', toolName: 'Write', input: {} }, {}),
    ];
    for (const card of cards) {
      assert.equal(card.schema, '2.0');
      assert.equal(card.body.elements.some((element) => element.tag === 'note'), false);
      const [button] = dashboardButtons(card);
      assert.ok(button);
      assert.equal(button.url, 'https://dash.example/session/session-7');
      assert.equal(button.multi_url.url, button.url);
      assert.equal(button.multi_url.pc_url, button.url);
    }
    const completeMarkdown = cards[1].body.elements.find((element) => element.tag === 'markdown').content;
    assert.match(completeMarkdown, /结果摘要[\s\S]*中文摘要必须保留/);
  } finally {
    if (previous === undefined) delete process.env.CC_WEB_URL;
    else process.env.CC_WEB_URL = previous;
  }
});

test('sessionId 缺失时所有目标卡片都不渲染驾驶舱按钮', () => {
  const task = {
    id: 'task-2', number: 8, project: 'demo', prompt: '无会话', sessionId: '',
    status: 'running', mode: 'default', model: '', createdAt: 1000, pendingPrompts: [],
    eventCount: 0, result: '完成', error: '失败',
  };
  const cards = [
    buildTaskCard(task, 2000, {}), buildCompleteCard(task, {}), buildFailureCard(task, {}),
    buildApprovalCard({ task, rid: 'rid-2', toolName: 'Read', input: {} }, {}),
  ];
  assert.ok(cards.every((card) => dashboardButtons(card).length === 0));
});

test('/sessions 合并来源并固化序号，/resume 后下一条任务按映射 sessionId 续接', async () => {
  const replies = [];
  const createdArgs = [];
  const store = new SessionStore({ dir: join(tmpdir(), 'unused-cloudcli-controller') });
  store.projects = { demo: { path: '/project/demo' } };
  store.state.currentProject = 'demo';
  store.state.projectSessions.demo = [
    { sessionId: 'same', preview: '飞书摘要', updatedAt: 8_000 },
    { sessionId: 'bridge-only', preview: '飞书独有', updatedAt: 6_000 },
  ];
  store.save = async () => {};
  store.createTask = async (args) => {
    createdArgs.push(args);
    return { id: 'new-task', number: 9, ...args, status: 'queued' };
  };
  store.updateTask = async (_id, patch) => patch;
  store.mapMessage = () => {};
  store.pump = () => {};
  const cards = {
    replyText: async (_id, text) => { replies.push(text); return 'reply-id'; },
    createTaskCard: async () => 'task-card-id',
  };
  const controller = new BridgeController({
    store, runner: {}, cards, approval: {}, now: () => 10_000,
    discoverSessions: async (projectPath, options) => {
      assert.equal(projectPath, '/project/demo');
      assert.equal(options.bridgeSessions, store.state.projectSessions.demo);
      return [
        { sessionId: 'disk-only', preview: '网页摘要', mtime: 9_000, source: '网页/桌面' },
        { sessionId: 'same', preview: '盘面摘要', mtime: 9_500, source: '飞书' },
      ];
    },
  });

  await controller.handleCommand({ name: 'sessions', args: '' }, { message: { message_id: 'm-sessions' } });
  assert.deepEqual(store.state.sessionMenus.demo, ['disk-only', 'same', 'bridge-only']);
  assert.match(replies[0], /1\. \[网页\/桌面\] 网页摘要/);
  assert.match(replies[0], /2\. \[飞书\] 飞书摘要/);
  assert.match(replies[0], /刚刚/);
  assert.match(replies[0], /https:\/\/cc\.nforce\.top\/session\/disk-only/);

  await controller.handleCommand({ name: 'resume', args: '1' }, { message: { message_id: 'm-resume' } });
  await controller.handleText('继续盘面会话', { message: { message_id: 'm-task' }, task: null });
  assert.equal(createdArgs[0].resumeSessionId, 'disk-only');
});

test('相对时间与 CloudCLI 探测使用本机 3001、1.5 秒信号并吞掉失败', async () => {
  assert.equal(formatRelativeTime(9_000, 10_000), '刚刚');
  assert.equal(formatRelativeTime(10_000 - 5 * 60_000, 10_000), '5 分钟前');
  let call;
  assert.equal(await probeCloudCli({ fetchImpl: async (...args) => {
    call = args;
    return { ok: true };
  } }), true);
  assert.equal(call[0], 'http://127.0.0.1:3001/');
  assert.ok(call[1].signal instanceof AbortSignal);
  assert.equal(await probeCloudCli({ fetchImpl: async () => { throw new Error('offline'); } }), false);
});

test('/status 无论有无任务都追加驾驶舱状态，/help 说明深链和盘面续接', async () => {
  const replies = [];
  const store = { listTasks: () => [], state: { currentProject: 'demo', settings: {} } };
  const cards = {
    replyText: async (_id, text) => { replies.push(text); return text; },
    replyNotice: async (_id, notice) => notice,
  };
  const online = new BridgeController({ store, runner: {}, cards, approval: {}, cloudCliProbe: async () => true });
  await online.handleCommand({ name: 'status', args: '' }, { message: { message_id: 'm-status' } });
  assert.match(replies[0], /当前没有活动任务或排队任务。[\s\S]*驾驶舱在线 cc\.nforce\.top/);
  const help = await online.handleCommand({ name: 'help', args: '' }, { message: { message_id: 'm-help' } });
  assert.match(help.markdown, /卡片.*打开驾驶舱/);
  assert.match(help.markdown, /网页\/桌面会话.*续接/);

  store.listTasks = () => [{ number: 3, project: 'demo', status: 'running', pendingPrompts: [] }];
  const offline = new BridgeController({ store, runner: {}, cards, approval: {}, cloudCliProbe: async () => false });
  await offline.handleCommand({ name: 'status', args: '' }, { message: { message_id: 'm-offline' } });
  assert.match(replies[1], /#3 demo · running[\s\S]*驾驶舱离线/);
});

test('hook payload 网页会话跳过飞书、桌面照推、逃生门与 CC_BRIDGE 守卫', async () => {
  const payload = { hook_event_name: 'Notification', cwd: '/tmp/demo', message: 'waiting' };
  const webCalls = await runHook(payload, { CLAUDEVOICE_ORIGIN: 'web' });
  assert.equal(webCalls.length, 1);
  assert.equal(webCalls[0].noLark, true);
  assert.equal('noNotify' in webCalls[0], false);

  const desktopCalls = await runHook(payload, { CLAUDEVOICE_ORIGIN: 'desktop' });
  assert.equal(desktopCalls.length, 1);
  assert.equal('noLark' in desktopCalls[0], false);

  const larkCalls = await runHook(payload, { CLAUDEVOICE_ORIGIN: 'web', CLAUDEVOICE_LARK: '1' });
  assert.equal(larkCalls.length, 1);
  assert.equal('noLark' in larkCalls[0], false);

  const bridgeCalls = await runHook(payload, { CC_BRIDGE: '1' });
  assert.deepEqual(bridgeCalls, []);
});

// ---------- hook.js 的 iMessage 完成深链（一律走假 imsg 脚本落盘断言，绝不真发）----------
const IMSG_SESSION_ID = '44444444-4444-4444-8444-444444444444';

// 造一段会话尾部：真正的用户提示在 promptAgoMs 之前，之后跟着一条时间很新的 tool_result
// （也是 type=user）——起点若误取工具结果，耗时会被算成几秒，深链用例立刻露馅。
async function setupImsgTurn(t, { promptAgoMs, apiError = false, baseUrlEnv = {} }) {
  const root = await mkdtemp(join(tmpdir(), 'cc-imsg-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const now = Date.now();
  const finalText = apiError ? 'API Error (500): 上游服务暂时不可用' : '修复完成，全部测试通过，可以收工了。';
  const transcriptPath = join(root, 'session.jsonl');
  await writeFile(transcriptPath, [
    JSON.stringify({ type: 'user', timestamp: new Date(now - promptAgoMs).toISOString(), message: { role: 'user', content: [{ type: 'text', text: '帮我修这个 bug 并跑测试' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - promptAgoMs + 30_000).toISOString(), message: { role: 'assistant', content: [{ type: 'text', text: '第一轮分析完成。' }] } }),
    JSON.stringify({ type: 'user', timestamp: new Date(now - 1_000).toISOString(), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date(now - 500).toISOString(), isApiErrorMessage: apiError, message: { role: 'assistant', content: [{ type: 'text', text: finalText }] } }),
  ].join('\n'));
  // 假 imsg：把收到的参数追加到环境变量指定的文件里，替代真发 iMessage
  const outPath = join(root, 'imsg-calls.log');
  const binPath = join(root, 'fake-imsg');
  await writeFile(binPath, '#!/bin/sh\nprintf \'%s\\n\' "$*" >> "$FAKE_IMSG_OUT"\n', { mode: 0o755 });
  return {
    outPath,
    env: {
      CLAUDEVOICE_IMSG_BIN: binPath, FAKE_IMSG_OUT: outPath, CLAUDEVOICE_ORIGIN: 'desktop', ...baseUrlEnv,
    },
    payload: {
      hook_event_name: 'Stop', cwd: '/tmp/cc-imsg-demo', transcript_path: transcriptPath, session_id: IMSG_SESSION_ID,
    },
  };
}

async function readImsgCalls(outPath) {
  try { return (await readFile(outPath, 'utf8')).split('\n').filter(Boolean); } catch { return []; }
}

// hook 里 imsg 是 spawn detached 发出去的，落盘比进程退出晚，断言前轮询等一等
async function until(ready, label, timeoutMs = 8_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await ready()) return;
    await sleep(60);
  }
  throw new Error(`等待超时: ${label}`);
}

// 反向断言前的静置：给“本不该发生”的 detached 写盘留足时间
async function assertNoImsgCall(outPath) {
  await sleep(700);
  assert.deepEqual(await readImsgCalls(outPath), []);
}

test('Stop 耗时 ≥120s 经 imsg 发会话深链（起点取用户提示而非 tool_result）', async (t) => {
  const fx = await setupImsgTurn(t, { promptAgoMs: 10 * 60_000 });
  const webCalls = await runHook(fx.payload, fx.env);
  assert.equal(webCalls.length, 1);   // 云端上报照发
  await until(async () => (await readImsgCalls(fx.outPath)).length > 0, '假 imsg 落盘');
  const lines = await readImsgCalls(fx.outPath);
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^「.+」跑完了（约\d+分钟）：修复完成，全部测试通过，可以收工了。 https:\/\/cc\.nforce\.top\/session\/44444444-4444-4444-8444-444444444444$/);
});

test('Stop 耗时 <120s 不发 iMessage，云端链路不受影响', async (t) => {
  const fx = await setupImsgTurn(t, { promptAgoMs: 5_000 });
  const webCalls = await runHook(fx.payload, fx.env);
  assert.equal(webCalls.length, 1);
  await assertNoImsgCall(fx.outPath);
});

test('CLAUDEVOICE_IMSG=0 整个 iMessage 分支跳过', async (t) => {
  const fx = await setupImsgTurn(t, { promptAgoMs: 10 * 60_000 });
  const webCalls = await runHook(fx.payload, { ...fx.env, CLAUDEVOICE_IMSG: '0' });
  assert.equal(webCalls.length, 1);
  await assertNoImsgCall(fx.outPath);
});

test('CLAUDEVOICE_IMSG_BIN 指向不存在的路径时 hook 仍 exit 0 且云端照报', async (t) => {
  const fx = await setupImsgTurn(t, { promptAgoMs: 10 * 60_000 });
  const webCalls = await runHook(fx.payload, {
    ...fx.env, CLAUDEVOICE_IMSG_BIN: join(dirname(fx.outPath), 'no-such-imsg'),
  });
  assert.equal(webCalls.length, 1);
  await assertNoImsgCall(fx.outPath);
});

test('末条 assistant 带 isApiErrorMessage 时按失败口径发，CC_WEB_URL 可覆盖基址', async (t) => {
  const fx = await setupImsgTurn(t, {
    promptAgoMs: 10 * 60_000, apiError: true, baseUrlEnv: { CC_WEB_URL: 'https://dash.example/' },
  });
  const webCalls = await runHook(fx.payload, fx.env);
  assert.equal(webCalls.length, 1);
  await until(async () => (await readImsgCalls(fx.outPath)).length > 0, '假 imsg 落盘');
  const [line] = await readImsgCalls(fx.outPath);
  assert.match(line, /^「.+」失败了（约\d+分钟）：API Error \(500\): 上游服务暂时不可用 https:\/\/dash\.example\/session\/44444444-4444-4444-8444-444444444444$/);
});
