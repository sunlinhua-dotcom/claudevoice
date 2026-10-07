/**
 * state.mjs — wxbridge 自己的持久状态。
 *
 * 刻意跟 OpenClaw 的状态目录分开：同一个 bot token 只能有一个长轮询消费者，
 * 两边共用同一份 sync buf 会互相吞消息。
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

const DEFAULT_DIR = process.env.WXBRIDGE_STATE_DIR || join(homedir(), '.wxbridge');
const SEEN_LIMIT = 500;

const EMPTY = {
  syncBuf: '',
  contextTokens: {},   // userId -> context_token，回消息必须原样带回
  aliases: {},         // 你教过的关键词 -> 项目名
  sticky: null,        // { project, at } 最近一次用过的项目
  lastBatch: null,     // 最近一次归档，供「改到 X」回溯改判
  pending: null,       // 看着像在跟 bot 说话、暂缓归档的那条，等一句「归档」
  seen: [],            // 已处理过的 message_id，防重
};

export class State {
  constructor({ dir = DEFAULT_DIR } = {}) {
    this.dir = dir;
    this.file = join(dir, 'state.json');
    this.data = { ...EMPTY };
    this.writing = null;
  }

  async load() {
    await mkdir(this.dir, { recursive: true, mode: 0o700 });
    try {
      this.data = { ...EMPTY, ...JSON.parse(await readFile(this.file, 'utf-8')) };
    } catch {
      this.data = { ...EMPTY };
    }
    return this.data;
  }

  /** 原子写：先落临时文件再 rename，避免进程被杀时留下半截 JSON。 */
  async save() {
    const temp = `${this.file}.tmp`;
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    await writeFile(temp, JSON.stringify(this.data, null, 2), { mode: 0o600 });
    await rename(temp, this.file);
  }

  get syncBuf() { return this.data.syncBuf || ''; }
  async setSyncBuf(buf) { this.data.syncBuf = buf || ''; await this.save(); }

  contextToken(userId) { return this.data.contextTokens?.[userId] || ''; }
  async setContextToken(userId, token) {
    if (!userId || !token) return;
    this.data.contextTokens = { ...this.data.contextTokens, [userId]: token };
    await this.save();
  }

  get aliases() { return this.data.aliases || {}; }
  async learnAlias(alias, project) {
    const key = String(alias || '').trim();
    if (key.length < 2 || !project) return false;
    this.data.aliases = { ...this.data.aliases, [key]: project };
    await this.save();
    return true;
  }
  async forgetAlias(alias) {
    const key = String(alias || '').trim();
    if (!this.data.aliases?.[key]) return false;
    const next = { ...this.data.aliases };
    delete next[key];
    this.data.aliases = next;
    await this.save();
    return true;
  }

  get sticky() { return this.data.sticky; }
  async setSticky(project) {
    this.data.sticky = project ? { project, at: Date.now() } : null;
    await this.save();
  }

  get lastBatch() { return this.data.lastBatch; }
  async setLastBatch(batch) { this.data.lastBatch = batch || null; await this.save(); }

  get pending() { return this.data.pending; }
  async setPending(pending) { this.data.pending = pending || null; await this.save(); }

  seenBefore(id) { return Boolean(id) && (this.data.seen || []).includes(id); }
  async markSeen(id) {
    if (!id) return;
    const seen = [...(this.data.seen || []), id];
    this.data.seen = seen.slice(-SEEN_LIMIT);
    await this.save();
  }
}
