import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { join } from 'node:path';
import { clip } from './utils.mjs';

function appendTail(current, chunk, max = 2048) {
  const next = current + chunk;
  return next.length > max ? next.slice(-max) : next;
}

export class PausableTimeout {
  constructor(ms, callback) {
    this.remainingMs = Math.max(1, Number(ms) || 1);
    this.callback = callback;
    this.reasons = new Set();
    this.timer = null;
    this.startedAt = 0;
    this.#schedule();
  }

  #schedule() {
    if (this.timer || this.reasons.size || this.remainingMs <= 0) return;
    this.startedAt = Date.now();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.remainingMs = 0;
      this.callback();
    }, this.remainingMs);
  }

  pause(reason = 'wait') {
    if (!this.reasons.size && this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
      this.remainingMs = Math.max(1, this.remainingMs - (Date.now() - this.startedAt));
    }
    this.reasons.add(reason);
  }

  resume(reason = 'wait') {
    this.reasons.delete(reason);
    this.#schedule();
  }

  clear() {
    clearTimeout(this.timer);
    this.timer = null;
    this.reasons.clear();
  }
}

function signalChildGroup(child, signal) {
  if (!child || child.exitCode != null) return false;
  try {
    if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
    else child.kill(signal);
    return true;
  } catch {
    try { return child.kill(signal); } catch { return false; }
  }
}

export function inspectClaudeEvent(event) {
  const info = {
    sessionId: event?.session_id || '', tool: '', toolCall: null, text: '', done: false,
    isError: false, result: '', costUsd: 0, claudeDurationMs: 0,
  };
  if (event?.type === 'system' && event?.subtype === 'init') info.sessionId = event.session_id || '';
  if (event?.type === 'assistant') {
    const content = event?.message?.content || [];
    for (const block of content) {
      if (block?.type === 'tool_use') {
        const name = block.name || '工具';
        const summary = clip(JSON.stringify(block.input || {}), 140);
        info.toolCall = { name, summary };
        info.tool = `${name} ${summary}`;
      }
      if (block?.type === 'text') info.text += block.text || '';
    }
  }
  if (event?.type === 'user') {
    for (const block of event?.message?.content || []) {
      if (block?.type === 'tool_result') info.tool = `完成 ${block.tool_use_id ? block.tool_use_id.slice(-8) : '工具调用'}`;
    }
  }
  if (event?.type === 'result') {
    info.done = true;
    info.isError = Boolean(event.is_error);
    info.result = String(event.result || '');
    info.costUsd = Number(event.total_cost_usd) || 0;
    info.claudeDurationMs = Number(event.duration_ms) || 0;
  }
  return info;
}

export class ClaudeRunner {
  constructor({ claudeBin = 'claude', timeoutMs = Number(process.env.CC_TASK_TIMEOUT_MS) || 45 * 60_000, approvalPort = Number(process.env.CC_APPROVAL_PORT) || 18791, approvalToken = process.env.CC_APPROVAL_TOKEN || '' } = {}) {
    this.claudeBin = claudeBin;
    this.timeoutMs = timeoutMs;
    this.approvalPort = approvalPort;
    this.approvalToken = approvalToken;
  }

  buildArgs({ prompt, sessionId = '', mode = 'default', model = '', taskId }) {
    const args = [
      '-p', prompt,
      '--output-format', 'stream-json',
      '--verbose',
      '--append-system-prompt', '你通过飞书为 BRIGHT 工作。除非用户明确要求其他语言，最终回复使用简体中文；代码、路径和命令保持原样。遇到需要用户拍板的多选决策时调用 ask_user 工具提问，选项要具体；不要自问自答重大决策。',
    ];
    if (sessionId) args.push('--resume', sessionId);
    if (model) args.push('--model', model);
    const permissionMode = { accept: 'acceptEdits', yolo: 'bypassPermissions', plan: 'plan', default: 'default' }[mode] || 'default';
    args.push('--permission-mode', permissionMode);
    if (mode !== 'yolo') {
      const config = {
        mcpServers: {
          cc_bridge: {
            command: process.execPath,
            args: [join(import.meta.dirname, 'approve-mcp.mjs')],
            env: {
              CC_APPROVAL_PORT: String(this.approvalPort),
              CC_APPROVAL_TOKEN: this.approvalToken,
              CC_BRIDGE_TASK_ID: taskId,
              CC_APPROVAL_TIMEOUT_MS: String(Number(process.env.CC_APPROVAL_TIMEOUT_MS) || 10 * 60_000),
              CC_ASK_TIMEOUT_MS: String(Number(process.env.CC_ASK_TIMEOUT_MS) || 15 * 60_000),
            },
          },
        },
      };
      args.push(
        '--mcp-config', JSON.stringify(config),
        '--permission-prompt-tool', 'mcp__cc_bridge__permission_prompt',
        '--allowedTools', 'mcp__cc_bridge__ask_user',
      );
    }
    return args;
  }

  run({ taskId, cwd, prompt, sessionId = '', mode = 'default', model = '', onEvent = () => {} }) {
    const args = this.buildArgs({ prompt, sessionId, mode, model, taskId });
    let child;
    let stopped = false;
    let deadline;
    const promise = new Promise((resolve) => {
      const startedAt = Date.now();
      let forceTimer = null;
      let stderrTail = '';
      let capturedSessionId = sessionId;
      let resultText = '';
      let lastAssistantText = '';
      let eventCount = 0;
      let badLines = 0;
      let resultEvent = null;
      let settled = false;
      let timedOut = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        deadline?.clear();
        clearTimeout(forceTimer);
        resolve(value);
      };
      try {
        child = spawn(this.claudeBin, args, {
          cwd,
          env: { ...process.env, CC_BRIDGE: '1' },
          stdio: ['ignore', 'pipe', 'pipe'],
          detached: process.platform !== 'win32',
        });
      } catch (error) {
        finish({ ok: false, error: error.message, stderrTail, sessionId: capturedSessionId, eventCount, durationMs: Date.now() - startedAt });
        return;
      }
      deadline = new PausableTimeout(this.timeoutMs, () => {
        stopped = true;
        timedOut = true;
        signalChildGroup(child, 'SIGTERM');
        forceTimer = setTimeout(() => signalChildGroup(child, 'SIGKILL'), 5000);
      });
      child.stderr.on('data', (chunk) => { stderrTail = appendTail(stderrTail, chunk.toString()); });
      child.on('error', (error) => finish({ ok: false, error: `claude 启动失败：${error.message}`, stderrTail, sessionId: capturedSessionId, eventCount, durationMs: Date.now() - startedAt }));
      const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
      lines.on('line', (line) => {
        if (!line.trim()) return;
        let event;
        try { event = JSON.parse(line); } catch {
          badLines += 1;
          onEvent({ type: 'bad_line', preview: clip(line, 120), eventCount, badLines });
          return;
        }
        eventCount += 1;
        const inspected = inspectClaudeEvent(event);
        if (inspected.sessionId) capturedSessionId = inspected.sessionId;
        if (inspected.text) lastAssistantText = inspected.text;
        if (inspected.done) {
          resultEvent = event;
          resultText = inspected.result || lastAssistantText;
        }
        onEvent({ type: 'event', raw: event, ...inspected, sessionId: capturedSessionId, eventCount, badLines });
      });
      child.on('close', (code, signal) => {
        const isError = Boolean(resultEvent?.is_error) || code !== 0 || stopped;
        finish({
          ok: !isError,
          code,
          signal,
          stopped,
          timedOut,
          error: isError ? (resultText || stderrTail || `claude 退出码 ${code}`) : '',
          result: resultText || lastAssistantText,
          stderrTail,
          sessionId: capturedSessionId,
          eventCount,
          badLines,
          durationMs: Date.now() - startedAt,
          resultEvent,
          costUsd: Number(resultEvent?.total_cost_usd) || 0,
          claudeDurationMs: Number(resultEvent?.duration_ms) || 0,
        });
      });
    });
    return {
      promise,
      stop: () => {
        stopped = true;
        signalChildGroup(child, 'SIGTERM');
      },
      pauseTimeout: (reason = 'wait') => deadline?.pause(reason),
      resumeTimeout: (reason = 'wait') => deadline?.resume(reason),
      get pid() { return child?.pid; },
    };
  }
}
