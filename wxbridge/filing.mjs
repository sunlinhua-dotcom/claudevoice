/**
 * filing.mjs — 把附件和 brief 落到项目文件夹里。
 *
 * 落点固定为 <项目>/_inbox/<YYYY-MM-DD>/，同一天多次转发往同一个文件夹里追加，
 * brief 汇总在该文件夹的 README.md。判不出项目的落到待分拣区，等你一句话改判。
 */
import { mkdir, readdir, rename, appendFile, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, extname, join } from 'node:path';

export const INBOX_DIR = process.env.WXBRIDGE_INBOX_DIR || '_inbox';
export const UNSORTED_ROOT = process.env.WXBRIDGE_UNSORTED_DIR
  || join(homedir(), '.wxbridge', '_unsorted');

function pad(n) { return String(n).padStart(2, '0'); }

export function dayStamp(at = new Date()) {
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

function timeStamp(at = new Date()) {
  return `${pad(at.getHours())}:${pad(at.getMinutes())}`;
}

/** 去掉路径分隔符和控制字符，保留中文和常见符号。 */
export function safeFileName(input, fallback = 'file.bin') {
  const cleaned = String(input || '')
    .replace(/[/\\]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^\.+/, '')
    .trim();
  return cleaned || fallback;
}

async function exists(path) {
  try { await stat(path); return true; } catch { return false; }
}

/** 同名文件不覆盖，追加 -2 / -3 后缀。客户经常发同名的「方案.pdf」。 */
async function uniquePath(dir, fileName) {
  const ext = extname(fileName);
  const stem = basename(fileName, ext);
  let candidate = join(dir, fileName);
  let n = 2;
  while (await exists(candidate)) {
    candidate = join(dir, `${stem}-${n}${ext}`);
    n += 1;
  }
  return candidate;
}

function humanSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function resolveDestination({ project, projectPath, at = new Date() }) {
  const day = dayStamp(at);
  if (project && projectPath) return { dir: join(projectPath, INBOX_DIR, day), sorted: true };
  return { dir: join(UNSORTED_ROOT, day), sorted: false };
}

/**
 * 写一批附件 + 一段 brief。attachments 里每项要带 { fileName, buffer }。
 * 返回落盘的绝对路径，供回执和后续改判使用。
 */
export async function archive({
  project, projectPath, text = '', attachments = [], at = new Date(),
  senderLabel = '微信', reason = '', confidence = 0, unsupported = [],
}) {
  const { dir, sorted } = resolveDestination({ project, projectPath, at });
  await mkdir(dir, { recursive: true });

  const written = [];
  for (const attachment of attachments) {
    if (!attachment?.buffer) continue;
    const target = await uniquePath(dir, safeFileName(attachment.fileName));
    await writeFile(target, attachment.buffer);
    written.push({ path: target, name: basename(target), size: attachment.buffer.length, kind: attachment.kind });
  }

  const lines = [`## ${timeStamp(at)} · ${senderLabel}`, ''];
  if (text) lines.push(text, '');
  if (written.length) {
    lines.push('附件：');
    for (const file of written) lines.push(`- \`${file.name}\`（${humanSize(file.size)}）`);
    lines.push('');
  }
  if (unsupported.length) {
    lines.push(`> 有 ${unsupported.length} 项内容这个通道接不住（合并转发的聊天记录卡片之类），需要单独补。`, '');
  }
  if (reason) lines.push(`> 归类依据：${reason}${confidence ? `（把握 ${Math.round(confidence * 100)}%）` : ''}`, '');
  lines.push('');

  const readme = join(dir, 'README.md');
  if (!(await exists(readme))) {
    await writeFile(readme, `# ${project || '待分拣'} · ${dayStamp(at)} 微信来件\n\n`);
  }
  await appendFile(readme, lines.join('\n'));

  return { dir, sorted, files: written, readme };
}

/**
 * 改判：把上一批已归档的文件整体挪到另一个项目，README 也补一条说明。
 * 只挪文件，不动已经写进旧 README 的历史记录，留痕比整洁重要。
 */
export async function refile({ batch, project, projectPath, at = new Date() }) {
  const { dir } = resolveDestination({ project, projectPath, at });
  await mkdir(dir, { recursive: true });
  const moved = [];
  for (const file of batch?.files || []) {
    if (!(await exists(file.path))) continue;
    const target = await uniquePath(dir, basename(file.path));
    await rename(file.path, target);
    moved.push({ ...file, path: target, name: basename(target) });
  }
  const readme = join(dir, 'README.md');
  if (!(await exists(readme))) {
    await writeFile(readme, `# ${project} · ${dayStamp(at)} 微信来件\n\n`);
  }
  const lines = [`## ${timeStamp(at)} · 改判自 ${batch?.project || '待分拣'}`, ''];
  if (batch?.text) lines.push(batch.text, '');
  if (moved.length) {
    lines.push('附件：');
    for (const file of moved) lines.push(`- \`${file.name}\`（${humanSize(file.size)}）`);
    lines.push('');
  }
  lines.push('');
  await appendFile(readme, lines.join('\n'));
  return { dir, files: moved };
}

/** 待分拣区里还剩多少东西没认领，回执里提醒用。 */
export async function unsortedCount() {
  try {
    const days = await readdir(UNSORTED_ROOT, { withFileTypes: true });
    let total = 0;
    for (const day of days) {
      if (!day.isDirectory()) continue;
      const entries = await readdir(join(UNSORTED_ROOT, day.name));
      total += entries.filter((name) => name !== 'README.md').length;
    }
    return total;
  } catch {
    return 0;
  }
}
