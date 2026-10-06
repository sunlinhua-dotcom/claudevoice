import { parseCardActionValue } from './cards.mjs';

export class LruSet {
  constructor(limit = 1000) { this.limit = limit; this.values = new Map(); }
  has(value) { return this.values.has(value); }
  add(value) {
    if (this.values.has(value)) this.values.delete(value);
    this.values.set(value, true);
    while (this.values.size > this.limit) this.values.delete(this.values.keys().next().value);
  }
}

function formatPingTime(value) {
  return Number(value) > 0 ? new Date(Number(value)).toISOString() : '尚无记录';
}

export function formatPingStatus({
  now = Date.now(), connectedAt = 0, lastEventAt = 0,
} = {}) {
  const current = typeof now === 'function' ? now() : now;
  return `pong ${formatPingTime(current)} | 长连接建立于 ${formatPingTime(connectedAt)} | 最近事件 ${formatPingTime(lastEventAt)}`;
}

export function parseCommand(input) {
  const text = String(input || '').trim();
  if (!text) return null;
  const chinese = [
    [/^项目列表$/, '/projects'],
    [/^新建\s+([\s\S]+)$/, '/new $1'],
    [/^切到\s*(.+)$/i, '/use $1'],
    [/^状态$/, '/status'],
    [/^停止(?:\s+(\S+))?$/, '/stop $1'],
    [/^清空$/, '/clear'],
    [/^模式(?:\s+([\s\S]+))?$/, '/mode $1'],
    [/^模型(?:\s+([\s\S]+))?$/, '/model $1'],
    [/^会话(?:列表)?$/, '/sessions'],
    [/^续会话(?:\s+(\d+))?$/, '/resume $1'],
    [/^输入模式$/, '/input'],
    [/^任务模式$/, '/task'],
    [/^自检$/, '/ping'],
    [/^帮助$/, '/help'],
  ];
  let normalized = text;
  for (const [pattern, replacement] of chinese) {
    if (pattern.test(text)) { normalized = text.replace(pattern, replacement).trim(); break; }
  }
  if (!normalized.startsWith('/')) return null;
  const match = /^\/(projects|use|new|status|stop|clear|mode|model|sessions|resume|input|task|ping|help)(?:\s+([\s\S]*))?$/i.exec(normalized);
  if (!match) return { name: 'unknown', args: normalized.slice(1) };
  return { name: match[1].toLowerCase(), args: (match[2] || '').trim() };
}

export function classifyTextRoute(input, inputMode = 'input') {
  const text = String(input || '').trim();
  const typeMatch = /^\/type(?:\s+([\s\S]*))?$/i.exec(text);
  if (typeMatch) return { kind: 'input', text: (typeMatch[1] || '').trim(), forced: true };
  const injectMatch = /^注入\s+([\s\S]*)$/.exec(text);
  if (injectMatch) return { kind: 'input', text: injectMatch[1].trim(), forced: true };
  const taskMatch = /^任务\s+([\s\S]*)$/.exec(text);
  if (taskMatch) return { kind: 'task', text: taskMatch[1].trim(), forced: true };
  if (text.startsWith('/')) return { kind: 'command', text };
  return { kind: inputMode === 'input' ? 'input' : 'task', text, forced: false };
}

function textFromMessage(message) {
  if (message?.message_type !== 'text') return '';
  try { return String(JSON.parse(message.content || '{}').text || '').trim(); } catch { return ''; }
}

export function createMessageHandler({
  ownerId, store, controller, cards, injector, transcribeAudio, media,
  log = console, dedupe = new LruSet(1000),
}) {
  return async function handleMessage(data) {
    const message = data?.message;
    const openId = data?.sender?.sender_id?.open_id;
    if (!message?.message_id) return;
    if (dedupe.has(message.message_id)) return;
    dedupe.add(message.message_id);
    if (openId !== ownerId) {
      await cards.replyText(message.message_id, '此机器人仅服务主人');
      return;
    }
    const routeText = async (text, { origin = 'text', postprocess = false, voice = false, forceKind = '' } = {}) => {
      log.info?.('收到 BRIGHT 消息', { id: message.message_id.slice(-8), type: message.message_type, quoted: Boolean(message.parent_id || message.root_id) });
      if (await controller.handleAskText?.(text, message)) return;
      const inputMode = store.state?.settings?.inputMode || 'input';
      const route = forceKind ? { kind: forceKind, text: String(text || '').trim(), forced: true } : classifyTextRoute(text, inputMode);
      if (route.kind === 'input') {
        return controller.handleInput(route.text, { message, task: null, origin, postprocess });
      }
      const command = route.kind === 'command' ? parseCommand(route.text) : null;
      if (command) return controller.handleCommand(command, { message, openId });
      const quotedTask = store.findTaskByMessage(message.parent_id, message.root_id);
      const task = quotedTask || store.findRecentTask?.() || null;
      const created = await controller.handleText(route.text, { message, task });
      if (voice && created?.id) {
        const messageId = await cards.sendVoiceConfirmation?.({ text: route.text, task: created, inputMode });
        if (messageId) {
          store.mapMessage?.(messageId, created.id);
          await store.save?.();
        }
      }
      return created;
    };

    if (message.message_type === 'audio') {
      if (!transcribeAudio) return cards.replyText(message.message_id, '⚠️ 当前未启用语音识别，请改发文字。');
      try {
        const recognized = String(await transcribeAudio(message) || '').trim();
        if (!recognized) return cards.replyText(message.message_id, '🎤 没有识别到清晰文字，请靠近麦克风后重试，或直接发送文字。');
        return routeText(recognized, { origin: 'voice', postprocess: true, voice: true });
      } catch (error) {
        log.warn?.('语音识别失败', error.message);
        return cards.replyText(message.message_id, `⚠️ 语音识别失败：${error.message || '未知错误'}。请重试或直接发送文字。`);
      }
    }

    if (['image', 'file', 'media', 'video', 'post'].includes(message.message_type)) {
      if (!media) return cards.replyText(message.message_id, '⚠️ 当前未启用图片处理，请改发文字。');
      const inputMode = store.state?.settings?.inputMode || 'input';
      if (inputMode === 'input') {
        if (!controller.handleAttachment) return cards.replyText(message.message_id, '⚠️ 当前未启用附件剪贴板处理。');
        return controller.handleAttachment(message);
      }
      try {
        const linkedTask = store.findTaskByMessage(message.parent_id, message.root_id);
        const projectName = linkedTask?.project || store.state?.currentProject;
        const projectPath = store.projects?.[projectName]?.path;
        const prepare = media.prepareMediaMessage?.bind(media) || media.prepareImageMessage?.bind(media);
        const prepared = await prepare(message, { projectPath });
        if (!prepared.prompt) return cards.replyText(message.message_id, '⚠️ 这条图文消息里没有可读取的文字或图片。');
        return routeText(prepared.prompt, { origin: 'media', forceKind: 'task' });
      } catch (error) {
        log.warn?.('附件下载失败', error.message);
        return cards.replyText(message.message_id, `⚠️ 附件读取失败：${error.message || '未知错误'}。请重新发送附件。`);
      }
    }

    const text = textFromMessage(message);
    if (text) return routeText(text);
    return cards.replyText(message.message_id, '暂不支持这种消息类型，请发送文字、语音或附件。');
  };
}

export function createCardActionHandler({ ownerId, controller, log = console }) {
  return async function handleCardAction(data) {
    const openId = data?.operator?.open_id || data?.open_id;
    if (openId !== ownerId) return { toast: { type: 'error', content: '此机器人仅服务主人' } };
    const value = parseCardActionValue(data);
    if (!['cc', 'cc.ask'].includes(value?.ns)
      && !String(value?.ns || '').startsWith('cc.inject.')
      && !String(value?.ns || '').startsWith('cc.attachment.')) {
      return { toast: { type: 'info', content: '非 cc-bridge 操作' } };
    }
    log.info?.('收到 cc 卡片动作', value.act || 'unknown');
    setImmediate(() => controller.handleCardAction(value, data).catch((error) => log.error?.('卡片动作处理失败', error.message)));
    const content = {
      approve: '已允许', deny: '已拒绝', always: '本任务后续将自动允许', select: '已记录选择',
      continue: '下一条消息将续接此会话', retry: '已安排重试',
      'cc.inject.paste': '正在粘贴', 'cc.inject.enter': '正在回车', 'cc.inject.claude': '正在转给 Claude',
      'cc.inject.mode': '正在切换模式', 'cc.inject.convert': '正在改为电脑输入',
      'cc.attachment.paste': '正在重新粘贴', 'cc.attachment.claude': '正在转给 Claude',
      'cc.attachment.enter': '正在回车发送', 'cc.attachment.flush': '马上贴',
    }[value.act || value.ns] || '已接收';
    return { toast: { type: 'success', content } };
  };
}
