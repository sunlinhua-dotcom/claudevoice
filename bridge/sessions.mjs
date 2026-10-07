import { EventEmitter } from 'node:events';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { clip, id } from './utils.mjs';

// 种子项目：只有本仓库自己。其余项目来自 projects.json 和 CC_WORKSPACE_ROOT 下的子目录。
const SEEDS = {
  claudevoice: { path: resolve(import.meta.dirname, '..'), source: 'seed' },
};

const DEFAULT_STATE = {
  version: 2,
  currentProject: 'claudevoice',
  projectSessions: {},
  tasks: {},
  messageToTask: {},
  inputDeliveries: {},
  batchSeq: 0,
  settings: { mode: 'default', model: '', inputMode: 'input' },
  resumeNext: {},
  sessionMenus: {},
};

function cleanName(name) {
  return String(name || '').trim().toLowerCase();
}

export function encodeClaudeProjectPath(projectPath) {
  return resolve(String(projectPath || '')).replace(/[^A-Za-z0-9]/g, '-');
}

function messageText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((item) => item?.type === 'text' && item.text)
    .map((item) => item.text)
    .join(' ');
}

async function readSessionPreview(file, maxBytes = 64 * 1024) {
  let summary = '';
  const stream = createReadStream(file, { encoding: 'utf8', start: 0, end: maxBytes - 1 });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      let value;
      try { value = JSON.parse(line); } catch { continue; }
      const role = value?.message?.role || value?.role || '';
      if (role === 'user' || value?.type === 'user') {
        const text = messageText(value?.message?.content ?? value?.content);
        if (text) return clip(text, 120);
      }
      if (!summary && typeof value?.summary === 'string') summary = value.summary;
    }
  } catch {}
  finally {
    lines.close();
    stream.destroy();
  }
  return clip(summary, 120);
}

export async function discoverDiskSessions(projectPath, {
  limit = 8,
  projectsRoot = join(homedir(), '.claude', 'projects'),
  bridgeSessions = [],
} = {}) {
  const directory = join(projectsRoot, encodeClaudeProjectPath(projectPath));
  let entries;
  try { entries = await readdir(directory, { withFileTypes: true }); } catch { return []; }
  const bridgeIds = new Set(bridgeSessions.map((item) => typeof item === 'string' ? item : item?.sessionId).filter(Boolean));
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.jsonl')) continue;
    const file = join(directory, entry.name);
    try {
      const info = await stat(file);
      files.push({ file, sessionId: entry.name.slice(0, -'.jsonl'.length), mtime: info.mtimeMs });
    } catch {}
  }
  files.sort((left, right) => right.mtime - left.mtime);
  const selected = files.slice(0, Math.max(0, Number(limit) || 0));
  return Promise.all(selected.map(async (item) => ({
    sessionId: item.sessionId,
    mtime: item.mtime,
    preview: await readSessionPreview(item.file),
    source: bridgeIds.has(item.sessionId) ? '飞书' : '网页/桌面',
  })));
}

export function mergeProjectSessions(bridgeSessions = [], diskSessions = []) {
  const merged = new Map();
  for (const item of diskSessions) {
    if (!item?.sessionId) continue;
    merged.set(item.sessionId, { ...item, source: item.source || '网页/桌面' });
  }
  for (const item of bridgeSessions) {
    if (!item?.sessionId) continue;
    merged.set(item.sessionId, {
      ...item,
      mtime: item.updatedAt || item.mtime || 0,
      source: '飞书',
    });
  }
  return [...merged.values()].sort((left, right) => (right.mtime || right.updatedAt || 0) - (left.mtime || left.updatedAt || 0));
}

export class SessionStore extends EventEmitter {
  constructor({ dir = import.meta.dirname, workspaceRoot = process.env.CC_WORKSPACE_ROOT || join(homedir(), 'Projects'), globalLimit = 3 } = {}) {
    super();
    this.dir = dir;
    this.workspaceRoot = workspaceRoot;
    this.projectsFile = join(dir, 'projects.json');
    this.stateFile = join(dir, 'state.json');
    this.globalLimit = globalLimit;
    this.projects = {};
    this.state = structuredClone(DEFAULT_STATE);
    this.running = new Map();
    this.runningProjects = new Set();
    this.queue = [];
    this.executor = null;
    this.saveChain = Promise.resolve();
  }

  async init() {
    await mkdir(this.dir, { recursive: true });
    this.projects = await this.#loadProjects();
    this.state = await this.#loadState();
    if (!this.projects[this.state.currentProject]) this.state.currentProject = Object.keys(this.projects)[0] || 'claudevoice';
    for (const task of Object.values(this.state.tasks)) {
      if (task.status === 'running' || task.status === 'stopping') {
        task.status = 'failed';
        task.error = 'cc-bridge 重启，原 Claude 子进程已丢失';
        task.finishedAt = Date.now();
        task.waitingFor = '';
        task.waitingStartedAt = 0;
      }
      if (task.status === 'queued') this.queue.push(task.id);
    }
    await this.save();
    return this;
  }

  async #loadProjects() {
    let configured = {};
    try { configured = JSON.parse(await readFile(this.projectsFile, 'utf8')); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    const projects = { ...SEEDS };
    for (const [name, value] of Object.entries(configured || {})) {
      const item = typeof value === 'string' ? { path: value } : value;
      if (item?.path) projects[cleanName(name)] = { ...item, path: resolve(item.path), source: item.source || 'config' };
    }
    try {
      for (const entry of await readdir(this.workspaceRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
        const path = join(this.workspaceRoot, entry.name);
        const key = cleanName(entry.name);
        if (!projects[key]) projects[key] = { path, source: 'auto' };
      }
    } catch {}
    const valid = {};
    for (const [name, project] of Object.entries(projects)) {
      try {
        if ((await stat(project.path)).isDirectory()) valid[name] = project;
      } catch {}
    }
    await this.#atomicWrite(this.projectsFile, valid);
    return valid;
  }

  async #loadState() {
    try {
      const value = JSON.parse(await readFile(this.stateFile, 'utf8'));
      const settings = { ...DEFAULT_STATE.settings, ...(value.settings || {}) };
      if ((Number(value.version) || 1) < 2) settings.inputMode = 'input';
      return {
        ...structuredClone(DEFAULT_STATE),
        ...value,
        version: DEFAULT_STATE.version,
        projectSessions: value.projectSessions || {},
        tasks: value.tasks || {},
        messageToTask: value.messageToTask || {},
        inputDeliveries: value.inputDeliveries || {},
        settings,
        resumeNext: value.resumeNext || {},
        sessionMenus: value.sessionMenus || {},
      };
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      return structuredClone(DEFAULT_STATE);
    }
  }

  async #atomicWrite(file, value) {
    await mkdir(dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, file);
  }

  save() {
    this.saveChain = this.saveChain.then(() => this.#atomicWrite(this.stateFile, this.state));
    return this.saveChain;
  }

  listProjects() {
    return Object.entries(this.projects).map(([name, value], index) => ({ index: index + 1, name, ...value }));
  }

  resolveProject(input) {
    const value = String(input || '').trim();
    if (/^\d+$/.test(value)) return this.listProjects()[Number(value) - 1] || null;
    const key = cleanName(value);
    if (this.projects[key]) return { name: key, ...this.projects[key] };
    const exact = this.listProjects().find((p) => p.path === value);
    return exact || null;
  }

  async useProject(input) {
    const project = this.resolveProject(input);
    if (!project) return null;
    this.state.currentProject = project.name;
    await this.save();
    return project;
  }

  currentProject() {
    return this.resolveProject(this.state.currentProject);
  }

  setExecutor(executor) {
    this.executor = executor;
    this.pump();
  }

  async createTask({ project, prompt, messageId, rootId, resumeSessionId = '', mode, model }) {
    const taskId = id('task_');
    const now = Date.now();
    const task = {
      id: taskId,
      number: this.nextTaskNumber(),
      project,
      prompt: String(prompt || ''),
      pendingPrompts: [{ text: String(prompt || ''), messageId, rootId: rootId || messageId }],
      status: 'queued',
      mode: mode || this.state.settings.mode,
      model: model ?? this.state.settings.model,
      sessionId: resumeSessionId || '',
      triggerMessageId: messageId,
      rootId: rootId || messageId,
      taskCardMessageId: '',
      currentTool: '',
      toolHistory: [],
      eventCount: 0,
      costUsd: 0,
      claudeDurationMs: 0,
      startedAt: 0,
      finishedAt: 0,
      createdAt: now,
      updatedAt: now,
      result: '',
      error: '',
      stderrTail: '',
      alwaysAllow: false,
      waitingFor: '',
      waitingStartedAt: 0,
      waitAccumulatedMs: 0,
      round: 0,
    };
    this.state.tasks[taskId] = task;
    this.mapMessage(messageId, taskId);
    if (rootId) this.mapMessage(rootId, taskId);
    this.queue.push(taskId);
    await this.save();
    this.emit('task', task);
    return task;
  }

  nextTaskNumber() {
    return Math.max(0, ...Object.values(this.state.tasks).map((task) => Number(task.number) || 0)) + 1;
  }

  mapMessage(messageId, taskId) {
    if (!messageId) return;
    this.state.messageToTask[messageId] = taskId;
    const keys = Object.keys(this.state.messageToTask);
    if (keys.length > 2000) for (const key of keys.slice(0, keys.length - 1800)) delete this.state.messageToTask[key];
  }

  findTaskByMessage(...ids) {
    for (const messageId of ids.filter(Boolean)) {
      const taskId = this.state.messageToTask[messageId];
      if (taskId && this.state.tasks[taskId]) return this.state.tasks[taskId];
    }
    return null;
  }

  findRecentTask() {
    const tasks = Object.values(this.state.tasks || {});
    const byRecent = (left, right) => (right.updatedAt || right.createdAt || 0) - (left.updatedAt || left.createdAt || 0);
    const running = tasks.filter((task) => task.status === 'running').sort(byRecent)[0];
    if (running) return running;
    const queued = tasks.filter((task) => task.status === 'queued').sort(byRecent)[0];
    if (queued) return queued;
    return tasks.filter((task) => task.status === 'done' && task.sessionId).sort(byRecent)[0] || null;
  }

  getTask(idOrNumber) {
    if (!idOrNumber) return null;
    if (this.state.tasks[idOrNumber]) return this.state.tasks[idOrNumber];
    return Object.values(this.state.tasks).find((task) => String(task.number) === String(idOrNumber)) || null;
  }

  listTasks({ activeOnly = false } = {}) {
    const values = Object.values(this.state.tasks).sort((a, b) => b.createdAt - a.createdAt);
    return activeOnly ? values.filter((task) => ['queued', 'running', 'stopping'].includes(task.status)) : values;
  }

  async addFollowup(taskId, { text, messageId, rootId }) {
    const task = this.getTask(taskId);
    if (!task) return null;
    task.pendingPrompts ||= [];
    task.pendingPrompts.push({ text: String(text), messageId, rootId: rootId || task.rootId });
    task.updatedAt = Date.now();
    this.mapMessage(messageId, task.id);
    if (!['queued', 'running', 'stopping'].includes(task.status)) {
      task.status = 'queued';
      task.error = '';
      task.result = '';
      task.finishedAt = 0;
      this.queue.push(task.id);
    }
    await this.save();
    this.emit('task', task);
    this.pump();
    return task;
  }

  async updateTask(taskId, patch) {
    const task = this.getTask(taskId);
    if (!task) return null;
    Object.assign(task, patch, { updatedAt: Date.now() });
    await this.save();
    this.emit('task', task);
    return task;
  }

  async recordSession(task) {
    if (!task.sessionId) return;
    const list = this.state.projectSessions[task.project] ||= [];
    const previous = list.find((item) => item.sessionId === task.sessionId);
    if (previous) Object.assign(previous, { updatedAt: Date.now(), taskId: task.id, preview: task.prompt.slice(0, 100) });
    else list.unshift({ sessionId: task.sessionId, updatedAt: Date.now(), taskId: task.id, preview: task.prompt.slice(0, 100) });
    list.sort((a, b) => b.updatedAt - a.updatedAt);
    list.splice(20);
    await this.save();
  }

  recentSessions(project = this.state.currentProject) {
    return this.state.projectSessions[project] || [];
  }

  async setSessionMenu(project, sessions) {
    this.state.sessionMenus[project] = sessions.map((item) => item.sessionId).filter(Boolean);
    await this.save();
  }

  async selectResume(project, index = 1) {
    const position = Number(index) - 1;
    const mappedId = this.state.sessionMenus[project]?.[position];
    const session = mappedId
      ? { sessionId: mappedId }
      : this.recentSessions(project)[position] || null;
    if (!session) return null;
    this.state.resumeNext[project] = session.sessionId;
    await this.save();
    return session;
  }

  async consumeResume(project) {
    const sessionId = this.state.resumeNext[project] || '';
    if (sessionId) {
      delete this.state.resumeNext[project];
      await this.save();
    }
    return sessionId;
  }

  async setMode(mode) {
    this.state.settings.mode = mode;
    await this.save();
  }

  async setInputMode(mode) {
    if (!['task', 'input'].includes(mode)) throw new Error(`未知输入模式：${mode}`);
    this.state.settings.inputMode = mode;
    await this.save();
  }

  async createInputDelivery({
    text, messageId, origin = 'text', postprocess = false, stoppedTaskNumber = 0,
    attachments = [], prompt = '', project = '', kind = '',
  }) {
    const now = Date.now();
    const delivery = {
      id: id('inject_'),
      kind: kind || (attachments.length ? 'attachment' : 'text'),
      text: String(text || ''),
      prompt: String(prompt || ''),
      project: String(project || ''),
      attachments: attachments.map((item) => ({
        path: String(item.path || ''), name: String(item.name || ''), size: Number(item.size) || 0,
        mime: String(item.mime || 'application/octet-stream'), resourceType: String(item.resourceType || 'file'),
      })),
      sourceMessageId: messageId || '',
      cardMessageId: '',
      origin,
      postprocess: Boolean(postprocess),
      stoppedTaskNumber: Number(stoppedTaskNumber) || 0,
      status: 'copying',
      relayMode: '',
      relayReason: '',
      createdAt: now,
      updatedAt: now,
    };
    this.state.inputDeliveries[delivery.id] = delivery;
    const values = Object.values(this.state.inputDeliveries).sort((a, b) => b.createdAt - a.createdAt);
    for (const stale of values.slice(200)) delete this.state.inputDeliveries[stale.id];
    await this.save();
    return delivery;
  }

  /** 附件批次号，同步递增；随下一次 save 落盘。 */
  nextBatchNumber() {
    this.state.batchSeq = (Number(this.state.batchSeq) || 0) + 1;
    return this.state.batchSeq;
  }

  getInputDelivery(deliveryId) {
    return this.state.inputDeliveries?.[deliveryId] || null;
  }

  async updateInputDelivery(deliveryId, patch) {
    const delivery = this.getInputDelivery(deliveryId);
    if (!delivery) return null;
    Object.assign(delivery, patch, { updatedAt: Date.now() });
    await this.save();
    return delivery;
  }

  async setModel(model) {
    this.state.settings.model = model;
    await this.save();
  }

  async clearProject(project = this.state.currentProject) {
    this.state.projectSessions[project] = [];
    delete this.state.resumeNext[project];
    delete this.state.sessionMenus[project];
    await this.save();
  }

  async beginTaskWait(taskId, kind) {
    const task = this.getTask(taskId);
    if (!task) return null;
    if (!task.waitingFor) {
      task.waitingFor = kind;
      task.waitingStartedAt = Date.now();
      this.running.get(task.id)?.pauseTimeout?.(kind);
      await this.save();
      this.emit('task', task);
    }
    return task;
  }

  async endTaskWait(taskId, kind) {
    const task = this.getTask(taskId);
    if (!task || task.waitingFor !== kind) return task || null;
    task.waitAccumulatedMs = (task.waitAccumulatedMs || 0) + Math.max(0, Date.now() - (task.waitingStartedAt || Date.now()));
    task.waitingFor = '';
    task.waitingStartedAt = 0;
    this.running.get(task.id)?.resumeTimeout?.(kind);
    await this.save();
    this.emit('task', task);
    return task;
  }

  async stopTask(idOrNumber) {
    const task = idOrNumber ? this.getTask(idOrNumber) : this.listTasks({ activeOnly: true })[0];
    if (!task) return null;
    if (task.status === 'queued') {
      this.queue = this.queue.filter((idValue) => idValue !== task.id);
      task.pendingPrompts = [];
      task.status = 'failed';
      task.error = '由用户停止';
      task.finishedAt = Date.now();
    } else if (task.status === 'running') {
      task.pendingPrompts = [];
      task.status = 'stopping';
      this.running.get(task.id)?.stop?.();
    }
    await this.save();
    this.emit('task', task);
    return task;
  }

  pump() {
    if (!this.executor) return;
    while (this.running.size < this.globalLimit) {
      const index = this.queue.findIndex((taskId) => {
        const task = this.getTask(taskId);
        return task && task.status === 'queued' && !this.runningProjects.has(task.project);
      });
      if (index < 0) return;
      const [taskId] = this.queue.splice(index, 1);
      const task = this.getTask(taskId);
      if (!task) continue;
      task.status = 'running';
      task.startedAt ||= Date.now();
      task.updatedAt = Date.now();
      this.runningProjects.add(task.project);
      const control = { stop: null, pauseTimeout: null, resumeTimeout: null };
      this.running.set(task.id, control);
      this.save().catch(() => {});
      this.emit('task', task);
      Promise.resolve(this.executor(task, control)).catch(async (error) => {
        await this.updateTask(task.id, { status: 'failed', error: String(error?.message || error), finishedAt: Date.now() });
      }).finally(() => {
        this.running.delete(task.id);
        this.runningProjects.delete(task.project);
        this.pump();
      });
    }
  }
}

export async function ensureSeedProjects(file = join(import.meta.dirname, 'projects.json')) {
  if (existsSync(file)) return;
  await writeFile(file, `${JSON.stringify(SEEDS, null, 2)}\n`);
}
