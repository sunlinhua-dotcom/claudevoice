// 播报话术层：把「名字怎么念、句子怎么说、音色怎么分」这一整套纯逻辑集中到一处。
//
// 为什么单独一个文件：这层原本在 server.js（自托管入口）和 cloudflare/src/worker.js
// （线上真实链路）里各有一份，19 个同名函数里 15 个已经悄悄漂移，且两边都没有测试。
// 现在两端 + hook.js 共用这一份，node:test 只测这一个文件。
//
// 硬约束：**这里不许有任何 I/O、env、fs、fetch、全局状态**。
// 纯函数才能同时跑在 Node（CommonJS）和 Cloudflare Workers（esbuild 打包 ESM）里。
// 与宿主相关的部分（读 names.json、Workers AI 总结、Durable Object 热改读音表）留在各自宿主。
//
// 文件名用 .cjs 而不是 .js：即便将来根 package.json 加了 "type": "module"，
// server.js / hook.js 的 require 也不会跟着炸。

// ============================ 音色 ============================
// 只用中文音色（英文音色 Dean/Mia/Chloe/Milo 读中文会变乱码）。保留男女区分。
const VOICE_POOL = [
  { name: '茉莉', gender: 'f' }, { name: '白桦', gender: 'm' },
  { name: '冰糖', gender: 'f' }, { name: '苏打', gender: 'm' },
];
const VOICE_GENDER = VOICE_POOL.reduce((m, v) => (m[v.name] = v.gender, m), {});

// ============================ 名字怎么念 ============================
// 全大写连写常见词（Title 化）与缩写（逐字母拼读），用来切 DEVGX10 / DOCSORG 这类没有大小写边界的名字。
const CAPS_ACRONYMS = ['AI','API','CLI','CSS','DNS','ERP','GPT','GPU','HTML','HTTP','JSON','LLM','OCR','PDF','PPT','SDK','SEO','SQL','SSH','SVG','TTS','UI','URL','VPN','XML'];
const CAPS_WORDS = ['ACER','ANDROID','APP','APPLE','AUTO','BETA','BIRD','CANVAS','CHINA','CLOUD','CUT','DEMO','DESIGN','DEV','DOCS','EDGE','FAKE','FOOD','GAME','GEO','GITHUB','HOME','HOUSE','HUB','IMAGE','INTRO','LAB','LIB','LIVE','MAIL','MEDIA','MENU','MINI','MOBILE','MONEY','MUSIC','NEWS','NEXT','NOTE','OPEN','ORG','PAGE','PHONE','PHOTO','PLAN','PLUS','PRO','PROJECT','REPORT','RESEARCH','SHOP','SITE','SKILLS','SMART','SOCIAL','STORE','STUDIO','TEAM','TECH','TEMP','TEST','TILE','TOOL','VIDEO','VIEW','VOICE','WEB','WORK'];
const CAPS_DICT = [...CAPS_ACRONYMS, ...CAPS_WORDS].sort((a, b) => b.length - a.length);

function titleCase(w) { return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase(); }
function spellOut(w) { return w.split('').join(' '); }

// 一个碎片怎么念：词典里的词 Title 化，缩写逐字母拼读；
// 剩下的看长相——太短或不含元音的当缩写拼读，否则按词读。
function renderPiece(t) {
  if (CAPS_WORDS.includes(t)) return titleCase(t);
  if (CAPS_ACRONYMS.includes(t)) return spellOut(t);
  if (t.length <= 4 || !/[AEIOU]/.test(t)) return spellOut(t);
  return titleCase(t);
}

// 把一段全大写连写按词典贪婪切开；单字母碎片并回上一段，避免把 NEWS 切成 NEW S。
function speakCapsRun(run) {
  if (CAPS_WORDS.includes(run) || CAPS_ACRONYMS.includes(run)) return renderPiece(run);
  const parts = [];
  let i = 0;
  while (i < run.length) {
    const hit = CAPS_DICT.find((w) => run.startsWith(w, i));
    if (hit) { parts.push(hit); i += hit.length; continue; }
    let j = i + 1;
    while (j < run.length && !CAPS_DICT.some((w) => run.startsWith(w, j))) j++;
    parts.push(run.slice(i, j));
    i = j;
  }
  const merged = [];
  for (const t of parts) {
    if (t.length === 1 && merged.length) merged[merged.length - 1] += t;
    else merged.push(t);
  }
  return merged.map(renderPiece).join(' ');
}

// 中英文之间补半角空格，念起来不会黏连。
// 取 server.js 那份的 String(s) 兜底：worker.js 那份传 null 会直接抛，而 humanizeName
// 的调用点确实可能拿到 undefined（`spaceCJK(o.say || o.name || …)`）。
function spaceCJK(s) {
  return String(s == null ? '' : s)
    .replace(/([一-鿿])([A-Za-z0-9])/g, '$1 $2')
    .replace(/([A-Za-z0-9])([一-鿿])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim();
}

// 文件夹名 → 可读文本。含中文直接返回；纯拉丁按分隔符/驼峰/数字边界拆，全大写段再进词典切分。
function humanizeName(key) {
  const raw = (key || '').toString();
  if (!raw) return key;
  if (/[一-鿿]/.test(raw)) return spaceCJK(raw);
  const rough = raw
    .replace(/[_\-.]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([A-Za-z])(\d)/g, '$1 $2')
    .replace(/(\d)([A-Za-z])/g, '$1 $2')
    .replace(/\s+/g, ' ').trim();
  if (!rough) return key;
  return rough
    .split(' ')
    .map((t) => (/^[A-Z]{2,}$/.test(t) ? speakCapsRun(t) : t))
    .join(' ')
    .replace(/\s+/g, ' ').trim() || key;
}

// 工具名也拆驼峰，方便英文读对：WebFetch → Web Fetch
function sayTool(t) { return humanizeName(t || ''); }

// ============================ 通用小工具 ============================
function pick(a) { return a[Math.floor(Math.random() * a.length)]; }
function hashStr(s) { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0; return h; }
function baseName(p) { if (!p) return ''; return p.replace(/[\/\\]+$/, '').split(/[\/\\]/).pop(); }
function clip(s, n) { s = (s || '').toString(); return s.length > n ? s.slice(0, n) + '…' : s; }

// 项目按名字 hash 稳定分到一个音色；projects.json / 热改表里的 "voice" 可覆盖。
// 取 server.js 那份的语义：**任何 override 都认**，不在内置池里的按 'f' 处理。
// 云端安全性由 resolveVoiceEdge 兜底——它只放行 EDGE_VOICE_MAP 里的名字或 zh-CN-XxxNeural
// 形状的串，其余退回 XiaoxiaoNeural，所以认下未知音色不会让合成失败。
// （worker.js 原来是静默丢弃未知 override，导致同一份 projects.json 本地和云端念出不同音色。）
function assignVoice(projectKey, override) {
  if (override) return { name: override, gender: VOICE_GENDER[override] || 'f' };
  return VOICE_POOL[hashStr(String(projectKey || '')) % VOICE_POOL.length];
}

// ============================ 内容清洗与摘要 ============================
// 中文为主判定（翻译在 hook.js / Mac 端做；Cloudflare IP 调 Google 翻译会被 429，故云端不翻）
function isMostlyChinese(s) {
  const cjk = (String(s).match(/[一-鿿]/g) || []).length;
  const latin = (String(s).match(/[A-Za-z]/g) || []).length;
  return cjk >= Math.max(4, latin);
}

// 把总结清洗成适合朗读的纯文本，按句子边界裁到 maxLen
function cleanForSpeech(text, maxLen) {
  const s = (text || '').toString()
    .replace(/```[\s\S]*?```/g, ' ')            // 去代码块
    .replace(/`[^`]*`/g, ' ')                   // 去行内代码
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')  // 链接/图片留文字
    .replace(/[*_#>~|]/g, ' ')                  // 去 markdown 记号
    .replace(/^[\s\-•\d.]+/gm, '')              // 去列表/序号前缀
    .replace(/\s+/g, ' ')
    .trim();
  if (s.length <= maxLen) return s;
  const cut = s.slice(0, maxLen);
  const lp = Math.max(cut.lastIndexOf('。'), cut.lastIndexOf('！'), cut.lastIndexOf('？'), cut.lastIndexOf('.'), cut.lastIndexOf('，'));
  return (lp > maxLen * 0.5 ? cut.slice(0, lp + 1) : cut) + '……';
}

const DECISION_RE = /[?？]|是否|还是|要不要|需不需要|需要你|请你确认|请确认|建议|你来定|你决定|你看|选择|二选一|哪一个|哪个|可以吗|对吗|要不/;

// 从最后回复里抽「适合朗读的总结」：按整句累加到 maxLen，结论在前、需要定夺的句子保证念到，
// 永远在句子边界收尾（不切半句、不拖省略号），解决「念一小段突然没了」。
function pickSummary(detail, maxLen) {
  const t = cleanForSpeech(detail || '', 2000);
  if (!t) return '';
  const sents = t.split(/(?<=[。！？!?])/).map((s) => s.trim()).filter(Boolean);
  if (!sents.length) return '';
  let out = '';
  for (const s of sents) {
    if (out.length + s.length > maxLen && out.length > 0) break;
    out += s;
  }
  if (!out) { // 第一句就超长：截到最后一个标点，补句号正常收尾
    const s = sents[0].slice(0, maxLen);
    const lp = Math.max(s.lastIndexOf('，'), s.lastIndexOf('。'), s.lastIndexOf('、'), s.lastIndexOf('；'));
    out = (lp > maxLen * 0.5 ? s.slice(0, lp) : s) + '。';
  }
  const dec = sents.find((s) => DECISION_RE.test(s)); // 需要你定夺的那句通常在结尾，确保念到
  if (dec && out.indexOf(dec) < 0 && out.length + dec.length <= maxLen + 80) out += dec;
  return out;
}

function capSpeech(s, n) {
  s = (s || '').trim(); if (s.length <= n) return s;
  const c = s.slice(0, n);
  const lp = Math.max(c.lastIndexOf('。'), c.lastIndexOf('！'), c.lastIndexOf('？'), c.lastIndexOf('，'));
  return (lp > n * 0.5 ? c.slice(0, lp + 1) : c) + '……';
}

// ============================ 句子怎么说 ============================
// 统一格式：称呼 + 目录名 + 任务状态 + 具体描述。
// 称呼由宿主算好传进来（本地读 projects.json，云端读 env.USER_ALIASES），这里只负责选词造句。

// 提醒类播报（等输入 / 要授权 / 子任务 / 普通消息）
function buildAlertSpeak(kind, addresses, proj, tool) {
  const g = `${pick(addresses)}，`;
  const P = {
    waiting: [
      `${g}目录 ${proj} 正在等你输入，回去看一下吧。`,
      `${g}${proj} 这边停下来，等你回话了。`,
    ],
    permission: tool ? [
      `${g}目录 ${proj} 需要你授权使用 ${tool}。`,
      `${g}${proj} 想动用 ${tool}，等你点头。`,
    ] : [
      `${g}目录 ${proj} 需要你确认一下。`,
    ],
    subagent: [`${g}${proj} 有一个子任务完成了。`],
    notification: [`${g}${proj} 有一条新消息，留意一下。`],
  };
  return pick(P[kind] || P.notification);
}

// 完成类·拿不到中文摘要时的定型句（绝不念英文原文）
function doneFallback(addresses, proj) {
  const g = `${pick(addresses)}，`;
  return pick([
    `${g}目录 ${proj} 的任务已经完成，回来看看结果吧。`,
    `${g}${proj} 这一轮完成了，记得验收。`,
  ]);
}

// 完成类·有中文摘要时
function doneWithSummary(addresses, proj, sum) {
  return `${pick(addresses)}，目录 ${proj} 的任务完成了。具体是，${sum}`;
}

// 风格指令保持简短：越短越干净，过长会被 TTS 当成内容念进去导致乱码
function buildStyle(_kind) {
  return pick(['语气自然亲切。', '语气干练利落。', '温柔地提醒。', '沉稳地说。', '稍微轻快一点。', '带一点期待。']);
}

// "Claude needs your permission to use Bash" → "Bash"
function extractTool(msg) {
  const m = /use\s+([A-Za-z0-9_\- ]+?)(?:[\.\(]|$)/i.exec(msg);
  return m ? m[1].trim() : '';
}

module.exports = {
  VOICE_POOL, VOICE_GENDER, CAPS_ACRONYMS, CAPS_WORDS, CAPS_DICT, DECISION_RE,
  titleCase, spellOut, renderPiece, speakCapsRun, spaceCJK, humanizeName, sayTool,
  pick, hashStr, baseName, clip, assignVoice,
  isMostlyChinese, cleanForSpeech, pickSummary, capSpeech,
  buildAlertSpeak, doneFallback, doneWithSummary, buildStyle, extractTool,
};
