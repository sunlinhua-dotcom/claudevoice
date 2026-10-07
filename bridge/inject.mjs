import WebSocket from 'ws';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';

const FILE_CLIPBOARD_SCRIPT = [
  'on run argv',
  '  if (count of argv) is 1 then',
  '    set the clipboard to POSIX file (item 1 of argv)',
  '    return',
  '  end if',
  '  set fileItems to {}',
  '  repeat with itemPath in argv',
  '    set end of fileItems to (POSIX file itemPath)',
  '  end repeat',
  '  set the clipboard to fileItems',
  'end run',
].join('\n');

const PNG_CLIPBOARD_SCRIPT = [
  'on run argv',
  '  set the clipboard to (read (POSIX file (item 1 of argv)) as «class PNGf»)',
  'end run',
].join('\n');

const JPEG_CLIPBOARD_SCRIPT = [
  'on run argv',
  '  set the clipboard to (read (POSIX file (item 1 of argv)) as «class JPEG»)',
  'end run',
].join('\n');

const GIF_CLIPBOARD_SCRIPT = [
  'on run argv',
  '  set the clipboard to (read (POSIX file (item 1 of argv)) as «class GIFf»)',
  'end run',
].join('\n');

const APPKIT_IMAGE_CLIPBOARD_SCRIPT = [
  'use framework "AppKit"',
  'use scripting additions',
  'on run argv',
  "  set theImage to current application's NSImage's alloc()'s initWithContentsOfFile:(item 1 of argv)",
  '  if theImage is missing value then error "NSImage 无法读取图片"',
  "  set pb to current application's NSPasteboard's generalPasteboard()",
  "  pb's clearContents()",
  "  set wrote to pb's writeObjects:{theImage}",
  '  if wrote as boolean is false then error "NSPasteboard 写入失败"',
  'end run',
].join('\n');

const CLIPBOARD_INFO_SCRIPT = 'clipboard info';

function runOsaScript(script, argv = [], { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('osascript', ['-e', script, '--', ...argv.map(String)], {
      stdio: ['ignore', 'pipe', 'pipe'], shell: false,
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve(stdout.trim());
    };
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(new Error(`osascript 启动失败：${error.message}`)));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`osascript 退出码 ${code}：${stderr.trim() || '未知错误'}`)));
  });
}

function isClipboardInfoVerified(info, kind) {
  const value = String(info || '');
  if (kind === 'image') return /(PNGf|JPEG|GIFf|TIFF|picture|image)/i.test(value);
  return /(furl|alis|file URL|alias)/i.test(value);
}

function imageScriptFor(attachment) {
  const extension = extname(String(attachment?.path || attachment?.name || '')).toLowerCase();
  const mime = String(attachment?.mime || '').toLowerCase();
  if (extension === '.png' || mime === 'image/png') return PNG_CLIPBOARD_SCRIPT;
  if (['.jpg', '.jpeg'].includes(extension) || mime === 'image/jpeg') return JPEG_CLIPBOARD_SCRIPT;
  if (extension === '.gif' || mime === 'image/gif') return GIF_CLIPBOARD_SCRIPT;
  if (extension === '.webp' || mime === 'image/webp') return APPKIT_IMAGE_CLIPBOARD_SCRIPT;
  return '';
}

async function verifyClipboard(kind, { spawnImpl = spawn } = {}) {
  const clipboardInfo = await runOsaScript(CLIPBOARD_INFO_SCRIPT, [], { spawnImpl });
  if (!isClipboardInfoVerified(clipboardInfo, kind)) {
    throw new Error(`剪贴板读回验证失败：未发现${kind === 'image' ? '图片数据' : '文件引用'}（${clipboardInfo || 'clipboard info 为空'}）`);
  }
  return clipboardInfo;
}

// 只在桌面会话里可用：PM2 开机拉起的 cc-bridge 没有剪贴板，生产路径改由电脑端 ClaudeVoice 粘贴（见 pasteItems）。
// 保留给手动跑的 e2e 脚本。
export async function writeAttachmentsToClipboard(attachments, { spawnImpl = spawn } = {}) {
  const items = (attachments || []).filter((item) => item?.path);
  if (!items.length) throw new Error('没有可写入剪贴板的附件文件');
  const imageScript = items.length === 1 ? imageScriptFor(items[0]) : '';
  let primaryError = null;
  if (imageScript) {
    try {
      await runOsaScript(imageScript, [items[0].path], { spawnImpl });
      const clipboardInfo = await verifyClipboard('image', { spawnImpl });
      return { verified: true, kind: 'image', method: 'image-data', fallback: false, clipboardInfo };
    } catch (error) {
      primaryError = error;
    }
  }
  await runOsaScript(FILE_CLIPBOARD_SCRIPT, items.map((item) => item.path), { spawnImpl });
  const clipboardInfo = await verifyClipboard('file', { spawnImpl });
  return {
    verified: true, kind: 'file', method: 'file-reference', fallback: Boolean(primaryError),
    primaryError: primaryError?.message || '', clipboardInfo,
  };
}

/** cc-bridge 由 PM2 在后台拉起，没有桌面会话也就没有剪贴板；贴图 / 贴文字交给电脑端 ClaudeVoice。
 *  指令搭中继的 inject_key 通道（中继对 key 原样转发）：key = "cv:" + JSON。
 *  中继只透传 inject_ack 的 id / ok / mode，所以 App 把结果塞进 mode："cv:" + {pasted,total,app,reason}。 */
export const MAC_COMMAND_PREFIX = 'cv:';

export function buildMacCommand(op, payload = {}) {
  return `${MAC_COMMAND_PREFIX}${JSON.stringify({ op, ...payload })}`;
}

const RELAY_REASONS = {
  mac_offline: '电脑端 ClaudeVoice 不在线',
  no_room: '中继里找不到这台电脑的配对',
  empty: '指令为空',
};

/** 注入 / 按键没成功时给人看的原因。 */
export function describeRelayFailure(result) {
  if (result?.unconfirmed) return '电脑端没有回执';
  if (result?.reason) return RELAY_REASONS[result.reason] || String(result.reason);
  if (result?.mode === 'failed') return '电脑端执行失败：可能缺辅助功能权限，或正处在密码输入状态';
  return '电脑端未确认';
}

/** 把 inject_result 读成贴图结果。旧版 App 不认识 cv: 指令时会回 mode=failed。 */
export function readMacPasteResult(result, total = 0) {
  const base = { ok: false, unconfirmed: false, pasted: 0, total, app: '', reason: '' };
  if (result?.unconfirmed) return { ...base, unconfirmed: true, reason: '电脑端没有回执' };
  const mode = String(result?.mode || '');
  if (mode.startsWith(MAC_COMMAND_PREFIX)) {
    try {
      const value = JSON.parse(mode.slice(MAC_COMMAND_PREFIX.length));
      const pasted = Math.max(0, Number(value.pasted) || 0);
      const count = Math.max(0, Number(value.total) || total);
      return {
        ...base, ok: Boolean(result.ok) && count > 0 && pasted === count,
        pasted, total: count, app: String(value.app || ''), reason: String(value.reason || ''),
      };
    } catch {}
  }
  if (result?.reason) return { ...base, reason: RELAY_REASONS[result.reason] || String(result.reason) };
  return { ...base, reason: '电脑端 ClaudeVoice 没执行粘贴：版本太旧需要重装，或缺辅助功能权限' };
}

// 只在桌面会话里可用，生产路径见 pasteText。保留给手动跑的 e2e 脚本。
export function copyTextToClipboard(text, { spawnImpl = spawn } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawnImpl('pbcopy', [], { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      if (error) reject(error);
      else resolve();
    };
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(new Error(`pbcopy 启动失败：${error.message}`)));
    child.on('close', (code) => finish(code === 0 ? null : new Error(`pbcopy 退出码 ${code}：${stderr.trim() || '未知错误'}`)));
    child.stdin?.on('error', (error) => finish(new Error(`pbcopy 写入失败：${error.message}`)));
    child.stdin.end(Buffer.from(String(text), 'utf8'));
  });
}

export function shouldAnnouncePaired(wasPaired) {
  return !wasPaired;
}

// 重连退避：3 秒起，每次失败 ×2，名义封顶 60 秒，再叠加 ±20% 抖动；收到 paired 才重置。
export const RELAY_BACKOFF_BASE_MS = 3000;
export const RELAY_BACKOFF_MAX_MS = 60_000;
export const RELAY_BACKOFF_JITTER = 0.2;
// 持续断线期间，汇总日志的最小间隔。
export const RELAY_SUMMARY_INTERVAL_MS = 10 * 60_000;

export function formatRelayDuration(ms) {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total} 秒`;
  const minutes = Math.floor(total / 60);
  if (minutes < 60) return `${minutes} 分 ${total % 60} 秒`;
  const hours = Math.floor(minutes / 60);
  return `${hours} 小时 ${minutes % 60} 分`;
}

export class RelayInjector {
  constructor({
    url, macId, name = 'Claude 飞书指挥台', dir = import.meta.dirname, log = console, autoConnect = true,
    // 以下为可测性注入项，默认值即生产行为。
    WebSocketImpl = WebSocket, now = Date.now, random = Math.random,
    setTimeoutFn = setTimeout, clearTimeoutFn = clearTimeout,
    setIntervalFn = setInterval, clearIntervalFn = clearInterval,
  }) {
    this.url = url;
    this.macId = macId;
    this.name = name;
    this.log = log;
    this.WebSocketImpl = WebSocketImpl;
    this.now = () => now();
    this.random = () => random();
    this.setTimeoutFn = (...args) => setTimeoutFn(...args);
    this.clearTimeoutFn = (...args) => clearTimeoutFn(...args);
    this.setIntervalFn = (...args) => setIntervalFn(...args);
    this.clearIntervalFn = (...args) => clearIntervalFn(...args);
    this.tokenFile = join(dir, `.device_token.${String(macId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_')}`);
    this.deviceToken = this.#loadToken();
    this.ws = null;
    this.paired = false;
    this.closed = false;
    this.lastSeen = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pending = new Map();
    // 重连状态：disconnectedAt 非 null 表示「正处于断线期」，日志只在状态变化时写。
    this.backoffMs = RELAY_BACKOFF_BASE_MS;
    this.disconnectedAt = null;
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.lastSummaryAt = 0;
    if (autoConnect && url && macId) this.connect();
  }

  #loadToken() { try { return readFileSync(this.tokenFile, 'utf8').trim() || null; } catch { return null; } }
  #saveToken(value) { try { writeFileSync(this.tokenFile, value, { mode: 0o600 }); } catch (error) { this.log.warn?.('device_token 保存失败', error.message); } }
  #dropToken() { try { unlinkSync(this.tokenFile); } catch {} }

  /** 计算下一次重连延迟（带 ±20% 抖动），并把名义退避翻倍（封顶 60 秒）。 */
  #nextReconnectDelay() {
    const base = this.backoffMs;
    this.backoffMs = Math.min(base * 2, RELAY_BACKOFF_MAX_MS);
    const jitter = 1 + (this.random() * 2 - 1) * RELAY_BACKOFF_JITTER;
    return Math.max(0, Math.round(base * jitter));
  }

  #onSocketClosed() {
    this.paired = false;
    this.clearIntervalFn(this.pingTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer); // 这些 ack 计时器由 #inject 用全局 setTimeout 创建，不走注入的时钟
      pending.reject(new Error('RemoteInput relay disconnected'));
    }
    this.pending.clear();
    if (this.closed) return;
    const delay = this.#nextReconnectDelay();
    const seconds = Math.round(delay / 1000);
    const at = this.now();
    if (this.disconnectedAt === null) {
      // 状态变化：已连接（或首次）→ 断开，写一条。
      this.disconnectedAt = at;
      this.reconnectAttempts = 0;
      this.lastSummaryAt = at;
      const why = this.lastError ? `（${this.lastError}）` : '';
      this.log.warn?.(`RemoteInput relay 已断开${why}，${seconds} 秒后重连`);
    } else {
      this.reconnectAttempts += 1;
      if (at - this.lastSummaryAt >= RELAY_SUMMARY_INTERVAL_MS) {
        this.lastSummaryAt = at;
        this.log.warn?.(`RemoteInput relay 已断开 ${formatRelayDuration(at - this.disconnectedAt)}，已连续重连 ${this.reconnectAttempts} 次，最近错误 ${this.lastError || '无'}，${seconds} 秒后重试`);
      }
    }
    this.reconnectTimer = this.setTimeoutFn(() => this.connect(), delay);
  }

  #onPaired() {
    const wasDown = this.disconnectedAt !== null;
    const downFor = wasDown ? this.now() - this.disconnectedAt : 0;
    const attempts = this.reconnectAttempts;
    this.backoffMs = RELAY_BACKOFF_BASE_MS;
    this.disconnectedAt = null;
    this.reconnectAttempts = 0;
    this.lastError = null;
    this.lastSummaryAt = 0;
    return { wasDown, downFor, attempts };
  }

  connect() {
    if (this.closed || !this.url) return;
    this.clearTimeoutFn(this.reconnectTimer);
    const ws = new this.WebSocketImpl(this.url);
    this.ws = ws;
    this.paired = false;
    this.lastSeen = this.now();
    ws.on('open', () => {
      const hello = { type: 'hello', role: 'phone', macId: this.macId, name: this.name };
      if (this.deviceToken) hello.deviceToken = this.deviceToken;
      ws.send(JSON.stringify(hello));
    });
    ws.on('message', (buffer) => {
      this.lastSeen = this.now();
      let message;
      try { message = JSON.parse(buffer.toString()); } catch { return; }
      this.handleMessage(message);
    });
    // 连接异常只记下原因，由 close 事件统一按状态变化写日志。
    ws.on('error', (error) => { this.lastError = error?.message || String(error); });
    ws.on('close', () => this.#onSocketClosed());
    this.clearIntervalFn(this.pingTimer);
    this.pingTimer = this.setIntervalFn(() => {
      if (ws.readyState !== (this.WebSocketImpl.OPEN ?? 1)) return;
      if (this.now() - this.lastSeen > 70_000) {
        this.lastError = '心跳超时';
        ws.terminate();
        return;
      }
      ws.send(JSON.stringify({ type: 'ping' }));
    }, 25_000);
    this.pingTimer.unref?.();
  }

  handleMessage(message) {
    if (message.type === 'paired') {
        const announce = shouldAnnouncePaired(this.paired);
        this.paired = true;
        if (message.device_token) {
          this.deviceToken = message.device_token;
          this.#saveToken(message.device_token);
        }
        const recovery = this.#onPaired();
        if (announce) {
          this.log.info?.(recovery.wasDown
            ? `RemoteInput relay 已恢复配对（断开 ${formatRelayDuration(recovery.downFor)}，期间重连 ${recovery.attempts + 1} 次）`
            : 'RemoteInput relay 已配对');
        }
    } else if (message.type === 'inject_result') {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    } else if (message.type === 'error') {
      this.log.warn?.('RemoteInput relay 错误', message.code || '', message.message || '');
      if (message.code === 'untrusted' || message.code === 'bad_pair') {
        this.deviceToken = null;
        this.#dropToken();
      }
    }
  }

  async #inject(frame, { waitMs = 8000, ackMs = 9000 } = {}) {
    if (!this.url || !this.macId) throw new Error('未配置 RELAY_URL 或 MAC_ID');
    const deadline = Date.now() + waitMs;
    while (!(this.ws?.readyState === (this.WebSocketImpl.OPEN ?? 1) && this.paired)) {
      if (Date.now() > deadline) throw new Error('RemoteInput relay 未就绪（未配对或连接断开）');
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const requestId = randomUUID();
    const result = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve({ ok: true, unconfirmed: true });
      }, ackMs);
      this.pending.set(requestId, { resolve, reject, timer });
    });
    this.ws.send(JSON.stringify({ ...frame, id: requestId }));
    return result;
  }

  injectText(text, { postprocess = false, waitMs = 8000, ackMs = 9000 } = {}) {
    return this.#inject({ type: 'inject_text', text: String(text), postprocess }, { waitMs, ackMs });
  }

  injectKey(key, { waitMs = 8000, ackMs = 9000 } = {}) {
    return this.#inject({ type: 'inject_key', key: String(key) }, { waitMs, ackMs });
  }

  /** 让电脑端逐项贴进前台窗口。终端里每张约 1.6 秒，回执超时按张数放宽。 */
  pasteItems(items, { waitMs = 8000 } = {}) {
    const list = (items || []).map((item) => ({ path: String(item.path), kind: item.kind === 'image' ? 'image' : 'file' }));
    return this.#inject({ type: 'inject_key', key: buildMacCommand('paste_items', { items: list }) }, {
      waitMs, ackMs: 6000 + list.length * 2500,
    });
  }

  pasteText(text, { waitMs = 8000, ackMs = 9000 } = {}) {
    return this.#inject({ type: 'inject_key', key: buildMacCommand('paste_text', { text: String(text) }) }, { waitMs, ackMs });
  }

  close() {
    this.closed = true;
    this.clearTimeoutFn(this.reconnectTimer);
    this.clearIntervalFn(this.pingTimer);
    try { this.ws?.close(); } catch {}
  }
}

export class DisabledInjector {
  async injectText() { throw new Error('RemoteInput 注入未配置'); }
  async injectKey() { throw new Error('RemoteInput 注入未配置'); }
  async pasteItems() { throw new Error('RemoteInput 注入未配置'); }
  async pasteText() { throw new Error('RemoteInput 注入未配置'); }
  close() {}
}
