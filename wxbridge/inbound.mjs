/**
 * inbound.mjs — 把 iLink 的 WeixinMessage 拍平成 wxbridge 内部结构。
 * 字段取法对齐官方插件 dist/src/messaging/inbound.js 与 media/media-download.js。
 */
import { ItemType } from './ilink.mjs';

/** 语音条自带的转写文本，微信服务端给的，不用自己跑 ASR。 */
function voiceText(item) {
  return item?.type === ItemType.VOICE ? String(item.voice_item?.text || '') : '';
}

function quotedPrefix(ref) {
  if (!ref) return '';
  const parts = [];
  if (ref.title) parts.push(String(ref.title));
  const inner = ref.message_item;
  if (inner?.type === ItemType.TEXT && inner.text_item?.text) parts.push(String(inner.text_item.text));
  if (inner?.type === ItemType.FILE && inner.file_item?.file_name) parts.push(String(inner.file_item.file_name));
  return parts.length ? `[引用: ${parts.join(' | ')}]\n` : '';
}

/** 抽出这条消息的正文：正文文本、语音转写、引用上下文都算。 */
export function extractText(itemList) {
  const chunks = [];
  for (const item of itemList || []) {
    if (item.type === ItemType.TEXT && item.text_item?.text != null) {
      chunks.push(`${quotedPrefix(item.ref_msg)}${String(item.text_item.text)}`);
      continue;
    }
    const spoken = voiceText(item);
    if (spoken) chunks.push(spoken);
  }
  return chunks.join('\n').trim();
}

/** 图片的密钥可能挂在 image_item.aeskey（十六进制），要转成 base64 再用。 */
function imageAesKey(img) {
  if (img?.aeskey) return Buffer.from(String(img.aeskey), 'hex').toString('base64');
  return img?.media?.aes_key || '';
}

function attachmentFromItem(item, index) {
  switch (item?.type) {
    case ItemType.IMAGE: {
      const img = item.image_item;
      if (!img?.media) return null;
      return {
        kind: 'image', media: img.media, aesKeyOverride: imageAesKey(img),
        fileName: `image-${index + 1}.jpg`, mime: 'image/jpeg',
      };
    }
    case ItemType.FILE: {
      const f = item.file_item;
      if (!f?.media) return null;
      return {
        kind: 'file', media: f.media, aesKeyOverride: '',
        fileName: String(f.file_name || `file-${index + 1}.bin`), mime: 'application/octet-stream',
      };
    }
    case ItemType.VIDEO: {
      const v = item.video_item;
      if (!v?.media) return null;
      return {
        kind: 'video', media: v.media, aesKeyOverride: '',
        fileName: `video-${index + 1}.mp4`, mime: 'video/mp4',
      };
    }
    case ItemType.VOICE: {
      const v = item.voice_item;
      if (!v?.media) return null;
      return {
        kind: 'voice', media: v.media, aesKeyOverride: '',
        fileName: `voice-${index + 1}.silk`, mime: 'audio/silk',
        transcript: String(v.text || ''),
      };
    }
    default:
      return null;
  }
}

/**
 * 归一化一条入站消息。
 * unsupported 记下收到但处理不了的 item 类型（比如合并转发的聊天记录卡片），
 * 好让回执里能如实告诉用户「这条没接住」，而不是静默丢掉。
 */
export function normalize(msg) {
  const itemList = msg?.item_list || [];
  const attachments = [];
  const unsupported = [];
  itemList.forEach((item, index) => {
    const attachment = attachmentFromItem(item, index);
    if (attachment) { attachments.push(attachment); return; }
    const known = [ItemType.TEXT, ItemType.TOOL_CALL_START, ItemType.TOOL_CALL_RESULT];
    if (!known.includes(item?.type)) unsupported.push(item?.type ?? 'unknown');
  });
  return {
    from: String(msg?.from_user_id || ''),
    contextToken: String(msg?.context_token || ''),
    createdAtMs: Number(msg?.create_time_ms) || Date.now(),
    text: extractText(itemList),
    attachments,
    unsupported,
  };
}
