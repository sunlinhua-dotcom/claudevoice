#!/usr/bin/env node
import * as lark from '@larksuiteoapi/node-sdk';
import { randomBytes } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { ApprovalServer } from './approval-server.mjs';
import { CardService } from './cards.mjs';
import { describeRelayFailure, DisabledInjector, readMacPasteResult, RelayInjector } from './inject.mjs';
import { createObservedDispatcher, createSdkLogger, LarkConnectionManager } from './lark-connection.mjs';
import { extractOutputFiles, MediaStore, parseAttachmentMessage } from './media.mjs';
import { createCardActionHandler, createMessageHandler, formatPingStatus } from './router.mjs';
import { ClaudeRunner } from './runner.mjs';
import { discoverDiskSessions, mergeProjectSessions, SessionStore } from './sessions.mjs';
import { checkFfmpeg, transcribeLarkAudio } from './stt.mjs';
import { clip, createLogger, loadEnvFile, redact } from './utils.mjs';
import { BridgeEventClient } from './worker-events.mjs';
import {
  buildSessionUrl, formatRelativeTime, normalizeWebUrl, probeCloudCli,
} from './cloudcli.mjs';

const BRIGHT_OPEN_ID = ''; // owner 的飞书 open_id 从 .env 的 LARK_OPEN_ID 注入

const IMAGE_FILE = /\.(png|jpe?g|gif|webp|heic|heif|tiff?|bmp)$/i;

/** 图片按图片数据贴（进对话就是一张图），其余按文件引用贴。 */
export function attachmentKind(item) {
  return String(item?.mime || '').startsWith('image/') || IMAGE_FILE.test(String(item?.path || item?.name || '')) ? 'image' : 'file';
}

export class BridgeController {
  constructor({
    store, runner, cards, approval, injector = new DisabledInjector(),
    media = null, events = null, batchIdleMs = 4000, submitWindowMs = 10 * 60_000,
    connectionHealth = null, log = console, discoverSessions = discoverDiskSessions,
    cloudCliProbe = probeCloudCli, now = Date.now, webUrl = normalizeWebUrl(),
  }) {
    this.store = store;
    this.runner = runner;
    this.cards = cards;
    this.approval = approval;
    this.injector = injector;
    this.media = media;
    // 飞书多选图片发出来是一张一条消息：停 batchIdleMs 没有新的就封成一批，一起贴进电脑。
    this.batchIdleMs = batchIdleMs;
    // 贴进去还没发出的批次，在这段时间内收到的下一句话就当它的指令。
    this.submitWindowMs = submitWindowMs;
    this.collectingBatch = null;
    this.localBatchSeq = 0;
    this.cardChains = new Map();
    this.events = events;
    this.connectionHealth = connectionHealth;
    this.log = log;
    this.discoverSessions = discoverSessions;
    this.cloudCliProbe = cloudCliProbe;
    this.now = now;
    this.webUrl = webUrl;
  }

  start() {
    this.store.setExecutor((task, control) => this.executeTask(task, control));
  }

  async handleInput(text, { message, origin = 'text', postprocess = false, stoppedTask = null } = {}) {
    // 刚贴进电脑、还没发出去的附件批次：这句话就是给它们的指令，接在附件后面打进去再回车。
    const pendingBatch = stoppedTask ? null : this.findPendingBatch();
    if (pendingBatch) return this.submitBatch(pendingBatch, text, { postprocess });
    const delivery = await this.store.createInputDelivery({
      text,
      messageId: message?.message_id || '',
      origin,
      postprocess,
      stoppedTaskNumber: stoppedTask?.number || 0,
    });
    // 剪贴板由电脑端 ClaudeVoice 写：cc-bridge 是 PM2 在后台拉起的，没有桌面会话，本机 pbcopy 必败。
    await this.store.updateInputDelivery(delivery.id, { status: 'injecting' });
    let cardMessageId = '';
    try {
      cardMessageId = await this.cards.sendInputReceipt(delivery, this.store.state.settings.inputMode);
      await this.store.updateInputDelivery(delivery.id, { cardMessageId });
    } catch (error) {
      this.log.error?.('输入回执卡发送失败（不影响注入）', error.message);
    }
    let patch;
    try {
      const result = await this.injector.injectText(delivery.text, { postprocess });
      if (result?.ok && result?.mode === 'type') patch = { status: 'typed', relayMode: 'type', relayReason: '' };
      else if (result?.ok && result?.mode === 'clipboard') patch = { status: 'clipboard', relayMode: 'clipboard', relayReason: 'App 未检测到合适的输入焦点' };
      else if (result?.ok && result?.unconfirmed) patch = { status: 'unconfirmed', relayMode: '', relayReason: 'App 回执超时' };
      else if (result?.ok) patch = { status: 'typed', relayMode: result?.mode || 'delivered', relayReason: '' };
      else patch = { status: 'failed', relayMode: result?.mode || '', relayReason: describeRelayFailure(result) };
    } catch (error) {
      patch = { status: 'failed', relayMode: '', relayReason: error.message };
    }
    await this.store.updateInputDelivery(delivery.id, patch);
    if (cardMessageId) {
      try {
        await this.cards.patchInputReceipt(cardMessageId, delivery, this.store.state.settings.inputMode);
      } catch (error) { this.log.warn?.('输入回执卡 PATCH 失败', error.message); }
    }
    return delivery;
  }

  async handleAttachment(message) {
    const referencedTask = this.store.findTaskByMessage?.(message?.parent_id, message?.root_id);
    const project = referencedTask
      ? this.store.resolveProject?.(referencedTask.project)
      : this.store.currentProject?.();
    const projectName = project?.name || referencedTask?.project || this.store.state?.currentProject || '';
    const projectPath = project?.path || this.store.projects?.[projectName]?.path;
    const batch = this.openBatch(projectName);
    batch.inflight += 1;
    clearTimeout(batch.timer);
    batch.sourceMessageIds.push(message.message_id);
    this.refreshBatch(batch);
    const parsed = parseAttachmentMessage(message);
    try {
      const prepared = await this.media.prepareMediaMessage(message, {
        projectPath,
        onLargeDownload: async (meta) => {
          batch.largeDownload = meta;
          // 等卡片先显示「正在下载」再开始下，大文件要好几秒，用户得知道它在动。
          await this.refreshBatch(batch);
        },
      });
      if (!prepared.attachments?.length) throw new Error('消息中没有找到可下载的附件资源键');
      batch.attachments.push(...prepared.attachments.map((item) => ({ ...item, kind: attachmentKind(item) })));
      if (prepared.prompt) batch.prompts.push(prepared.prompt);
    } catch (error) {
      this.log.warn?.('附件下载失败', error.message);
      const names = parsed.attachments.map((item) => item.name || item.resourceType).filter(Boolean).join('、') || '附件';
      batch.errors.push(`${names}：${error.message || '未知错误'}`);
    } finally {
      batch.inflight -= 1;
      batch.largeDownload = null;
    }
    await this.refreshBatch(batch);
    this.armBatchSeal(batch);
    return batch.ready;
  }

  /** 正在收集的批次；上一批已封就开新的。批次号同步分配，并发到达的消息不会各开一批。 */
  openBatch(projectName) {
    if (this.collectingBatch && !this.collectingBatch.sealed) return this.collectingBatch;
    const batch = {
      number: this.store.nextBatchNumber?.() ?? ++this.localBatchSeq,
      project: projectName, inflight: 0, timer: null, sealed: false, sealRequested: false,
      attachments: [], prompts: [], errors: [], sourceMessageIds: [], largeDownload: null,
    };
    batch.done = new Promise((resolve) => { batch.resolveDone = resolve; });
    batch.ready = this.store.createInputDelivery({
      text: '', messageId: '', origin: 'attachment', project: projectName, kind: 'attachment',
    }).then((delivery) => this.store.updateInputDelivery(delivery.id, { status: 'collecting', batchNumber: batch.number })
      .then((updated) => updated || delivery));
    this.collectingBatch = batch;
    return batch;
  }

  /** 把内存里的批次写回投递记录，再刷新卡片。 */
  async refreshBatch(batch) {
    const delivery = await batch.ready;
    await this.store.updateInputDelivery(delivery.id, {
      attachments: batch.attachments,
      prompt: batch.prompts.join('\n\n'),
      errors: batch.errors,
      inflight: batch.inflight,
      largeDownload: batch.largeDownload,
      sourceMessageId: batch.sourceMessageIds[0] || '',
      sourceMessageIds: batch.sourceMessageIds,
    });
    return this.refreshAttachmentCard(delivery);
  }

  armBatchSeal(batch) {
    clearTimeout(batch.timer);
    if (batch.sealed || batch.inflight > 0) return;
    if (batch.sealRequested) {
      this.sealBatch(batch);
      return;
    }
    batch.timer = setTimeout(() => this.sealBatch(batch), this.batchIdleMs);
    batch.timer.unref?.();
  }

  sealBatch(batch) {
    if (batch.sealed) return batch.done;
    if (batch.inflight > 0) {
      batch.sealRequested = true;
      return batch.done;
    }
    clearTimeout(batch.timer);
    batch.sealed = true;
    if (this.collectingBatch === batch) this.collectingBatch = null;
    batch.ready
      .then((delivery) => this.pasteDelivery(delivery))
      .catch((error) => this.log.error?.('附件批次粘贴失败', error.message))
      .then(batch.resolveDone);
    return batch.done;
  }

  /** 「现在就贴」按钮：不等攒批计时，下载完就贴。 */
  async flushAttachmentBatch(deliveryId = '') {
    const batch = this.collectingBatch;
    if (!batch) return null;
    const delivery = await batch.ready;
    if (deliveryId && delivery.id !== deliveryId) return null;
    return this.sealBatch(batch);
  }

  /** 让电脑端逐个贴进前台窗口；封批与「重新粘贴」都走这里。 */
  async pasteDelivery(delivery) {
    const items = (delivery.attachments || []).filter((item) => item.path);
    if (!items.length) {
      await this.store.updateInputDelivery(delivery.id, {
        status: 'failed', pendingSubmit: false,
        error: delivery.errors?.length ? '这一批附件都没下载成功' : '这一批没有可贴的附件',
      });
      await this.refreshAttachmentCard(delivery);
      return delivery;
    }
    await this.store.updateInputDelivery(delivery.id, { status: 'pasting', error: '', submitError: '' });
    this.refreshAttachmentCard(delivery);
    let outcome;
    try {
      const result = await this.injector.pasteItems(items.map((item) => ({ path: item.path, kind: item.kind || attachmentKind(item) })));
      outcome = readMacPasteResult(result, items.length);
    } catch (error) {
      outcome = { ok: false, unconfirmed: false, pasted: 0, total: items.length, app: '', reason: error.message };
    }
    const status = outcome.ok ? 'pasted' : outcome.unconfirmed ? 'unconfirmed' : outcome.pasted > 0 ? 'partial' : 'failed';
    await this.store.updateInputDelivery(delivery.id, {
      status, pastedCount: outcome.pasted, pasteApp: outcome.app, error: outcome.ok ? '' : outcome.reason,
      pendingSubmit: status !== 'failed', pastedAt: status === 'failed' ? 0 : this.now(),
    });
    await this.refreshAttachmentCard(delivery);
    return delivery;
  }

  pendingBatches(now = this.now()) {
    return Object.values(this.store.state?.inputDeliveries || {})
      .filter((item) => item?.kind === 'attachment' && item.pendingSubmit && now - (item.pastedAt || 0) < this.submitWindowMs)
      .sort((a, b) => (b.pastedAt || 0) - (a.pastedAt || 0));
  }

  findPendingBatch() {
    return this.pendingBatches()[0] || null;
  }

  /** 发送：有指令就先打进输入框（接在附件后面），确认打进去了才回车；没打进去不回车，免得只发出图片。 */
  async submitBatch(delivery, text = '', { postprocess = false } = {}) {
    const instruction = String(text || '').trim();
    let reason = '';
    try {
      if (instruction) {
        const typed = await this.injector.injectText(instruction, { postprocess });
        if (!(typed?.ok && typed.mode === 'type')) {
          reason = typed?.ok && typed.mode === 'clipboard'
            ? '指令没打进去：电脑端没识别到输入焦点，文字已放进剪贴板，没有回车'
            : typed?.unconfirmed ? '指令发出后电脑端没回执，没敢回车' : describeRelayFailure(typed);
        }
      }
      if (!reason) {
        const pressed = await this.injector.injectKey('enter');
        if (!pressed?.ok) reason = describeRelayFailure(pressed);
      }
    } catch (error) {
      reason = error.message;
    }
    if (reason) {
      await this.store.updateInputDelivery(delivery.id, { submitError: reason, submitText: instruction });
      await this.refreshAttachmentCard(delivery);
      return delivery;
    }
    // 之前贴进同一个输入框、还没发的批次，跟着这次回车一起发出去了。
    const sentAt = this.now();
    for (const item of new Set([delivery, ...this.pendingBatches()])) {
      await this.store.updateInputDelivery(item.id, {
        status: 'sent', pendingSubmit: false, submitError: '', sentAt,
        submitText: item === delivery ? instruction : '',
      });
      await this.refreshAttachmentCard(item);
    }
    return delivery;
  }

  /** 同一张卡的发送 / PATCH 串行执行，后发的状态不会被先发的旧状态盖掉。 */
  refreshAttachmentCard(delivery) {
    const previous = this.cardChains.get(delivery.id) || Promise.resolve();
    const next = previous.then(async () => {
      try {
        if (!delivery.cardMessageId) {
          const messageId = await this.cards.sendAttachmentReceipt(delivery);
          if (messageId) await this.store.updateInputDelivery(delivery.id, { cardMessageId: messageId });
        } else {
          await this.cards.patchAttachmentReceipt(delivery.cardMessageId, delivery);
        }
      } catch (error) {
        this.log.warn?.('附件回执卡发送失败', error.message);
      }
    });
    this.cardChains.set(delivery.id, next);
    next.then(() => { if (this.cardChains.get(delivery.id) === next) this.cardChains.delete(delivery.id); });
    return next;
  }

  async handleText(text, { message, task, projectName = '' }) {
    if (task) {
      await this.store.addFollowup(task.id, { text, messageId: message.message_id, rootId: message.root_id || task.rootId });
      this.cards.updateTaskCard(task);
      const ackMessageId = await this.cards.replyText(message.message_id, task.status === 'running' ? `📝 已加入 #${task.number} 的追问队列` : `▶️ 正在续接 #${task.number} 的 Claude 会话`);
      this.store.mapMessage(ackMessageId, task.id);
      await this.store.save();
      return task;
    }
    const project = (projectName && this.store.resolveProject?.(projectName)) || this.store.currentProject();
    if (!project) return this.cards.replyText(message.message_id, '当前项目无效，请先用 /projects 和 /use 选择项目。');
    const resumeSessionId = await this.store.consumeResume(project.name);
    const created = await this.store.createTask({
      project: project.name,
      prompt: text,
      messageId: message.message_id,
      rootId: message.message_id,
      resumeSessionId,
    });
    try {
      const cardMessageId = await this.cards.createTaskCard(created);
      await this.store.updateTask(created.id, { taskCardMessageId: cardMessageId });
      this.store.mapMessage(cardMessageId, created.id);
      await this.store.save();
    } catch (error) {
      this.log.error?.('任务卡创建失败', error.message);
    } finally {
      this.store.pump();
    }
    return created;
  }

  async handleAskText(text, message) {
    if (this.approval.resolveText) {
      const resolved = await this.approval.resolveText([message.parent_id, message.root_id], text);
      if (!resolved?.handled) return false;
      await this.cards.replyText?.(message.message_id, resolved.confirmation);
      return true;
    }
    return this.approval.resolveAskByMessage?.([message.parent_id, message.root_id], text) || false;
  }

  async handleCommand(command, { message }) {
    const reply = (text) => this.cards.replyText(message.message_id, text);
    if (command.name === 'ping') {
      return reply(formatPingStatus({
        now: this.connectionHealth?.now || Date.now,
        connectedAt: this.connectionHealth?.connectedAt || 0,
        lastEventAt: this.connectionHealth?.lastEventAt || 0,
      }));
    }
    if (command.name === 'projects') {
      const current = this.store.state.currentProject;
      const lines = this.store.listProjects().map((item) => `${item.index}. ${item.name}${item.name === current ? ' ← 当前' : ''}\n   ${item.path}`);
      return reply(`项目列表（/use 名称或编号切换）\n\n${lines.join('\n')}`);
    }
    if (command.name === 'use') {
      const project = await this.store.useProject(command.args);
      return reply(project ? `✅ 当前项目已切换到 ${project.name}\n${project.path}` : '未找到该项目。用 /projects 查看名称或编号。');
    }
    if (command.name === 'new') {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(command.args);
      if (!match) return reply('用法：/new <项目名|编号> <任务>');
      const project = this.store.resolveProject(match[1]);
      if (!project) return reply('未找到指定项目。');
      const created = await this.store.createTask({ project: project.name, prompt: match[2], messageId: message.message_id, rootId: message.message_id });
      try {
        const cardMessageId = await this.cards.createTaskCard(created);
        await this.store.updateTask(created.id, { taskCardMessageId: cardMessageId });
        this.store.mapMessage(cardMessageId, created.id);
        await this.store.save();
      } catch (error) { this.log.error?.('任务卡创建失败', error.message); }
      finally { this.store.pump(); }
      return created;
    }
    if (command.name === 'status') {
      const active = this.store.listTasks({ activeOnly: true });
      const taskStatus = active.length
        ? active.map((task) => `#${task.number} ${task.project} · ${task.status} · 追问队列 ${task.pendingPrompts?.length || 0}`).join('\n')
        : '当前没有活动任务或排队任务。';
      const online = await this.cloudCliProbe();
      let host = 'cc.nforce.top';
      try { host = new URL(this.webUrl).hostname || host; } catch {}
      return reply(`${taskStatus}\n${online ? `驾驶舱在线 ${host}` : '驾驶舱离线'}`);
    }
    if (command.name === 'stop') {
      const task = await this.store.stopTask(command.args);
      return reply(task ? `🛑 已请求停止 #${task.number}（${task.project}）` : '没有找到可停止的任务。');
    }
    if (command.name === 'clear') {
      const project = this.store.state.currentProject;
      await this.store.clearProject(project);
      return reply(`✅ 已清空 ${project} 的会话记录与待续接选择；运行中的任务不受影响。`);
    }
    if (command.name === 'input' || command.name === 'task') {
      await this.store.setInputMode(command.name);
      return reply(command.name === 'input' ? '✅ 已切换到输入模式：语音和文字将输入电脑。' : '✅ 已切换到任务模式：语音和文字将交给 Claude。');
    }
    if (command.name === 'mode') {
      const modes = new Set(['default', 'accept', 'yolo', 'plan']);
      if (!modes.has(command.args)) return reply(`当前模式：${this.store.state.settings.mode}\n用法：/mode <default|accept|yolo|plan>`);
      await this.store.setMode(command.args);
      const warning = command.args === 'yolo' ? '\n⚠️ yolo 会跳过 Claude 权限审批，仅应用于之后新建的任务。' : '';
      return reply(`✅ 默认模式已设为 ${command.args}${warning}`);
    }
    if (command.name === 'model') {
      if (!command.args) return reply(`当前模型覆盖：${this.store.state.settings.model || '无（使用 Claude 默认）'}\n用 /model default 清除覆盖。`);
      const model = command.args === 'default' ? '' : command.args;
      await this.store.setModel(model);
      return reply(`✅ 模型覆盖已设为：${model || 'Claude 默认'}`);
    }
    if (command.name === 'sessions') {
      const projectName = this.store.state.currentProject;
      const project = this.store.resolveProject(projectName);
      const bridgeSessions = this.store.recentSessions(projectName);
      const diskSessions = project?.path
        ? await this.discoverSessions(project.path, { bridgeSessions })
        : [];
      const sessions = mergeProjectSessions(bridgeSessions, diskSessions);
      await this.store.setSessionMenu(projectName, sessions);
      if (!sessions.length) return reply(`${projectName} 暂无可发现会话。`);
      return reply(sessions.map((item, index) => [
        `${index + 1}. [${item.source}] ${item.preview || '（无摘要）'}`,
        `   ${formatRelativeTime(item.mtime || item.updatedAt, this.now())} · ${item.sessionId}`,
        `   ${buildSessionUrl(item.sessionId, this.webUrl)}`,
      ].join('\n')).join('\n'));
    }
    if (command.name === 'resume') {
      const project = this.store.state.currentProject;
      const session = await this.store.selectResume(project, command.args || 1);
      return reply(session ? `✅ 已选择会话 ${session.sessionId}\n下一条普通文字会以 --resume 续接。` : '未找到该会话编号。先用 /sessions 查看。');
    }
    if (command.name === 'help') return this.cards.replyNotice(message.message_id, { kind: 'help', title: '🧭 指挥台帮助', markdown: this.helpText() });
    return reply(`未知命令。\n\n${this.helpText()}`);
  }

  helpText() {
    return [
      '🧭 项目与任务',
      '/projects｜项目列表', '/use <名|编号>｜切到 <项目>', '/new <项目> <任务>｜新建 <项目> <任务>',
      '/status｜状态', '/stop [编号]｜停止 [编号]', '/clear｜清空',
      '', '⚙️ Claude 设置',
      '/mode <default|accept|yolo|plan>｜模式 <值>', '/model <名|default>｜模型 <名>',
      '/sessions　最近会话', '/resume [n]　下一条消息续接会话',
      '卡片按钮「🖥 打开驾驶舱」可直达当前会话',
      '/sessions 可查看飞书及网页/桌面会话，并用 /resume [n] 续接',
      '', '💬 输入方式',
      '/input｜输入模式　语音/文字复制并输入电脑（默认）',
      '/task｜任务模式　语音/文字交给 Claude',
      '任务 <文字>　任意模式强制交给 Claude',
      '注入 <文字> 或 /type <文字>　任意模式强制输入电脑',
      '图片 / 文件 / 视频 / 富文本附件　input 模式几秒内攒成一批贴进电脑前台窗口，再回一句话即接上并回车；task 模式交给 Claude',
      '多任务并行时，引用回复对应任务卡即可精准追问',
      '审批卡可直接回复：允许 / 拒绝；决策卡可回复选项或序号',
      '', '🩺 链路自检',
      '/ping｜立即检查消息事件、命令路由与回复链路',
      '', '/help　显示本帮助',
    ].join('\n');
  }

  async handleCardAction(value) {
    if (String(value.ns || '').startsWith('cc.attachment.')) {
      if (value.ns === 'cc.attachment.flush') return this.flushAttachmentBatch(value.did);
      const delivery = value.did ? this.store.getInputDelivery?.(value.did) : null;
      if (!delivery?.attachments?.length) return this.log.warn?.('附件动作已过期或不存在', value.did);
      if (value.ns === 'cc.attachment.paste') return this.pasteDelivery(delivery);
      if (value.ns === 'cc.attachment.enter') return this.submitBatch(delivery, '');
      if (value.ns === 'cc.attachment.claude') {
        const task = await this.handleText(delivery.prompt || '处理用户发送的附件', {
          message: { message_id: delivery.sourceMessageId }, task: null, projectName: delivery.project,
        });
        await this.store.updateInputDelivery?.(delivery.id, { forwardedTaskId: task?.id || '' });
        if (delivery.sourceMessageId) await this.cards.replyText?.(delivery.sourceMessageId, `🤖 附件已转给 Claude${task?.number ? `，任务 #${task.number}` : ''}。`);
        return task;
      }
    }
    if (String(value.ns || '').startsWith('cc.inject.')) {
      const delivery = value.did ? this.store.getInputDelivery?.(value.did) : null;
      const referencedTask = value.tid ? this.store.getTask?.(value.tid) : null;
      const sourceMessageId = delivery?.sourceMessageId || referencedTask?.triggerMessageId || '';
      if (value.ns === 'cc.inject.paste') {
        if (!delivery) return this.log.warn?.('粘贴动作已过期或不存在', value.did);
        return this.injector.pasteText(delivery.text);
      }
      if (value.ns === 'cc.inject.enter') {
        return this.injector.injectKey('enter');
      }
      if (value.ns === 'cc.inject.claude') {
        if (!delivery) return this.log.warn?.('转 Claude 动作已过期或不存在', value.did);
        const task = await this.handleText(delivery.text, {
          message: { message_id: delivery.sourceMessageId },
          task: null,
        });
        await this.store.updateInputDelivery?.(delivery.id, { forwardedTaskId: task?.id || '' });
        if (sourceMessageId) await this.cards.replyText?.(sourceMessageId, `🤖 已转给 Claude${task?.number ? `，任务 #${task.number}` : ''}。`);
        return task;
      }
      if (value.ns === 'cc.inject.mode') {
        if (!['task', 'input'].includes(value.mode)) return;
        await this.store.setInputMode(value.mode);
        if (sourceMessageId) await this.cards.replyText?.(sourceMessageId, value.mode === 'input' ? '✅ 已切换到输入模式。' : '✅ 已切换到任务模式。');
        return;
      }
      if (value.ns === 'cc.inject.convert') {
        if (!referencedTask) return this.log.warn?.('语音改道任务已过期或不存在', value.tid);
        const wasActive = ['queued', 'running', 'stopping'].includes(referencedTask.status);
        if (wasActive) await this.store.stopTask(referencedTask.id);
        await this.handleInput(referencedTask.prompt, {
          message: { message_id: referencedTask.triggerMessageId },
          origin: 'voice', postprocess: true, stoppedTask: wasActive ? referencedTask : null,
        });
        if (sourceMessageId) {
          const prefix = wasActive ? `已停止 Claude 任务 #${referencedTask.number}` : `Claude 任务 #${referencedTask.number} 已结束，无法撤销`;
          await this.cards.replyText?.(sourceMessageId, `⌨️ ${prefix}，并改为输入到电脑。`);
        }
        return;
      }
    }
    if (value.ns === 'cc.ask' && value.act === 'select') {
      const found = await this.approval.resolveAsk(value.rid, { index: Number(value.index) });
      if (!found) this.log.warn?.('ask_user 动作已过期或不存在', value.rid);
      return;
    }
    if (['approve', 'deny', 'always'].includes(value.act)) {
      const found = await this.approval.resolve(value.rid, value.act);
      if (!found) this.log.warn?.('审批动作已过期或不存在', value.rid);
      return;
    }
    const task = this.store.getTask(value.tid);
    if (!task) return;
    if (value.act === 'continue') {
      if (task.sessionId) {
        this.store.state.resumeNext[task.project] = task.sessionId;
        this.store.state.currentProject = task.project;
        await this.store.save();
      }
      return;
    }
    if (value.act === 'retry') {
      await this.store.addFollowup(task.id, { text: task.prompt, messageId: task.triggerMessageId, rootId: task.rootId });
      this.cards.updateTaskCard(task);
    }
  }

  async executeTask(task, control) {
    let failed = null;
    this.events?.emit?.('start', task, {
      cwd: this.store.projects[task.project]?.path || '',
      detail: clip(task.pendingPrompts?.[0]?.text || task.prompt || '任务开始', 600),
    }).catch?.(() => {});
    while (task.pendingPrompts?.length) {
      const next = task.pendingPrompts.shift();
      task.round = (task.round || 0) + 1;
      task.currentTool = '启动 Claude Code';
      task.toolHistory ||= [];
      await this.store.updateTask(task.id, { status: 'running', currentTool: task.currentTool, pendingPrompts: task.pendingPrompts, toolHistory: task.toolHistory });
      this.cards.updateTaskCard(task);
      const eventBase = task.eventCount || 0;
      const running = this.runner.run({
        taskId: task.id,
        cwd: this.store.projects[task.project].path,
        prompt: next.text,
        sessionId: task.sessionId,
        mode: task.mode,
        model: task.model,
        onEvent: (event) => {
          task.eventCount = event.eventCount == null ? task.eventCount : eventBase + event.eventCount;
          if (event.sessionId) task.sessionId = event.sessionId;
          if (event.tool) task.currentTool = event.tool;
          if (event.toolCall) {
            task.toolHistory.push(event.toolCall);
            task.toolHistory = task.toolHistory.slice(-3);
          }
          if (event.type === 'bad_line') task.currentTool = `跳过 1 行非 JSON 输出（累计 ${event.badLines}）`;
          this.cards.updateTaskCard(task);
        },
      });
      control.stop = running.stop;
      control.pauseTimeout = running.pauseTimeout;
      control.resumeTimeout = running.resumeTimeout;
      if (task.waitingFor) control.pauseTimeout(task.waitingFor);
      const result = await running.promise;
      if (result.sessionId) task.sessionId = result.sessionId;
      task.eventCount = Math.max(task.eventCount || 0, eventBase + (result.eventCount || 0));
      task.stderrTail = result.stderrTail || '';
      task.result = result.result || '';
      task.costUsd = (Number(task.costUsd) || 0) + (Number(result.costUsd) || 0);
      task.claudeDurationMs = (Number(task.claudeDurationMs) || 0) + (Number(result.claudeDurationMs) || 0);
      await this.store.recordSession(task);
      if (!result.ok || task.status === 'stopping') {
        failed = result;
        break;
      }
      task.currentTool = task.pendingPrompts.length ? '准备续接追问' : '整理结果';
      await this.store.save();
      this.cards.updateTaskCard(task);
    }
    if (failed) {
      await this.store.updateTask(task.id, {
        status: 'failed',
        error: failed.timedOut ? 'Claude 单轮任务超过超时限制，已发送 SIGTERM' : failed.stopped ? '由用户停止' : clip(failed.error || 'Claude 执行失败', 1200),
        stderrTail: failed.stderrTail || task.stderrTail,
        finishedAt: Date.now(),
        currentTool: '',
      });
      this.cards.updateTaskCard(task);
      this.events?.emit?.('failed', task, { cwd: this.store.projects[task.project]?.path || '' }).catch?.(() => {});
      try {
        const messageId = await this.cards.sendFailure(task);
        this.store.mapMessage(messageId, task.id);
        await this.store.save();
      } catch (error) { this.log.error?.('失败卡发送失败', error.message); }
      return;
    }
    await this.store.updateTask(task.id, { status: 'done', finishedAt: Date.now(), currentTool: '' });
    this.cards.updateTaskCard(task);
    this.events?.emit?.('done', task, { cwd: this.store.projects[task.project]?.path || '' }).catch?.(() => {});
    try {
      const messageId = await this.cards.sendComplete(task);
      this.store.mapMessage(messageId, task.id);
      await this.store.save();
    } catch (error) { this.log.error?.('完成卡发送失败', error.message); }
    if (process.env.CC_SEND_FILES !== '0') {
      const projectDir = this.store.projects[task.project]?.path;
      const files = extractOutputFiles(task.result, { projectDir });
      if (files.length) {
        try {
          const sent = await this.cards.sendArtifacts(task, files);
          for (const item of sent) this.store.mapMessage(item.messageId, task.id);
          await this.store.save();
          this.log.info?.(`任务 #${task.number} 已回传 ${sent.length} 个产物文件`);
        } catch (error) { this.log.warn?.('产物文件回传失败', error.message); }
      }
    }
  }
}

export async function createBridge({ dir = import.meta.dirname } = {}) {
  loadEnvFile(join(dir, '.env'));
  const log = createLogger('cc-bridge');
  const appId = process.env.LARK_APP_ID || process.env.FEISHU_APP_ID || '';
  const appSecret = process.env.LARK_APP_SECRET || process.env.FEISHU_APP_SECRET || '';
  const ownerId = process.env.LARK_OPEN_ID || BRIGHT_OPEN_ID;
  if (!appId || !appSecret) throw new Error('缺少 LARK_APP_ID / LARK_APP_SECRET');
  const approvalPort = Number(process.env.CC_APPROVAL_PORT) || 18791;
  const approvalToken = process.env.CC_APPROVAL_TOKEN || randomBytes(32).toString('hex');
  const store = await new SessionStore({ dir, globalLimit: Number(process.env.CC_GLOBAL_LIMIT) || 3 }).init();
  const sdkLogger = createSdkLogger({ log, secrets: [appId, appSecret] });
  const connectionHealth = { connectedAt: 0, lastEventAt: 0 };
  const client = new lark.Client({ appId, appSecret, domain: lark.Domain.Feishu, logger: sdkLogger });
  const media = new MediaStore({ client, projectPaths: Object.values(store.projects).map((item) => item.path) });
  const removedMediaDirs = await media.init();
  if (removedMediaDirs) log.info(`已清理 ${removedMediaDirs} 个过期图片临时目录`);
  const ffmpeg = checkFfmpeg();
  if (!ffmpeg.ok) log.warn(`语音识别降级：ffmpeg 不可用（${ffmpeg.error}）`);
  const cards = new CardService({ client, ownerId, throttleMs: Number(process.env.CC_CARD_THROTTLE_MS) || 2500, log });
  const events = new BridgeEventClient({ url: process.env.CV_WORKER_URL || '', secret: process.env.HOOK_SECRET || '' });
  const runner = new ClaudeRunner({ timeoutMs: Number(process.env.CC_TASK_TIMEOUT_MS) || 45 * 60_000, approvalPort, approvalToken });
  const injector = process.env.RELAY_URL && process.env.MAC_ID
    ? new RelayInjector({ url: process.env.RELAY_URL, macId: process.env.MAC_ID, name: process.env.DEVICE_NAME || 'Claude 飞书指挥台', dir, log })
    : new DisabledInjector();
  let controller;
  const approval = new ApprovalServer({
    store, cards, events, port: approvalPort, token: approvalToken,
    timeoutMs: Number(process.env.CC_APPROVAL_TIMEOUT_MS) || 10 * 60_000,
    askTimeoutMs: Number(process.env.CC_ASK_TIMEOUT_MS) || 15 * 60_000,
    log,
  });
  controller = new BridgeController({
    store, runner, cards, approval, injector, media, events, connectionHealth, log,
  });
  const transcribeAudio = async (message) => {
    if (!ffmpeg.ok) throw new Error('本机 ffmpeg 不可用，请安装后重试');
    let content = {};
    try { content = JSON.parse(message.content || '{}'); } catch {}
    return transcribeLarkAudio({ client, messageId: message.message_id, fileKey: content.file_key, ffmpegPath: ffmpeg.path });
  };
  const messageHandler = createMessageHandler({ ownerId, store, controller, cards, injector, transcribeAudio, media, log });
  const actionHandler = createCardActionHandler({ ownerId, controller, log });
  const dispatcher = createObservedDispatcher(new lark.EventDispatcher({}).register({
    'im.message.receive_v1': messageHandler,
    'card.action.trigger': actionHandler,
  }), { health: connectionHealth, log });
  const connection = new LarkConnectionManager({
    dispatcher,
    health: connectionHealth,
    secrets: [appId, appSecret],
    log,
    clientFactory: (callbacks) => new lark.WSClient({
      appId,
      appSecret,
      domain: lark.Domain.Feishu,
      logger: sdkLogger,
      autoReconnect: true,
      handshakeTimeoutMs: 20_000,
      wsConfig: { pingTimeout: 10 },
      ...callbacks,
    }),
  });
  return {
    appId, ownerId, log, store, client, cards, runner, injector, media, events,
    approval, controller, dispatcher, connectionHealth, connection,
  };
}

export async function main() {
  const bridge = await createBridge();
  await bridge.approval.start();
  bridge.log.info(`审批服务监听 127.0.0.1:${bridge.approval.port}`);
  bridge.controller.start();
  await bridge.connection.start();
  bridge.log.info(`cc-bridge 已启动，app=${redact(bridge.appId)} owner=${redact(bridge.ownerId)}`);
  let exiting = false;
  const shutdown = async (signal) => {
    if (exiting) return;
    exiting = true;
    bridge.log.info(`收到 ${signal}，正在优雅退出`);
    for (const task of bridge.store.listTasks({ activeOnly: true })) await bridge.store.stopTask(task.id);
    bridge.connection.close();
    bridge.injector.close();
    await bridge.approval.close().catch(() => {});
    await bridge.store.save().catch(() => {});
    process.exit(0);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  return bridge;
}

const directRun = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
const pm2Run = process.env.pm_id !== undefined;
if (directRun || pm2Run) {
  main().catch((error) => {
    console.error(new Date().toISOString(), '[cc-bridge] 启动失败', error.message);
    process.exit(1);
  });
}
