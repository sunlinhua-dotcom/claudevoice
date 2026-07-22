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

export class RelayInjector {
  constructor({ url, macId, name = 'Claude 飞书指挥台', dir = import.meta.dirname, log = console, autoConnect = true }) {
    this.url = url;
    this.macId = macId;
    this.name = name;
    this.log = log;
    this.tokenFile = join(dir, `.device_token.${String(macId || 'unknown').replace(/[^A-Za-z0-9_.-]/g, '_')}`);
    this.deviceToken = this.#loadToken();
    this.ws = null;
    this.paired = false;
    this.closed = false;
    this.lastSeen = 0;
    this.reconnectTimer = null;
    this.pingTimer = null;
    this.pending = new Map();
    if (autoConnect && url && macId) this.connect();
  }

  #loadToken() { try { return readFileSync(this.tokenFile, 'utf8').trim() || null; } catch { return null; } }
  #saveToken(value) { try { writeFileSync(this.tokenFile, value, { mode: 0o600 }); } catch (error) { this.log.warn?.('device_token 保存失败', error.message); } }
  #dropToken() { try { unlinkSync(this.tokenFile); } catch {} }

  connect() {
    if (this.closed || !this.url) return;
    clearTimeout(this.reconnectTimer);
    this.log.info?.('RemoteVoice relay 连接中');
    const ws = new WebSocket(this.url);
    this.ws = ws;
    this.paired = false;
    this.lastSeen = Date.now();
    ws.on('open', () => {
      const hello = { type: 'hello', role: 'phone', macId: this.macId, name: this.name };
      if (this.deviceToken) hello.deviceToken = this.deviceToken;
      ws.send(JSON.stringify(hello));
    });
    ws.on('message', (buffer) => {
      this.lastSeen = Date.now();
      let message;
      try { message = JSON.parse(buffer.toString()); } catch { return; }
      this.handleMessage(message);
    });
    ws.on('error', (error) => this.log.warn?.('RemoteVoice relay 连接异常', error.message));
    ws.on('close', () => {
      this.paired = false;
      clearInterval(this.pingTimer);
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new Error('RemoteVoice relay disconnected'));
      }
      this.pending.clear();
      if (!this.closed) {
        this.log.warn?.('RemoteVoice relay 已断开，3 秒后重连');
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    });
    clearInterval(this.pingTimer);
    this.pingTimer = setInterval(() => {
      if (ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - this.lastSeen > 70_000) {
        this.log.warn?.('RemoteVoice relay 心跳超时，主动重连');
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
        if (announce) this.log.info?.('RemoteVoice relay 已配对');
    } else if (message.type === 'inject_result') {
      const pending = this.pending.get(message.id);
      if (pending) {
        clearTimeout(pending.timer);
        this.pending.delete(message.id);
        pending.resolve(message);
      }
    } else if (message.type === 'error') {
      this.log.warn?.('RemoteVoice relay 错误', message.code || '', message.message || '');
      if (message.code === 'untrusted' || message.code === 'bad_pair') {
        this.deviceToken = null;
        this.#dropToken();
      }
    }
  }

  async #inject(frame, { waitMs = 8000, ackMs = 9000 } = {}) {
    if (!this.url || !this.macId) throw new Error('未配置 RELAY_URL 或 MAC_ID');
    const deadline = Date.now() + waitMs;
    while (!(this.ws?.readyState === WebSocket.OPEN && this.paired)) {
      if (Date.now() > deadline) throw new Error('RemoteVoice relay 未就绪（未配对或连接断开）');
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

  close() {
    this.closed = true;
    clearTimeout(this.reconnectTimer);
    clearInterval(this.pingTimer);
    try { this.ws?.close(); } catch {}
  }
}

export class DisabledInjector {
  async injectText() { throw new Error('RemoteVoice 注入未配置'); }
  async injectKey() { throw new Error('RemoteVoice 注入未配置'); }
  close() {}
}
