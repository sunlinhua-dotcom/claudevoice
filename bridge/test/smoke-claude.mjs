import assert from 'node:assert/strict';
import { ClaudeRunner } from '../runner.mjs';

const cwd = '/path/to/claudevoice';
const runner = new ClaudeRunner({ timeoutMs: 5 * 60_000 });

async function run(prompt, sessionId = '') {
  const started = runner.run({ taskId: 'smoke', cwd, prompt, sessionId, mode: 'yolo', onEvent: (event) => {
    if (event.raw?.type === 'system' && event.raw?.subtype === 'init') console.log('init.session_id=', event.sessionId);
    if (event.raw?.type === 'result') console.log('result.is_error=', Boolean(event.raw.is_error));
  } });
  return started.promise;
}

console.log('[claude-smoke] 第一问：列根目录文件');
const first = await run('只读列出当前项目根目录的文件和目录名称，用一行逗号分隔，不要修改任何文件。');
console.log('[claude-smoke] first=', JSON.stringify({ ok: first.ok, sessionId: first.sessionId, events: first.eventCount, error: first.error?.slice(0, 180) }));
assert.equal(first.ok, true, first.error);
assert.ok(first.sessionId, '第一问未捕获 session_id');

console.log('[claude-smoke] 第二问：同会话追问');
const second = await run('基于你刚才列出的内容，回答顶层条目总数，只输出数字。', first.sessionId);
console.log('[claude-smoke] second=', JSON.stringify({ ok: second.ok, sessionId: second.sessionId, events: second.eventCount, error: second.error?.slice(0, 180) }));
assert.equal(second.ok, true, second.error);
assert.equal(second.sessionId, first.sessionId, '--resume 后 session_id 不一致');
console.log('[claude-smoke] PASS session_id=', first.sessionId);
