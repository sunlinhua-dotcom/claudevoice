import { clip, formatDuration, safeJson } from './utils.mjs';
import { readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { isImageFile, outputFileName, readOutputFile } from './media.mjs';
import { buildSessionUrl } from './cloudcli.mjs';

const DECISION_RE = /[?？]|是否|还是|要不要|需不需要|需要你|请你确认|请确认|建议|你来定|你决定|你看|选择|二选一|哪一个|哪个|可以吗|对吗|要不/;

export function loadBannerKeys(file = join(import.meta.dirname, 'assets', 'img-keys.json')) {
  try {
    const value = JSON.parse(readFileSync(file, 'utf8'));
    return Object.fromEntries(Object.entries(value.images || {}).flatMap(([kind, item]) => item?.image_key ? [[kind, item.image_key]] : []));
  } catch { return {}; }
}

export function cleanSummary(text, maxLen = 360) {
  const cleaned = String(text || '')
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]*`/g, ' ')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_#>~|]/g, ' ')
    .replace(/^[\s\-•\d.]+/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '';
  const sentences = cleaned.split(/(?<=[。！？!?])|(?<=[.!?])\s+/).map((item) => item.trim()).filter(Boolean);
  if (!sentences.length) return clip(cleaned, maxLen);
  const chinese = sentences.filter((sentence) => /[\u3400-\u9fff]/.test(sentence));
  const ordered = chinese.length ? [...chinese, ...sentences.filter((sentence) => !chinese.includes(sentence))] : sentences;
  let output = '';
  for (const sentence of ordered) {
    if (output && output.length + sentence.length > maxLen) break;
    output += sentence;
  }
  if (!output) output = `${cleaned.slice(0, maxLen).replace(/[，、；\s]+$/, '')}。`;
  const decision = sentences.find((sentence) => DECISION_RE.test(sentence));
  if (decision && !output.includes(decision) && output.length + decision.length <= maxLen + 80) output += decision;
  return output;
}

function button(label, value, type = 'default') {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: label },
    type,
    behaviors: [{ type: 'callback', value }],
  };
}

function dashboardButton(sessionId) {
  const url = buildSessionUrl(sessionId);
  if (!url) return null;
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: '🖥 打开驾驶舱' },
    type: 'default',
    url,
    multi_url: { url, pc_url: url, ios_url: url, android_url: url },
  };
}

function dashboardActions(sessionId) {
  const action = dashboardButton(sessionId);
  return action ? [action] : [];
}

function card({ title, template = 'blue', markdown, actions = [], note = '', bannerKind = '', imageKeys = loadBannerKeys() }) {
  const noteLine = note ? `\n\n---\n${note}` : '';
  const elements = [];
  const imageKey = imageKeys?.[bannerKind];
  if (imageKey) elements.push({
    tag: 'img', img_key: imageKey, preview: true, transparent: false, scale_type: 'fit_horizontal',
    alt: { tag: 'plain_text', content: `${bannerKind} banner` },
  });
  elements.push({ tag: 'markdown', content: `${markdown || ' '}${noteLine}` });
  // 飞书 Card schema 2.0 不支持 note 标签；button 顶层结构已由现有 RemoteVoice 实测验证。
  elements.push(...actions);
  return {
    schema: '2.0',
    config: { wide_screen_mode: true },
    header: { template, title: { tag: 'plain_text', content: title } },
    body: { elements },
  };
}

export function buildTaskCard(task, now = Date.now(), imageKeys = loadBannerKeys()) {
  let status = {
    queued: '⏳ 排队中', running: '🟠 执行中', stopping: '🛑 正在停止',
    done: '✅ 已完成', failed: '❌ 已失败',
  }[task.status] || task.status;
  if (task.waitingFor === 'ask') status = '⏳ 等待你在飞书选择…';
  if (task.waitingFor === 'approval') status = '🔐 等待你在飞书审批…';
  const elapsedFrom = task.startedAt || task.createdAt;
  const elapsedTo = task.finishedAt || now;
  const currentWait = task.waitingStartedAt && !task.finishedAt ? Math.max(0, now - task.waitingStartedAt) : 0;
  const activeElapsed = Math.max(0, elapsedTo - elapsedFrom - (task.waitAccumulatedMs || 0) - currentWait);
  const queueLine = task.pendingPrompts?.length ? `\n**待处理追问：** ${task.pendingPrompts.length}` : '';
  const recentTools = (task.toolHistory || []).slice(-3);
  const tools = recentTools.length
    ? recentTools.map((item, index) => `${index + 1}. **${clip(item.name, 40)}** · ${clip(item.summary, 140)}`).join('\n')
    : (task.currentTool ? clip(task.currentTool, 180) : '等待 Claude 事件');
  const metrics = [
    task.claudeDurationMs ? `**Claude 耗时：** ${formatDuration(task.claudeDurationMs).replace(/\s+/g, '')}` : '',
    task.costUsd ? `**成本：** $${Number(task.costUsd).toFixed(4)}` : '',
  ].filter(Boolean).join('\n');
  const errorLine = task.status === 'failed' && (task.error || task.stderrTail)
    ? `\n**失败原因：** ${clip(task.error || task.stderrTail, 600)}`
    : '';
  return card({
    title: `🧭 #${task.number} · ${task.project}`,
    template: task.status === 'done' ? 'green' : ['failed', 'stopping'].includes(task.status) ? 'red' : ['queued', 'waiting'].includes(task.status) ? 'orange' : 'blue',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 240)}\n**状态：** ${status}${errorLine}\n**最近工具：**\n${tools}\n**耗时：** ${formatDuration(activeElapsed)}${task.waitingFor ? '（等待不计时）' : ''}\n**事件数：** ${task.eventCount || 0}${queueLine}${metrics ? `\n${metrics}` : ''}`,
    note: `模式 ${task.mode || 'default'} · 模型 ${task.model || '默认'} · 第 ${task.round || 0} 轮`,
    actions: dashboardActions(task.sessionId),
    bannerKind: task.status === 'done' ? 'done' : task.status === 'failed' ? 'failed' : task.status === 'queued' ? 'queued' : 'running',
    imageKeys,
  });
}

export function buildApprovalCard({ task, rid, toolName, input }, imageKeys = loadBannerKeys()) {
  const summary = clip(JSON.stringify(input ?? {}, null, 0), 420) || '{}';
  return card({
    title: `🔐 #${task.number} · 需要授权`,
    template: 'red',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 180)}\n**工具：** ${toolName || '未知工具'}\n**参数摘要：**\n${summary}`,
    actions: [
      button('允许', { ns: 'cc', act: 'approve', rid }, 'primary'),
      button('拒绝', { ns: 'cc', act: 'deny', rid }, 'danger'),
      button('本任务总是允许', { ns: 'cc', act: 'always', rid }),
      ...dashboardActions(task.sessionId),
    ],
    note: '10 分钟未处理将自动拒绝',
    bannerKind: 'permission', imageKeys,
  });
}

export function buildApprovalTerminalCard({ task, status, detail }, imageKeys = loadBannerKeys()) {
  const allowed = status === 'allowed';
  return card({
    title: `${allowed ? '✅ 已允许' : '⛔ 已拒绝'} · #${task.number}`,
    template: allowed ? 'green' : 'red',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 180)}\n**处理结果：** ${allowed ? '✅ 已允许' : '⛔ 已拒绝'}\n${detail || ''}`,
    bannerKind: 'permission', imageKeys,
  });
}

export function buildAskUserCard({ task, rid, question, options, allowCustom = true }, imageKeys = loadBannerKeys()) {
  const normalized = (Array.isArray(options) ? options : []).map((item) => String(item).trim()).filter(Boolean);
  if (normalized.length < 2 || normalized.length > 6) throw new Error('ask_user 选项必须为 2-6 个');
  return card({
    title: `🧭 #${task.number} · 需要你拍板`,
    template: 'orange',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 180)}\n\n**问题：** ${clip(question, 600)}`,
    actions: normalized.map((option, index) => button(option, { ns: 'cc.ask', act: 'select', rid, index }, index === 0 ? 'primary' : 'default')),
    note: allowCustom ? '也可直接回复文字作为自定义答案 · 15 分钟未回应将由 Claude 按最佳判断继续' : '15 分钟未回应将由 Claude 按最佳判断继续',
    bannerKind: 'permission', imageKeys,
  });
}

export function buildAskUserTerminalCard({ task, question, answer, timedOut = false }, imageKeys = loadBannerKeys()) {
  return card({
    title: `${timedOut ? '⏱️ 已超时' : '✅ 已选择'} · #${task.number}`,
    template: timedOut ? 'grey' : 'green',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 180)}\n**问题：** ${clip(question, 600)}\n**答案：** ${clip(answer, 600)}`,
    bannerKind: 'permission', imageKeys,
  });
}

export function buildCompleteCard(task, imageKeys = loadBannerKeys()) {
  const summary = cleanSummary(task.result, 420) || 'Claude 已结束本轮任务，但没有返回可展示的文字结果。';
  return card({
    title: `✅ #${task.number} · ${task.project} · 已完成`,
    template: 'green',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 240)}\n\n**结果摘要**\n${summary}\n\n**会话：** ${task.sessionId ? task.sessionId.slice(0, 8) + '…' : '未捕获'}`,
    actions: [
      button('继续', { ns: 'cc', act: 'continue', tid: task.id }, 'primary'),
      button('重试', { ns: 'cc', act: 'retry', tid: task.id }),
      ...dashboardActions(task.sessionId),
    ],
    note: `耗时 ${formatDuration((task.finishedAt || Date.now()) - (task.startedAt || task.createdAt))} · ${task.eventCount || 0} 个事件`,
    bannerKind: 'done', imageKeys,
  });
}

export function buildFailureCard(task, imageKeys = loadBannerKeys()) {
  const detail = clip(task.error || task.stderrTail || '未知错误', 900);
  return card({
    title: `❌ #${task.number} · ${task.project} · 失败`,
    template: 'red',
    markdown: `**项目：** ${task.project}\n**任务：** #${task.number}\n**触发消息：** ${clip(task.prompt || '（无）', 240)}\n\n**失败原因**\n${detail}\n\n**stderr 尾部**\n${clip(task.stderrTail || '（空）', 1000)}`,
    actions: [
      button('重试', { ns: 'cc', act: 'retry', tid: task.id }, 'primary'),
      ...dashboardActions(task.sessionId),
    ],
    bannerKind: 'failed', imageKeys,
  });
}

export function buildNoticeCard({ kind, title, markdown }, imageKeys = loadBannerKeys()) {
  const template = kind === 'voice' ? 'purple' : 'blue';
  return card({ title, template, markdown, bannerKind: kind, imageKeys });
}

function inputModeButton(inputMode, reference = {}) {
  const target = inputMode === 'input' ? 'task' : 'input';
  return button(target === 'input' ? '⌨️ 切到输入模式' : '🤖 切到任务模式', {
    ns: 'cc.inject.mode', mode: target, ...reference,
  });
}

export function buildInputReceiptCard({ delivery, inputMode = 'input' }, imageKeys = loadBannerKeys()) {
  const status = {
    copying: { title: '📋 正在复制到剪贴板', template: 'blue', line: '正在写入电脑剪贴板…' },
    injecting: { title: '⌨️ 已复制，正在注入', template: 'blue', line: '剪贴板已就绪，正在等待电脑端真实回执…' },
    typed: { title: '✅ 已注入电脑输入框', template: 'green', line: '已注入：App 已确认文字打进当前焦点窗口；剪贴板也已同步。' },
    clipboard: { title: '📋 已复制到剪贴板', template: 'blue', line: '自动注入未完成，文字仍已安全保存在电脑剪贴板。' },
    unconfirmed: { title: '📋 已复制，注入待确认', template: 'orange', line: '注入帧已发出但未收到 App 回执；剪贴板已就绪。' },
    failed: { title: '⚠️ 剪贴板写入失败', template: 'red', line: '本机 pbcopy 未成功，未继续自动注入。' },
  }[delivery?.status] || { title: '📋 输入回执', template: 'blue', line: '正在处理。' };
  const stopped = delivery?.stoppedTaskNumber ? `\n\n已停止 Claude 任务 #${delivery.stoppedTaskNumber} 并改为电脑输入。` : '';
  const reason = delivery?.relayReason ? `\n\n**注入说明：** ${clip(delivery.relayReason, 300)}` : '';
  return card({
    title: status.title,
    template: status.template,
    markdown: `**识别 / 输入文本**\n${clip(delivery?.text || '', 1800)}\n\n**状态：** ${status.line}${stopped}${reason}`,
    actions: [
      button('📋 粘贴到光标处', { ns: 'cc.inject.paste', did: delivery.id }, 'primary'),
      button('⏎ 回车', { ns: 'cc.inject.enter', did: delivery.id }),
      button('🤖 转给 Claude', { ns: 'cc.inject.claude', did: delivery.id }),
      inputModeButton(inputMode, { did: delivery.id }),
    ],
    note: `当前：${inputMode === 'input' ? '输入模式' : '任务模式'} · 剪贴板由 bridge 本机 pbcopy 写入`,
    bannerKind: 'voice', imageKeys,
  });
}

export function buildVoiceConfirmationCard({ text, task, inputMode = 'task' }, imageKeys = loadBannerKeys()) {
  return card({
    title: `🎤 #${task?.number || '—'} · ${task?.project || '未知项目'} · 语音任务`,
    template: 'purple',
    markdown: `**项目：** ${task?.project || '未知项目'}\n**任务：** #${task?.number || '—'}\n**触发消息：** ${clip(task?.prompt || text || '（无）', 240)}\n\n**识别文本**\n${clip(text, 1200)}\n\n已创建任务 #${task?.number || '—'}。如果本意是输入电脑，可立即改道。`,
    actions: [
      button('⌨️ 改为输入到电脑', { ns: 'cc.inject.convert', tid: task.id }, 'primary'),
      inputModeButton(inputMode, { tid: task.id }),
    ],
    note: `当前：${inputMode === 'input' ? '输入模式' : '任务模式'}`,
    bannerKind: 'voice', imageKeys,
  });
}

function formatBytes(size) {
  const value = Math.max(0, Number(size) || 0);
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${Number((value / 1024).toFixed(value < 10 * 1024 ? 1 : 0))} KB`;
  return `${Number((value / (1024 * 1024)).toFixed(value < 10 * 1024 * 1024 ? 1 : 0))} MB`;
}

export function buildAttachmentReceiptCard({ delivery }, imageKeys = loadBannerKeys()) {
  const status = {
    downloading: { title: '⏬ 附件下载中…', template: 'blue', text: '⏬ 下载中…' },
    clipboard: { title: '✅ 附件已进剪贴板', template: 'green', text: '✅ 已进剪贴板' },
    failed: { title: '⚠️ 附件处理失败', template: 'red', text: '❌ 未进入剪贴板' },
  }[delivery?.status] || { title: '📎 附件处理中', template: 'blue', text: '正在处理…' };
  const files = (delivery?.attachments || []).map((item, index) => [
    `${index + 1}. **${clip(item.name || '未命名附件', 180)}**`,
    `   ${formatBytes(item.size)} · ${clip(item.mime || 'application/octet-stream', 120)}`,
  ].join('\n')).join('\n') || '（等待资源信息）';
  const reason = delivery?.error || delivery?.relayReason;
  const fallback = delivery?.clipboardFallback ? '\n\n图片数据写入失败，已安全退回“文件引用”剪贴板。' : '';
  const actions = delivery?.status === 'clipboard' && delivery?.clipboardVerified ? [
    button('📋 粘贴到前台窗口', { ns: 'cc.attachment.paste', did: delivery.id }, 'primary'),
    button('🤖 转给 Claude', { ns: 'cc.attachment.claude', did: delivery.id }),
  ] : [];
  return card({
    title: status.title,
    template: status.template,
    markdown: `${delivery?.project ? `**项目：** ${delivery.project}\n` : ''}**附件**\n${files}\n\n**状态：** ${status.text}${reason ? `\n**原因：** ${clip(reason, 600)}` : ''}${fallback}`,
    actions,
    note: delivery?.clipboardInfo ? `clipboard info：${clip(delivery.clipboardInfo, 300)}` : '附件保存在 bridge 受控媒体目录',
    bannerKind: delivery?.status === 'failed' ? 'failed' : 'voice', imageKeys,
  });
}

function assertApi(response, operation) {
  if (response?.code != null && response.code !== 0) throw new Error(`${operation}失败 ${response.code}: ${response.msg || 'unknown'}`);
  return response;
}

export class CardService {
  constructor({ client, ownerId = '', throttleMs = 2500, log = console }) {
    this.client = client;
    this.ownerId = ownerId;
    this.throttleMs = Math.max(2500, throttleMs);
    this.log = log;
    this.updates = new Map();
  }

  async replyText(messageId, text) {
    void messageId;
    return this.sendText(String(text));
  }

  async replyCard(messageId, value) {
    void messageId;
    return this.sendDirect(this.ownerId, value);
  }

  replyNotice(messageId, notice) {
    return this.replyCard(messageId, buildNoticeCard(notice));
  }

  sendInputReceipt(delivery, inputMode) {
    return this.sendDirect(this.ownerId, buildInputReceiptCard({ delivery, inputMode }));
  }

  patchInputReceipt(messageId, delivery, inputMode) {
    return this.patchCard(messageId, buildInputReceiptCard({ delivery, inputMode }));
  }

  sendAttachmentReceipt(delivery) {
    return this.sendDirect(this.ownerId, buildAttachmentReceiptCard({ delivery }));
  }

  patchAttachmentReceipt(messageId, delivery) {
    return this.patchCard(messageId, buildAttachmentReceiptCard({ delivery }));
  }

  sendVoiceConfirmation({ text, task, inputMode }) {
    return this.sendDirect(this.ownerId, buildVoiceConfirmationCard({ text, task, inputMode }));
  }

  async createTaskCard(task) {
    const messageId = await this.sendDirect(this.ownerId, buildTaskCard(task));
    this.updates.set(task.id, { messageId, lastSentAt: Date.now(), lastJson: JSON.stringify(buildTaskCard(task)), timer: null, pending: null });
    return messageId;
  }

  updateTaskCard(task) {
    if (!task.taskCardMessageId) return;
    const value = buildTaskCard(task);
    const json = JSON.stringify(value);
    const entry = this.updates.get(task.id) || { messageId: task.taskCardMessageId, lastSentAt: 0, lastJson: '', timer: null, pending: null };
    entry.messageId = task.taskCardMessageId;
    if (json === entry.lastJson || json === entry.pending) return;
    entry.pending = json;
    this.updates.set(task.id, entry);
    if (entry.sending) return;
    const wait = Math.max(0, this.throttleMs - (Date.now() - entry.lastSentAt));
    if (entry.timer) return;
    entry.timer = setTimeout(async () => {
      entry.timer = null;
      const pending = entry.pending;
      entry.pending = null;
      if (!pending || pending === entry.lastJson) return;
      entry.sending = true;
      try {
        const response = await this.client.im.message.patch({
          path: { message_id: entry.messageId },
          data: { content: pending },
        });
        assertApi(response, '任务卡更新');
        entry.lastJson = pending;
        entry.lastSentAt = Date.now();
      } catch (error) {
        this.log.warn?.('任务卡 PATCH 失败', error.message);
      }
      entry.sending = false;
      const latest = entry.pending;
      entry.pending = null;
      if (latest && latest !== entry.lastJson) this.updateTaskCard(task);
    }, wait);
    entry.timer.unref?.();
  }

  sendApproval(task, request) {
    return this.sendDirect(this.ownerId, buildApprovalCard({ task, ...request }));
  }

  sendAskUser(task, request) {
    return this.sendDirect(this.ownerId, buildAskUserCard({ task, ...request }));
  }

  patchApproval(messageId, result) {
    return this.patchCard(messageId, buildApprovalTerminalCard({ task: result.task || result.pendingTask, ...result }));
  }

  patchAskUser(messageId, result) {
    return this.patchCard(messageId, buildAskUserTerminalCard({ task: result.task || result.pendingTask, ...result }));
  }

  sendComplete(task) {
    return this.sendDirect(this.ownerId, buildCompleteCard(task));
  }

  sendFailure(task) {
    return this.sendDirect(this.ownerId, buildFailureCard(task));
  }

  async sendArtifacts(task, paths) {
    const sent = [];
    for (const path of (paths || []).slice(0, 3)) {
      const size = statSync(path).size;
      if (isImageFile(path)) {
        if (size > 10 * 1024 * 1024) {
          this.log.warn?.('跳过超过 10MB 的图片产物', outputFileName(path));
          continue;
        }
        const upload = assertApi(await this.client.im.image.create({
          data: { image_type: 'message', image: readOutputFile(path) },
        }), '图片上传');
        const imageKey = upload?.image_key || upload?.data?.image_key;
        if (!imageKey) throw new Error('图片上传未返回 image_key');
        const messageId = await this.#sendArtifact('image', { image_key: imageKey });
        sent.push({ path, type: 'image', messageId });
        continue;
      }
      if (size > 20 * 1024 * 1024) {
        this.log.warn?.('跳过超过 20MB 的文件产物', outputFileName(path));
        continue;
      }
      const extension = extname(path).toLowerCase();
      const fileType = ({ '.pdf': 'pdf', '.doc': 'doc', '.docx': 'doc', '.xls': 'xls', '.xlsx': 'xls', '.ppt': 'ppt', '.pptx': 'ppt', '.mp4': 'mp4', '.opus': 'opus' })[extension] || 'stream';
      const upload = assertApi(await this.client.im.file.create({
        data: { file_type: fileType, file_name: outputFileName(path), file: readOutputFile(path) },
      }), '文件上传');
      const fileKey = upload?.file_key || upload?.data?.file_key;
      if (!fileKey) throw new Error('文件上传未返回 file_key');
      const messageId = await this.#sendArtifact('file', { file_key: fileKey });
      sent.push({ path, type: 'file', messageId });
    }
    return sent;
  }

  #sendArtifact(msgType, content) {
    return this.sendMessage(this.ownerId, msgType, content, '产物发送');
  }

  async sendDirect(openId, value) {
    return this.sendMessage(openId, 'interactive', value, '主动发卡');
  }

  sendText(text) {
    return this.sendMessage(this.ownerId, 'text', { text: String(text) }, '文字发送');
  }

  async sendMessage(openId, msgType, content, operation = '消息发送') {
    const response = await this.client.im.message.create({
      params: { receive_id_type: 'open_id' },
      data: { receive_id: openId, msg_type: msgType, content: JSON.stringify(content) },
    });
    return assertApi(response, operation)?.data?.message_id || '';
  }

  async patchCard(messageId, value) {
    const response = await this.client.im.message.patch({
      path: { message_id: messageId },
      data: { content: JSON.stringify(value) },
    });
    assertApi(response, '卡片更新');
    return messageId;
  }
}

export function parseCardActionValue(data) {
  return safeJson(data?.action?.value, data?.action?.value || {});
}
