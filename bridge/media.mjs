import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { mkdir, readFile, readdir, rename, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';

const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function parseContent(content) {
  if (content && typeof content === 'object') return content;
  try { return JSON.parse(content || '{}'); } catch { return {}; }
}

function localeFromPost(content) {
  return (Array.isArray(content.content) ? content : null)
    || content.zh_cn || content.en_us || Object.values(content).find((value) => value?.content) || {};
}

export function parseAttachmentMessage(message) {
  const content = parseContent(message?.content);
  const messageType = String(message?.message_type || '');
  const text = [];
  const attachments = [];
  const seen = new Set();
  const add = ({ key, resourceType, name = '', mime = '', declaredSize = 0 }) => {
    if (!key || !['image', 'file'].includes(resourceType)) return;
    const identity = `${resourceType}:${key}`;
    if (seen.has(identity)) return;
    seen.add(identity);
    attachments.push({
      key: String(key), resourceType, name: String(name || ''), mime: String(mime || ''),
      declaredSize: Number(declaredSize) || 0,
    });
  };

  if (messageType === 'image') {
    add({ key: content.image_key, resourceType: 'image', name: content.file_name || content.image_name });
  } else if (['file', 'media', 'video'].includes(messageType)) {
    add({
      key: content.file_key, resourceType: 'file',
      name: content.file_name || content.name,
      mime: content.mime_type || content.content_type,
      declaredSize: content.file_size || content.size,
    });
  } else if (messageType === 'post') {
    const locale = localeFromPost(content);
    if (String(locale.title || '').trim()) text.push(String(locale.title).trim());
    for (const row of locale.content || []) {
      const rowText = [];
      for (const element of row || []) {
        if (element?.image_key && ['img', 'image'].includes(String(element.tag || '').toLowerCase())) {
          add({ key: element.image_key, resourceType: 'image', name: element.file_name || element.image_name });
        }
        if (element?.file_key) {
          add({
            key: element.file_key, resourceType: 'file', name: element.file_name || element.name,
            mime: element.mime_type || element.content_type,
            declaredSize: element.file_size || element.size,
          });
        }
        if ((element?.tag === 'text' || element?.tag === 'a') && String(element.text || '').trim()) {
          rowText.push(String(element.text).trim());
        }
      }
      if (rowText.length) text.push(rowText.join(''));
    }
  }
  return { text: text.join('\n'), attachments };
}

export function parseImageMessage(message) {
  const parsed = parseAttachmentMessage(message);
  return {
    text: parsed.text,
    imageKeys: parsed.attachments.filter((item) => item.resourceType === 'image').map((item) => item.key),
  };
}

export function buildImagePrompt(text, paths) {
  const task = String(text || '').trim() || '描述/分析这张图片';
  if (!paths?.length) return task;
  const instruction = paths.length === 1 ? '请先读取该图片：' : '请先读取这些图片：';
  return `${task}\n\n${instruction}\n${paths.join('\n')}`;
}

export function buildFilePrompt(text, paths) {
  const task = String(text || '').trim() || '阅读并处理这个文件';
  if (!paths?.length) return task;
  const instruction = paths.length === 1 ? '请先读取该文件：' : '请先读取这些文件：';
  return `${task}\n\n${instruction}\n${paths.join('\n')}`;
}

function extensionFor(buffer, headers = {}) {
  const type = String(headerValue(headers, 'content-type')).toLowerCase();
  if (type.includes('png') || buffer.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))) return '.png';
  if (type.includes('jpeg') || buffer.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'))) return '.jpg';
  if (type.includes('gif') || buffer.subarray(0, 3).toString() === 'GIF') return '.gif';
  if (type.includes('webp') || (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP')) return '.webp';
  return '.jpg';
}

function headerValue(headers, name) {
  if (!headers) return '';
  if (typeof headers.get === 'function') return headers.get(name) || '';
  return headers[name] || headers[name.toLowerCase()] || headers[name.toUpperCase()] || '';
}

function extensionForMime(mime) {
  const type = String(mime || '').toLowerCase().split(';')[0].trim();
  return ({
    'application/pdf': '.pdf', 'video/mp4': '.mp4', 'audio/mpeg': '.mp3',
    'audio/ogg': '.ogg', 'audio/opus': '.opus', 'video/quicktime': '.mov',
    'application/zip': '.zip', 'text/plain': '.txt', 'image/png': '.png',
    'image/jpeg': '.jpg', 'image/gif': '.gif', 'image/webp': '.webp',
  })[type] || '';
}

function contentDispositionName(headers) {
  const value = String(headerValue(headers, 'content-disposition'));
  const utf8 = /filename\*=UTF-8''([^;]+)/i.exec(value);
  if (utf8) {
    try { return decodeURIComponent(utf8[1]); } catch {}
  }
  return /filename="?([^";]+)"?/i.exec(value)?.[1] || '';
}

function safeName(value) {
  return String(value || 'message').replace(/[^a-zA-Z0-9._-]/g, '_').slice(-80) || 'message';
}

function safeFileName(value, fallback = 'attachment') {
  const cleaned = basename(String(value || fallback))
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/[/:\\]/g, '_')
    .trim();
  return cleaned.slice(-160) || fallback;
}

export class MediaStore {
  constructor({
    client,
    root = '',
    projectPaths = [],
    legacyRoot = process.env.CC_TMP_DIR || join(homedir(), '.claude', 'cc-bridge-tmp'),
    maxAgeMs = 24 * 60 * 60 * 1000,
  } = {}) {
    this.client = client;
    this.root = root;
    this.projectPaths = [...new Set(projectPaths.filter(Boolean).map((path) => resolve(path)))];
    this.legacyRoot = legacyRoot;
    this.maxAgeMs = maxAgeMs;
  }

  async init() {
    let removed = 0;
    const roots = this.root
      ? [this.root]
      : this.projectPaths.map((projectPath) => join(projectPath, '.cc-bridge', 'incoming'));
    for (const root of roots) {
      if (!this.root && !existsSync(root)) continue;
      if (this.root) await mkdir(root, { recursive: true, mode: 0o700 });
      for (const entry of await readdir(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const path = join(root, entry.name);
        const info = await stat(path).catch(() => null);
        if (info && Date.now() - info.mtimeMs > this.maxAgeMs) {
          await rm(path, { recursive: true, force: true });
          removed += 1;
        }
      }
      if (!this.root) {
        await rmdir(root).catch(() => {});
        await rmdir(dirname(root)).catch(() => {});
      }
    }
    return removed;
  }

  #incomingRoot(projectPath) {
    if (this.root) return this.root;
    if (!projectPath) throw new Error('缺少媒体所属项目路径');
    return join(resolve(projectPath), '.cc-bridge', 'incoming');
  }

  async prepareMediaMessage(message, { projectPath, onLargeDownload } = {}) {
    const parsed = parseAttachmentMessage(message);
    if (!parsed.attachments.length) return { ...parsed, paths: [], prompt: parsed.text };
    const dir = join(this.#incomingRoot(projectPath), safeName(message.message_id));
    await mkdir(dir, { recursive: true, mode: 0o700 });
    const paths = [];
    const downloaded = [];
    for (const [index, attachment] of parsed.attachments.entries()) {
      const pending = join(dir, `${index + 1}-${safeName(attachment.key)}.download`);
      const response = await this.client.im.messageResource.get({
        path: { message_id: message.message_id, file_key: attachment.key },
        params: { type: attachment.resourceType },
      });
      const mime = String(headerValue(response.headers, 'content-type') || attachment.mime || 'application/octet-stream').split(';')[0].trim();
      const declaredSize = Number(headerValue(response.headers, 'content-length')) || attachment.declaredSize || 0;
      const responseName = contentDispositionName(response.headers);
      const provisionalName = safeFileName(attachment.name || responseName, `${safeName(attachment.key)}${extensionForMime(mime) || '.bin'}`);
      if (declaredSize > 10 * 1024 * 1024) {
        await onLargeDownload?.({ name: provisionalName, size: declaredSize, mime, resourceType: attachment.resourceType });
      }
      await response.writeFile(pending);
      const buffer = await readFile(pending);
      const finalName = attachment.resourceType === 'image'
        ? safeFileName(attachment.name || responseName, `${safeName(attachment.key)}${extensionFor(buffer, response.headers)}`)
        : provisionalName;
      const diskName = parsed.attachments.length > 1 ? `${index + 1}-${finalName}` : finalName;
      const finalPath = join(dir, diskName);
      await rename(pending, finalPath);
      const info = await stat(finalPath);
      paths.push(finalPath);
      downloaded.push({ ...attachment, name: finalName, mime, size: info.size, declaredSize, path: finalPath });
    }
    const onlyImages = downloaded.every((item) => item.resourceType === 'image');
    return {
      ...parsed, attachments: downloaded, paths,
      imageKeys: downloaded.filter((item) => item.resourceType === 'image').map((item) => item.key),
      fileKeys: downloaded.filter((item) => item.resourceType === 'file').map((item) => item.key),
      prompt: onlyImages ? buildImagePrompt(parsed.text, paths) : buildFilePrompt(parsed.text, paths),
    };
  }

  prepareImageMessage(message, options) {
    return this.prepareMediaMessage(message, options);
  }

}

function isInside(file, directory) {
  const rel = relative(directory, file);
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

function candidatePaths(text) {
  const found = [];
  const add = (value) => {
    const clean = String(value || '')
      .replace(/^file:\/\//, '')
      .replace(/^['"(<]+|['">),.;:]+$/g, '')
      .trim();
    if (clean) found.push(clean);
  };
  for (const match of String(text || '').matchAll(/`([^`\n]+)`/g)) add(match[1]);
  for (const match of String(text || '').matchAll(/\[[^\]]*\]\(([^)]+)\)/g)) add(match[1]);
  for (const match of String(text || '').matchAll(/(?:^|\s)((?:\/|\.\.?\/)?[^\s`'"<>]+\.[a-zA-Z0-9]{1,8})(?=$|\s)/gm)) add(match[1]);
  return found;
}

export function extractOutputFiles(resultText, { projectDir, maxFiles = 3 } = {}) {
  if (!projectDir || !existsSync(projectDir)) return [];
  const projectReal = realpathSync(projectDir);
  const tmpReal = realpathSync('/tmp');
  const files = [];
  const seen = new Set();
  for (const candidate of candidatePaths(resultText)) {
    const path = resolve(projectDir, candidate);
    if (!existsSync(path)) continue;
    let real;
    let info;
    try {
      real = realpathSync(path);
      info = statSync(real);
    } catch { continue; }
    if (!info.isFile() || (!isInside(real, projectReal) && !isInside(real, tmpReal))) continue;
    if (seen.has(real)) continue;
    seen.add(real);
    files.push(path);
    if (files.length >= maxFiles) break;
  }
  return files;
}

export function isImageFile(path) {
  return IMAGE_EXTENSIONS.has(extname(path).toLowerCase());
}

export function outputFileName(path) {
  return basename(path);
}

export function readOutputFile(path) {
  return readFileSync(path);
}
