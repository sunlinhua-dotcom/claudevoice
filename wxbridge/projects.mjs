/**
 * projects.mjs — 项目名册与「这条 brief 属于哪个项目」的判定。
 *
 * 名册直接复用 cc-bridge 的 bridge/projects.json，两边永远是同一份，
 * 不另立一套项目清单。
 */
import { readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';

const LOCAL_MODEL_URL = process.env.WXBRIDGE_MODEL_URL
  || 'http://127.0.0.1:18790/v1/chat/completions';
const LOCAL_MODEL = process.env.WXBRIDGE_MODEL || 'openai/gpt-5.6-sol';

export const UNSORTED = '_unsorted';

export async function loadProjects(file = join(import.meta.dirname, '..', 'bridge', 'projects.json')) {
  const raw = JSON.parse(await readFile(file, 'utf-8'));
  const projects = {};
  for (const [name, value] of Object.entries(raw)) {
    if (!value?.path) continue;
    projects[name] = { name, path: value.path, dirName: basename(value.path) };
  }
  return projects;
}

/** 归一化：去空白、小写、全角转半角，让 "HEAT INS" 和 "heatins" 能对上。 */
export function fold(input) {
  return String(input || '')
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xFEE0))
    .toLowerCase()
    .replace(/[\s_\-./\\]+/g, '');
}

/** 名字太短的项目（cc / anti 之类）容易误命中，要求更强的证据。 */
const SHORT_NAME_LIMIT = 4;

export function matchByName(haystack, projects) {
  const hits = new Set();
  for (const project of Object.values(projects)) {
    for (const candidate of [project.name, project.dirName]) {
      const needle = fold(candidate);
      if (needle.length < 2) continue;
      if (needle.length <= SHORT_NAME_LIMIT) {
        // 短名要求词边界，避免 "cc" 命中 "success"
        const re = new RegExp(`(^|[^a-z0-9])${needle}([^a-z0-9]|$)`);
        if (re.test(haystack)) hits.add(project.name);
      } else if (haystack.includes(needle)) {
        hits.add(project.name);
      }
    }
  }
  return [...hits];
}

function matchByAlias(haystack, aliases) {
  const hits = new Set();
  for (const [alias, project] of Object.entries(aliases || {})) {
    const needle = fold(alias);
    if (needle.length >= 2 && haystack.includes(needle)) hits.add(project);
  }
  return [...hits];
}

/** 显式指定：#heatins / 切到 heatins / 归到 heatins / 存到 heatins。 */
export function parseExplicitProject(text, projects) {
  const raw = String(text || '').trim();
  const patterns = [
    /^#\s*([A-Za-z0-9_\-. ]{2,40})\b/,
    /^(?:切到|归到|存到|放到|归档到|发到)\s*([A-Za-z0-9_\-. 一-龥]{2,40})/,
  ];
  for (const pattern of patterns) {
    const match = pattern.exec(raw);
    if (!match) continue;
    const wanted = fold(match[1]);
    for (const project of Object.values(projects)) {
      if (fold(project.name) === wanted || fold(project.dirName) === wanted) {
        return { project: project.name, rest: raw.slice(match[0].length).trim() };
      }
    }
    // 指定了但名字对不上，也要报出来，别当没看见
    return { project: '', rest: raw, unknown: match[1].trim() };
  }
  return null;
}

async function askLocalModel(text, fileNames, projects, timeoutMs = 25_000) {
  const roster = Object.values(projects).map((p) => p.name).join(', ');
  const body = {
    model: LOCAL_MODEL,
    max_tokens: 24,
    messages: [{
      role: 'user',
      content: [
        '下面是一条客户在微信里发来的需求或附件。判断它属于哪个项目。',
        `可选项目（只能从中选一个）：${roster}`,
        '',
        `消息正文：${text || '(无)'} `,
        `附件文件名：${fileNames.join(', ') || '(无)'} `,
        '',
        '规则：只有当消息里出现了客户名、品牌名、产品线或项目代号这类明确线索时才给答案。',
        '如果这条只是在跟助理说话、提问、寒暄，或者只有「项目」「目录」「文件」这种泛指词，一律输出 NONE。',
        '宁可输出 NONE，也不要猜。只输出项目名本身，不要任何解释。',
      ].join('\n'),
    }],
  };
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(LOCAL_MODEL_URL, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body), signal: ac.signal,
    });
    if (!res.ok) return '';
    const data = await res.json();
    const answer = fold(data?.choices?.[0]?.message?.content || '');
    if (!answer || answer === 'none') return '';
    for (const project of Object.values(projects)) {
      if (fold(project.name) === answer || fold(project.dirName) === answer) return project.name;
    }
    return '';
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 判定归属项目。按证据强度从硬到软依次尝试，谁先命中用谁。
 * 返回的 confidence 决定回执要不要追问，reason 用来在回执里说清依据。
 */
export async function classify({ text, fileNames = [], projects, aliases = {}, sticky = null, useModel = true }) {
  const explicit = parseExplicitProject(text, projects);
  if (explicit?.project) {
    return { project: explicit.project, confidence: 1, reason: '你在消息里指定了项目', rest: explicit.rest, candidates: [] };
  }
  if (explicit?.unknown) {
    return { project: '', confidence: 0, reason: `名册里没有「${explicit.unknown}」这个项目`, rest: explicit.rest, candidates: [] };
  }

  const haystack = fold([text, ...fileNames].join(' '));

  const aliasHits = matchByAlias(haystack, aliases);
  if (aliasHits.length === 1) {
    return { project: aliasHits[0], confidence: 0.9, reason: '命中你教过的关键词', rest: text, candidates: [] };
  }

  const nameHits = matchByName(haystack, projects);
  const merged = [...new Set([...aliasHits, ...nameHits])];
  if (merged.length === 1) {
    return { project: merged[0], confidence: 0.85, reason: '正文或文件名里出现了项目名', rest: text, candidates: [] };
  }
  if (merged.length > 1) {
    return { project: '', confidence: 0, reason: '同时像好几个项目', rest: text, candidates: merged.slice(0, 5) };
  }

  // 沿用必须排在模型前面：你刚说过归哪个项目，那就是最强的意图信号，
  // 不能让模型看到「项目」「目录」这类词就瞎猜一个盖掉它。
  if (sticky?.project) {
    return { project: sticky.project, confidence: 0.7, reason: '沿用你刚指定的项目', rest: text, candidates: [] };
  }

  if (useModel) {
    const guess = await askLocalModel(text, fileNames, projects);
    if (guess) {
      return { project: guess, confidence: 0.6, reason: '本地模型根据内容推断', rest: text, candidates: [] };
    }
  }

  return { project: '', confidence: 0, reason: '没有任何线索指向某个项目', rest: text, candidates: [] };
}
