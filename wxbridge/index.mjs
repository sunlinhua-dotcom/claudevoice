#!/usr/bin/env node
/**
 * wxbridge — 微信 ClawBot 到项目文件夹的 brief 回流管道。
 *
 * 你在微信里把客户的需求和附件转发给 ClawBot，这个进程负责认出该归哪个项目，
 * 把附件写进那个项目的 _inbox，并在微信里回一条回执告诉你落到哪了。
 * 判错了回一句「改到 <项目>」就地改判，同时它会把这次的线索记成关键词。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, relative } from 'node:path';

import { downloadMedia, getUpdates, notifyStart, notifyStop, sendText, STALE_TOKEN_ERRCODE } from './ilink.mjs';
import { normalize } from './inbound.mjs';
import { classify, fold, loadProjects, matchByName, parseExplicitProject } from './projects.mjs';
import { archive, refile, unsortedCount, UNSORTED_ROOT } from './filing.mjs';
import { State } from './state.mjs';

const OPENCLAW_HOME = process.env.WXBRIDGE_OPENCLAW_HOME || join(homedir(), '.openclaw');
const ACCOUNT_ID = process.env.WXBRIDGE_ACCOUNT || '';
const MAX_CONSECUTIVE_FAILURES = 3;
const BACKOFF_MS = 30_000;
const RETRY_MS = 2_000;
const STICKY_TTL_MS = Number(process.env.WXBRIDGE_STICKY_TTL_MS) || 30 * 60_000;
/** 纯文字消息短于这个长度就不当 brief 归档，只回一句提示。 */
const MIN_BRIEF_CHARS = Number(process.env.WXBRIDGE_MIN_BRIEF_CHARS) || 12;

const log = (...args) => console.log(new Date().toISOString(), ...args);
const warn = (...args) => console.warn(new Date().toISOString(), ...args);

/**
 * 凭证优先用 wxbridge 自己扫码存的那份（node login.mjs 会写），
 * 没有才回落到 OpenClaw 官方微信插件那次扫码留下的，这样不用重复登录。
 */
async function loadCredentials() {
  try {
    const own = JSON.parse(await readFile(join(process.env.WXBRIDGE_STATE_DIR || join(homedir(), '.wxbridge'), 'account.json'), 'utf-8'));
    if (own?.token) {
      return { accountId: own.accountId || 'wxbridge', token: own.token, botUserId: own.userId || '' };
    }
  } catch {
    // 没有自己的凭证，走下面的回落
  }
  const dir = join(OPENCLAW_HOME, 'openclaw-weixin', 'accounts');
  let accountId = ACCOUNT_ID;
  if (!accountId) {
    const list = JSON.parse(await readFile(join(OPENCLAW_HOME, 'openclaw-weixin', 'accounts.json'), 'utf-8'));
    accountId = Array.isArray(list) ? list[0] : '';
  }
  if (!accountId) throw new Error('没有找到微信账号，先跑一次 openclaw channels login --channel openclaw-weixin');
  const account = JSON.parse(await readFile(join(dir, `${accountId}.json`), 'utf-8'));
  if (!account?.token) throw new Error(`账号 ${accountId} 里没有 token`);
  return { accountId, token: account.token, botUserId: account.userId || '' };
}

/**
 * 同一个 bot token 只能有一个长轮询消费者。OpenClaw 那边的微信通道要是开着，
 * 两个进程会抢同一份 sync 游标，消息随机丢一半 —— 宁可不启动也不要这种故障。
 */
async function assertNoRivalConsumer() {
  let config;
  try {
    config = JSON.parse(await readFile(join(OPENCLAW_HOME, 'openclaw.json'), 'utf-8'));
  } catch {
    return;
  }
  const entries = config?.plugins?.entries || {};
  const live = ['openclaw-weixin', 'weixin-clawbot'].filter((id) => entries[id]?.enabled === true);
  if (!live.length) return;
  throw new Error(
    `OpenClaw 里的微信通道还开着（${live.join(', ')}），它会和 wxbridge 抢同一个长轮询游标。\n`
    + `先关掉：openclaw config set plugins.entries.${live[0]}.enabled false，然后 openclaw gateway restart`,
  );
}

function projectPathOf(projects, name) {
  return projects[name]?.path || '';
}

/** 回执里显示相对路径，绝对路径太长在手机上看着糟心。 */
function displayDir(dir, projectPath) {
  if (projectPath && dir.startsWith(projectPath)) return relative(projectPath, dir) || '.';
  return dir.replace(homedir(), '~');
}

function helpText() {
  return [
    '把客户的需求和附件转发进来，我按项目归档。',
    '',
    '切到 / 切换到 <项目>　接下来的都归这个项目',
    '改到 <项目>　上一批判错了，就地挪走并记住线索',
    '归档 [项目]　把我刚扣住没存的那条真的存下去',
    '绑定 <关键词> <项目>　教我认一个客户名或品牌词',
    '解绑 <关键词>',
    '项目列表 <关键词>　查名册',
    '状态　看当前项目、已学关键词、待分拣数量',
    '',
    '也可以在消息开头写 #项目名 直接指定。',
  ].join('\n');
}

/**
 * 这条是不是在跟我说话，而不是一份客户 brief。
 * 判错的代价不对称：误存进项目只是脏一条记录，误丢一份真 brief 是丢工作。
 * 所以这里只负责「拿不准就先扣住问一句」，绝不静默丢弃。
 */
export function looksConversational(text) {
  const raw = String(text || '').trim();
  if (!raw) return false;
  if (raw.length > 60) return false;
  const addressesBot = /^(你|您|帮我看|看看|能不能|可以吗|是不是|有没有|测试|试一下)/.test(raw);
  const asksQuestion = /[?？]$|吗[?？]?$|呢[?？]?$|了没[?？]?$/.test(raw);
  return addressesBot && asksQuestion;
}

/** 从这批内容里挑一个最像「客户标识」的词，用于改判时自动学习。 */
function learnableToken(text, fileNames) {
  const source = [text, ...fileNames].join(' ');
  const tokens = source.match(/[一-龥]{2,8}|[A-Za-z][A-Za-z0-9]{3,20}/g) || [];
  const noise = /^(附件|文件|方案|需求|报价|合同|图片|final|version|draft|image|photo|file|copy|微信|转发)$/i;
  const ranked = tokens
    .map((t) => t.trim())
    .filter((t) => t.length >= 2 && !noise.test(t))
    .sort((a, b) => b.length - a.length);
  return ranked[0] || '';
}

export class Bridge {
  constructor({ token, accountId, projects, state }) {
    this.token = token;
    this.accountId = accountId;
    this.projects = projects;
    this.state = state;
    this.owner = process.env.WXBRIDGE_OWNER || '';
  }

  async reply(to, text) {
    try {
      await sendText({ token: this.token, to, text, contextToken: this.state.contextToken(to) });
    } catch (error) {
      warn('回执发送失败:', error.message);
    }
  }

  stickyProject() {
    const sticky = this.state.sticky;
    if (!sticky?.project) return null;
    if (Date.now() - Number(sticky.at || 0) > STICKY_TTL_MS) return null;
    return sticky;
  }

  /**
   * 把「vW 8X这个项目」这种口语写法解析成项目名。
   * 先按整串精确匹配，不中再在串里扫项目名 —— 用户很少只打项目名本身。
   */
  resolveProjectName(input) {
    const raw = String(input || '').trim().replace(/(这个)?项目吧?$|吧$|谢谢$/g, '').trim();
    const wanted = fold(raw);
    if (!wanted) return '';
    for (const project of Object.values(this.projects)) {
      if (fold(project.name) === wanted || fold(project.dirName) === wanted) return project.name;
    }
    const hits = matchByName(wanted, this.projects);
    return hits.length === 1 ? hits[0] : '';
  }

  /** 纯指令消息在这里消化掉，返回 true 表示已处理、不要再走归档。 */
  async handleCommand(from, text) {
    const raw = String(text || '').trim();
    if (!raw) return false;

    if (/^(帮助|help|\/help|\?)$/i.test(raw)) {
      await this.reply(from, helpText());
      return true;
    }

    let match = /^(?:切换到|切换|切到|换到|改用)\s*(.+)$/.exec(raw);
    if (match) {
      const name = this.resolveProjectName(match[1]);
      if (!name) { await this.reply(from, `名册里没有「${match[1].trim()}」。发「项目列表 ${match[1].trim()}」看看接近的。`); return true; }
      await this.state.setSticky(name);
      await this.reply(from, `好，接下来默认归到 ${name}。`);
      return true;
    }

    match = /^(?:改到|改判到|挪到|移到|这是|应该是|不对[，,]?\s*是)\s*(.+)$/.exec(raw);
    if (match) {
      const name = this.resolveProjectName(match[1]);
      if (!name) { await this.reply(from, `名册里没有「${match[1].trim()}」。`); return true; }
      const batch = this.state.lastBatch;
      if (!batch) { await this.reply(from, '没有可改判的上一批。'); return true; }
      const projectPath = projectPathOf(this.projects, name);
      const moved = await refile({ batch, project: name, projectPath });
      await this.state.setSticky(name);
      const token = learnableToken(batch.text || '', (batch.files || []).map((f) => f.name));
      const learned = token ? await this.state.learnAlias(token, name) : false;
      await this.state.setLastBatch({ ...batch, project: name, files: moved.files });
      await this.reply(from, [
        `已改判到 ${name}，挪了 ${moved.files.length} 个文件。`,
        `落点 ${displayDir(moved.dir, projectPath)}`,
        learned ? `记住了：以后看到「${token}」就往 ${name} 放。` : '',
      ].filter(Boolean).join('\n'));
      return true;
    }

    match = /^(?:归档|存档|存下|要归档)\s*(.*)$/.exec(raw);
    if (match) {
      const pending = this.state.pending;
      if (!pending) { await this.reply(from, '没有待确认的内容。'); return true; }
      const forced = match[1].trim() ? this.resolveProjectName(match[1]) : '';
      if (match[1].trim() && !forced) { await this.reply(from, `名册里没有「${match[1].trim()}」。`); return true; }
      await this.state.setPending(null);
      await this.commitArchive(from, {
        text: pending.text,
        attachments: [],
        unsupported: [],
        forcedProject: forced,
      });
      return true;
    }

    match = /^绑定\s+(\S+)\s+(.+)$/.exec(raw);
    if (match) {
      const name = this.resolveProjectName(match[2]);
      if (!name) { await this.reply(from, `名册里没有「${match[2].trim()}」。`); return true; }
      await this.state.learnAlias(match[1], name);
      await this.reply(from, `记住了：「${match[1]}」→ ${name}。`);
      return true;
    }

    match = /^解绑\s+(\S+)$/.exec(raw);
    if (match) {
      const ok = await this.state.forgetAlias(match[1]);
      await this.reply(from, ok ? `已忘掉「${match[1]}」。` : `本来就没有「${match[1]}」。`);
      return true;
    }

    match = /^项目列表\s*(.*)$/.exec(raw);
    if (match) {
      const keyword = match[1].trim().toLowerCase();
      const names = Object.keys(this.projects)
        .filter((name) => !keyword || name.toLowerCase().includes(keyword))
        .sort();
      const head = names.slice(0, 40);
      await this.reply(from, [
        `名册 ${names.length} 个${keyword ? `（匹配「${keyword}」）` : ''}：`,
        head.join('、') || '（没有匹配的）',
        names.length > head.length ? `…还有 ${names.length - head.length} 个，加关键词缩小范围。` : '',
      ].filter(Boolean).join('\n'));
      return true;
    }

    if (/^(状态|status)$/i.test(raw)) {
      const sticky = this.stickyProject();
      const pending = await unsortedCount();
      await this.reply(from, [
        `当前项目：${sticky?.project || '（无，会逐条判断）'}`,
        `已学关键词：${Object.keys(this.state.aliases).length} 个`,
        `待分拣：${pending} 个文件${pending ? `（在 ${UNSORTED_ROOT.replace(homedir(), '~')}）` : ''}`,
        `名册：${Object.keys(this.projects).length} 个项目`,
      ].join('\n'));
      return true;
    }

    return false;
  }

  /** 逐个下载附件；单个失败不影响其它，失败的如实报给用户。 */
  async downloadAll(attachments) {
    const ready = [];
    const failed = [];
    for (const attachment of attachments) {
      try {
        const buffer = await downloadMedia(attachment.media, {
          aesKeyOverride: attachment.aesKeyOverride,
          label: attachment.kind,
        });
        ready.push({ ...attachment, buffer });
      } catch (error) {
        warn('附件下载失败', attachment.fileName, error.message);
        failed.push({ name: attachment.fileName, error: error.message });
      }
    }
    return { ready, failed };
  }

  async handleMessage(msg) {
    const message = normalize(msg);
    const { from } = message;
    if (!from) return;

    if (msg?.context_token) await this.state.setContextToken(from, msg.context_token);

    if (!this.owner) {
      this.owner = from;
      log(`认定主人 = ${from}（想固定可设 WXBRIDGE_OWNER）`);
    }
    if (from !== this.owner) {
      await this.reply(from, '这个助理只服务它的主人。');
      return;
    }

    if (!message.attachments.length && await this.handleCommand(from, message.text)) return;

    const hasContent = message.attachments.length > 0 || message.text.length > 0;
    if (!hasContent) {
      if (message.unsupported.length) {
        await this.reply(from, '这条我接不住（多半是合并转发的聊天记录卡片）。麻烦逐条转发，或者把文字直接粘给我。');
      }
      return;
    }

    // 没附件的短消息不当 brief 归档：微信连上时会自动发「已连接」这类系统提示，
    // 一句「在吗」「收到」也不该在项目里留一份。真正的需求不会这么短。
    if (!message.attachments.length && message.text.length < MIN_BRIEF_CHARS) {
      await this.reply(from, '收到。把客户的需求或者附件转发给我，我按项目归档。回「帮助」看指令。');
      return;
    }

    // 只有纯文字才可能是在跟我说话。带附件的一律照常归档，不打断。
    if (!message.attachments.length && looksConversational(message.text)) {
      await this.state.setPending({ text: message.text, at: Date.now() });
      await this.reply(from, '这条看着像在跟我说话，先没归档。真要存就回「归档」，或者回「归档 <项目>」指定去处。');
      return;
    }

    await this.commitArchive(from, message);
  }

  /** 真正落盘那一段。handleMessage 和「归档」指令都走这里，保证行为一致。 */
  async commitArchive(from, message) {
    const attachments = message.attachments || [];
    const explicit = parseExplicitProject(message.text, this.projects);
    const bodyText = explicit?.rest ?? message.text;
    const fileNames = attachments.map((a) => a.fileName);

    const verdict = message.forcedProject
      ? { project: message.forcedProject, confidence: 1, reason: '你指定的项目', candidates: [] }
      : await classify({
        text: message.text,
        fileNames,
        projects: this.projects,
        aliases: this.state.aliases,
        sticky: this.stickyProject(),
      });

    const { ready, failed } = await this.downloadAll(attachments);

    const projectPath = verdict.project ? projectPathOf(this.projects, verdict.project) : '';
    const result = await archive({
      project: verdict.project,
      projectPath,
      text: bodyText,
      attachments: ready,
      reason: verdict.reason,
      confidence: verdict.confidence,
      unsupported: message.unsupported || [],
    });

    await this.state.setLastBatch({
      project: verdict.project, dir: result.dir, files: result.files,
      text: bodyText, at: Date.now(),
    });
    if (verdict.project) await this.state.setSticky(verdict.project);

    const lines = [];
    if (verdict.project) {
      lines.push(`✅ ${verdict.project}　${displayDir(result.dir, projectPath)}`);
    } else {
      lines.push(`❓ 判不出项目，先放待分拣：${displayDir(result.dir, '')}`);
    }
    if (result.files.length) lines.push(`${result.files.length} 个文件：${result.files.map((f) => f.name).join('、')}`);
    if (failed.length) lines.push(`⚠️ ${failed.length} 个附件没下下来：${failed.map((f) => f.name).join('、')}`);
    if (message.unsupported?.length) lines.push('⚠️ 有内容这个通道接不住，多半是合并转发的聊天记录卡片。');
    if (verdict.project && verdict.confidence < 0.8) lines.push(`依据：${verdict.reason}。不对就回「改到 <项目>」。`);
    if (!verdict.project && verdict.candidates.length) lines.push(`像这几个：${verdict.candidates.join('、')}。回「改到 <项目>」定一下。`);
    if (!verdict.project && !verdict.candidates.length) lines.push('回「改到 <项目>」告诉我该归哪，我会记住这次的线索。');

    await this.reply(from, lines.join('\n'));
    log(`归档 project=${verdict.project || '_unsorted'} files=${result.files.length} conf=${verdict.confidence}`);
  }

  async run(signal) {
    let failures = 0;
    let timeoutMs = 35_000;
    while (!signal.aborted) {
      try {
        const resp = await getUpdates({ token: this.token, buf: this.state.syncBuf, timeoutMs, signal });
        if (resp.longpolling_timeout_ms > 0) timeoutMs = resp.longpolling_timeout_ms;

        const apiError = (resp.ret && resp.ret !== 0) || (resp.errcode && resp.errcode !== 0);
        if (apiError) {
          if (resp.errcode === STALE_TOKEN_ERRCODE || resp.ret === STALE_TOKEN_ERRCODE) {
            throw new Error('微信会话已过期，需要重新扫码：openclaw channels login --channel openclaw-weixin');
          }
          failures += 1;
          warn(`getUpdates ret=${resp.ret} errcode=${resp.errcode} errmsg=${resp.errmsg || ''} (${failures}/${MAX_CONSECUTIVE_FAILURES})`);
          await sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_MS, signal);
          if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
          continue;
        }

        failures = 0;
        if (resp.get_updates_buf) await this.state.setSyncBuf(resp.get_updates_buf);

        for (const msg of resp.msgs || []) {
          const id = msg?.message_id || `${msg?.from_user_id}-${msg?.seq}-${msg?.create_time_ms}`;
          if (this.state.seenBefore(id)) continue;
          await this.state.markSeen(id);
          try {
            await this.handleMessage(msg);
          } catch (error) {
            warn('处理消息失败:', error.stack || error.message);
          }
        }
      } catch (error) {
        if (signal.aborted) return;
        if (/会话已过期/.test(error.message)) throw error;
        failures += 1;
        warn(`长轮询出错 (${failures}/${MAX_CONSECUTIVE_FAILURES}):`, error.message);
        await sleep(failures >= MAX_CONSECUTIVE_FAILURES ? BACKOFF_MS : RETRY_MS, signal);
        if (failures >= MAX_CONSECUTIVE_FAILURES) failures = 0;
      }
    }
  }
}

function sleep(ms, signal) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(timer); resolve(); }, { once: true });
  });
}

export async function main() {
  await assertNoRivalConsumer();
  const { accountId, token } = await loadCredentials();
  const projects = await loadProjects();
  const state = new State();
  await state.load();

  // 换了账号（重新扫过码）之后，旧 token 那条流的游标和已读记录都作废，
  // 继续拿去请求会被服务端当成非法游标，必须清掉重新开始。
  if (state.data.accountId && state.data.accountId !== accountId) {
    log(`账号从 ${state.data.accountId} 换成 ${accountId}，清掉旧游标重新开始`);
    state.data.syncBuf = '';
    state.data.seen = [];
  }
  state.data.accountId = accountId;
  await state.save();

  log(`wxbridge 启动 account=${accountId} 名册=${Object.keys(projects).length} 个项目`);
  if (!state.syncBuf) log('没有历史游标，从现在起的新消息开始收');

  const controller = new AbortController();
  const stop = async () => {
    controller.abort();
    try { await notifyStop({ token }); } catch { /* 退出路径上不值得报错 */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  try { await notifyStart({ token }); } catch (error) { warn('notifyStart 失败（不影响收消息）:', error.message); }

  const bridge = new Bridge({ token, accountId, projects, state });
  await bridge.run(controller.signal);
}

if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    console.error(error.message);
    process.exit(1);
  });
}
