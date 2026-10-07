import { createServer } from 'node:http';
import { randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createReadonlyPolicy } from './readonly-policy.mjs';

const ASK_TIMEOUT_TEXT = '用户未回应，请按你的最佳判断继续';

function tokenEquals(left, right) {
  const a = Buffer.from(String(left || ''));
  const b = Buffer.from(String(right || ''));
  return a.length === b.length && a.length > 0 && timingSafeEqual(a, b);
}

async function readJson(req, limit = 1024 * 1024) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('请求体过大');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
}

function reply(res, code, value) {
  const body = JSON.stringify(value);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(body) });
  res.end(body);
}

function isInside(path, root) {
  const rel = relative(resolve(root), resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function globBase(value) {
  const text = String(value || '');
  const wildcard = text.search(/[*!?{}[\]]/);
  return wildcard < 0 ? text : text.slice(0, wildcard).replace(/[/\\][^/\\]*$/, '');
}

export function isBridgeMediaPermission(toolName, input, {
  projectPaths = [],
  legacyRoot = join(homedir(), '.claude', 'cc-bridge-tmp'),
} = {}) {
  const name = String(toolName || '').split('__').at(-1);
  if (!['Read', 'Glob'].includes(name)) return false;
  const candidate = name === 'Read'
    ? input?.file_path || input?.path
    : input?.path || globBase(input?.pattern);
  if (!candidate || !isAbsolute(candidate)) return false;
  const roots = [legacyRoot, ...projectPaths.map((path) => join(path, '.cc-bridge', 'incoming'))].filter(Boolean);
  return roots.some((root) => isInside(candidate, root));
}

export class ApprovalServer {
  constructor({
    store, cards, events = null, port = 18791, token,
    timeoutMs = 10 * 60_000, askTimeoutMs = 15 * 60_000, log = console,
    autoAllowReadonly = process.env.CC_AUTO_ALLOW_READONLY !== '0',
    readonlyConfigPath = join(import.meta.dirname, 'readonly-allow.json'),
  }) {
    this.store = store;
    this.cards = cards;
    this.events = events;
    this.port = port;
    this.token = token;
    this.timeoutMs = timeoutMs;
    this.askTimeoutMs = askTimeoutMs;
    this.log = log;
    this.autoAllowReadonly = Boolean(autoAllowReadonly);
    this.readonlyPolicy = createReadonlyPolicy({ configPath: readonlyConfigPath, log });
    this.pendingSequence = 0;
    this.pending = new Map();
    this.pendingAsk = new Map();
    this.approvalMessageToRid = new Map();
    this.askMessageToRid = new Map();
    this.server = createServer((req, res) => this.#handle(req, res));
  }

  async #handle(req, res) {
    if (req.method !== 'POST' || !['/permission', '/ask-user'].includes(req.url)) return reply(res, 404, { error: 'not found' });
    const auth = String(req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!tokenEquals(auth, this.token)) return reply(res, 401, { error: 'unauthorized' });
    try {
      const body = await readJson(req);
      const task = this.store.getTask(body.taskId);
      if (!task) return reply(res, 404, { error: 'task not found' });
      if (req.url === '/ask-user') {
        const result = await this.requestAsk({
          task,
          question: body.question,
          options: body.options,
          allowCustom: body.allow_custom !== false,
        });
        return reply(res, 200, result);
      }
      const input = body.input && typeof body.input === 'object' ? body.input : {};
      const toolName = body.toolName || body.tool_name || '未知工具';
      if (isBridgeMediaPermission(toolName, input, {
        projectPaths: Object.values(this.store.projects || {}).map((item) => item.path),
      })) {
        this.log.info?.('自动放行:读取用户发送的媒体', { task: task.number, tool: toolName });
        return reply(res, 200, { behavior: 'allow', updatedInput: input });
      }
      if (this.autoAllowReadonly) {
        const readonly = this.readonlyPolicy.evaluate(toolName, input);
        if (readonly.allowed) {
          this.log.info?.(`自动放行:只读 ${readonly.summary}`, { task: task.number, tool: toolName });
          return reply(res, 200, { behavior: 'allow', updatedInput: input });
        }
        if (toolName === 'Bash') {
          const decision = await this.request({ task, toolName, input });
          return reply(res, 200, decision);
        }
      }
      if (task.alwaysAllow) return reply(res, 200, { behavior: 'allow', updatedInput: input });
      const decision = await this.request({ task, toolName, input });
      return reply(res, 200, decision);
    } catch (error) {
      this.log.error?.('交互请求处理失败', error.message);
      if (!res.headersSent) reply(res, 500, { behavior: 'deny', message: `交互服务异常：${error.message}` });
    }
  }

  async #beginWait(task, kind) {
    await this.store.beginTaskWait?.(task.id, kind);
    this.cards.updateTaskCard?.(task);
  }

  async #endWait(taskId, kind) {
    const task = await this.store.endTaskWait?.(taskId, kind);
    if (task) this.cards.updateTaskCard?.(task);
  }

  async request({ task, toolName, input }) {
    const rid = randomUUID();
    this.events?.emit?.('permission', task, { detail: `${toolName || '未知工具'} · ${JSON.stringify(input || {}).slice(0, 400)}` }).catch?.(() => {});
    await this.#beginWait(task, 'approval');
    let settle;
    const result = new Promise((resolveResult) => { settle = resolveResult; });
    const timer = setTimeout(() => {
      this.log.warn?.(`审批超时自动拒绝: #${task.number} rid=${rid}`);
      this.#finishApproval(rid, 'deny', { timeout: true }).catch((error) => this.log.error?.('审批超时收尾失败', error.message));
    }, this.timeoutMs);
    this.pending.set(rid, {
      taskId: task.id, input, resolve: settle, timer, messageId: '',
      sequence: ++this.pendingSequence,
    });
    try {
      const messageId = await this.cards.sendApproval(task, { rid, toolName, input });
      const pending = this.pending.get(rid);
      if (pending) {
        pending.messageId = messageId;
        this.approvalMessageToRid.set(messageId, rid);
      }
      this.store.mapMessage(messageId, task.id);
      await this.store.save();
    } catch (error) {
      await this.#finishApproval(rid, 'deny', { message: `飞书审批卡发送失败：${error.message}`, skipPatch: true });
    }
    return result;
  }

  async #finishApproval(rid, action, { timeout = false, message = '', skipPatch = false } = {}) {
    const pending = this.pending.get(rid);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(rid);
    if (pending.messageId) this.approvalMessageToRid.delete(pending.messageId);
    if (action === 'always') await this.store.updateTask?.(pending.taskId, { alwaysAllow: true });
    await this.#endWait(pending.taskId, 'approval');
    const allowed = action === 'approve' || action === 'always';
    if (!skipPatch && pending.messageId) {
      await this.cards.patchApproval?.(pending.messageId, {
        task: this.store.getTask?.(pending.taskId) || { number: '?', project: 'unknown' },
        status: allowed ? 'allowed' : 'denied',
        detail: timeout ? '10 分钟未处理，已自动拒绝' : allowed ? '主人 已允许' : '主人 已拒绝',
      });
    }
    pending.resolve(allowed
      ? { behavior: 'allow', updatedInput: pending.input }
      : { behavior: 'deny', message: message || (timeout ? '飞书审批等待 10 分钟超时，已自动拒绝' : '主人 在飞书中拒绝了此工具调用') });
    return true;
  }

  resolve(rid, action) {
    return this.#finishApproval(rid, action);
  }

  async requestAsk({ task, question, options, allowCustom = true }) {
    const normalized = (Array.isArray(options) ? options : []).map((item) => String(item).trim()).filter(Boolean);
    if (!String(question || '').trim()) throw new Error('ask_user.question 不能为空');
    if (normalized.length < 2 || normalized.length > 6) throw new Error('ask_user.options 必须有 2-6 个');
    const rid = randomUUID();
    await this.#beginWait(task, 'ask');
    let settle;
    const result = new Promise((resolveResult) => { settle = resolveResult; });
    const timer = setTimeout(() => {
      this.log.warn?.(`ask_user 超时: #${task.number} rid=${rid}`);
      this.#finishAsk(rid, { answer: ASK_TIMEOUT_TEXT, timedOut: true }).catch((error) => this.log.error?.('ask_user 超时收尾失败', error.message));
    }, this.askTimeoutMs);
    this.pendingAsk.set(rid, {
      taskId: task.id, question: String(question).trim(), options: normalized, allowCustom,
      resolve: settle, timer, messageId: '', sequence: ++this.pendingSequence,
    });
    try {
      const messageId = await this.cards.sendAskUser(task, { rid, question: String(question).trim(), options: normalized, allowCustom });
      const pending = this.pendingAsk.get(rid);
      if (pending) pending.messageId = messageId;
      this.askMessageToRid.set(messageId, rid);
      this.store.mapMessage(messageId, task.id);
      await this.store.save();
    } catch (error) {
      await this.#finishAsk(rid, { answer: `ask_user 卡发送失败：${error.message}`, failed: true, skipPatch: true });
    }
    return result;
  }

  async #finishAsk(rid, { index, answer, timedOut = false, failed = false, skipPatch = false } = {}) {
    const pending = this.pendingAsk.get(rid);
    if (!pending) return false;
    const selected = Number.isInteger(index) ? pending.options[index] : '';
    const finalAnswer = selected || String(answer || '').trim();
    if (!finalAnswer || (Number.isInteger(index) && !selected)) return false;
    clearTimeout(pending.timer);
    this.pendingAsk.delete(rid);
    if (pending.messageId) this.askMessageToRid.delete(pending.messageId);
    await this.#endWait(pending.taskId, 'ask');
    if (!skipPatch && pending.messageId) {
      await this.cards.patchAskUser?.(pending.messageId, {
        task: this.store.getTask?.(pending.taskId) || { number: '?', project: 'unknown' },
        question: pending.question, options: pending.options, answer: finalAnswer, timedOut,
      });
    }
    pending.resolve({ answer: finalAnswer, selectedIndex: selected ? index : null, timedOut, failed });
    return true;
  }

  resolveAsk(rid, answer) {
    return this.#finishAsk(rid, answer);
  }

  async resolveText(messageIds, text) {
    const raw = String(text || '').trim();
    if (!raw) return false;
    let candidate = null;
    for (const messageId of (messageIds || []).filter(Boolean)) {
      const approvalRid = this.approvalMessageToRid.get(messageId);
      if (approvalRid && this.pending.has(approvalRid)) {
        candidate = { kind: 'approval', rid: approvalRid, pending: this.pending.get(approvalRid) };
        break;
      }
      const askRid = this.askMessageToRid.get(messageId);
      if (askRid && this.pendingAsk.has(askRid)) {
        candidate = { kind: 'ask', rid: askRid, pending: this.pendingAsk.get(askRid) };
        break;
      }
    }
    if (!candidate) {
      const all = [
        ...[...this.pending.entries()].map(([rid, pending]) => ({ kind: 'approval', rid, pending })),
        ...[...this.pendingAsk.entries()].map(([rid, pending]) => ({ kind: 'ask', rid, pending })),
      ];
      candidate = all.sort((left, right) => right.pending.sequence - left.pending.sequence)[0] || null;
    }
    if (!candidate) return false;

    if (candidate.kind === 'approval') {
      const compact = raw.replace(/\s+/g, '').toLowerCase();
      if ([...compact].length > 8) return false;
      const approve = new Set(['允许', '同意', '批准', '好', '可以', 'ok', 'yes', 'y']);
      const deny = new Set(['拒绝', '不行', '不可以', '别', 'no', 'n']);
      const action = approve.has(compact) ? 'approve' : deny.has(compact) ? 'deny' : '';
      if (!action) return false;
      if (!await this.#finishApproval(candidate.rid, action)) return false;
      return {
        handled: true,
        kind: 'approval',
        action,
        confirmation: action === 'approve' ? '✅ 已允许最新审批。' : '⛔ 已拒绝最新审批。',
      };
    }

    const pending = this.pendingAsk.get(candidate.rid);
    if (!pending) return false;
    let index = pending.options.findIndex((item) => item === raw);
    if (index < 0 && /^\d+$/.test(raw)) {
      const numeric = Number(raw) - 1;
      if (numeric >= 0 && numeric < pending.options.length) index = numeric;
    }
    if (index >= 0) {
      if (!await this.#finishAsk(candidate.rid, { index })) return false;
      return { handled: true, kind: 'ask', answer: pending.options[index], confirmation: `✅ 已选择：${pending.options[index]}` };
    }
    if (!pending.allowCustom) return false;
    if (!await this.#finishAsk(candidate.rid, { answer: raw })) return false;
    return { handled: true, kind: 'ask', answer: raw, confirmation: `✅ 已记录：${raw}` };
  }

  async resolveAskByMessage(messageIds, text) {
    for (const messageId of (messageIds || []).filter(Boolean)) {
      const rid = this.askMessageToRid.get(messageId);
      if (!rid) continue;
      const pending = this.pendingAsk.get(rid);
      if (!pending) continue;
      const exact = pending.options.findIndex((item) => item === String(text || '').trim());
      if (exact >= 0) return this.#finishAsk(rid, { index: exact });
      if (/^\d+$/.test(String(text || '').trim())) {
        const index = Number(String(text).trim()) - 1;
        if (index >= 0 && index < pending.options.length) return this.#finishAsk(rid, { index });
      }
      if (pending.allowCustom) return this.#finishAsk(rid, { answer: String(text || '').trim() });
      return false;
    }
    return false;
  }

  start(host = '127.0.0.1') {
    return new Promise((resolveStart, reject) => {
      const onError = (error) => { this.server.off('listening', onListening); reject(error); };
      const onListening = () => { this.server.off('error', onError); resolveStart(this.server.address()); };
      this.server.once('error', onError);
      this.server.once('listening', onListening);
      this.server.listen(this.port, host);
    });
  }

  close() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ behavior: 'deny', message: 'cc-bridge 正在退出，审批已取消' });
    }
    for (const pending of this.pendingAsk.values()) {
      clearTimeout(pending.timer);
      pending.resolve({ answer: ASK_TIMEOUT_TEXT, timedOut: true });
    }
    this.pending.clear();
    this.pendingAsk.clear();
    this.approvalMessageToRid.clear();
    this.askMessageToRid.clear();
    return new Promise((resolveClose) => this.server.close(() => resolveClose()));
  }
}
