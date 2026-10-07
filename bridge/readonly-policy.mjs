import { readFileSync } from 'node:fs';

const READONLY_TOOLS = new Set([
  'Read', 'Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch',
  'TodoRead', 'TodoWrite', 'NotebookRead', 'Task', 'Agent',
]);

const DANGEROUS_RULES = [
  ['命令替换', /`|\$\(/],
  ['输出重定向', />/],
  ['rm', /(^|[^\w])rm([^\w]|$)/i],
  ['sudo', /(^|[^\w])sudo([^\w]|$)/i],
  ['mkfs', /(^|[^\w])mkfs(?:\.[\w-]+)?([^\w]|$)/i],
  ['dd', /(^|[^\w])dd([^\w]|$)/i],
  ['tee', /(^|[^\w])tee([^\w]|$)/i],
  ['mv', /(^|[^\w])mv([^\w]|$)/i],
  ['cp -f', /(^|[^\w])cp\s+(?:-[^\s]*f(?:\s|$)|--force(?:\s|$))/i],
  ['chmod', /(^|[^\w])chmod([^\w]|$)/i],
  ['chown', /(^|[^\w])chown([^\w]|$)/i],
  ['kill', /(^|[^\w])kill([^\w]|$)/i],
  ['pkill', /(^|[^\w])pkill([^\w]|$)/i],
  ['launchctl', /(^|[^\w])launchctl([^\w]|$)/i],
  ['npm install', /(^|[^\w])npm\s+install(?:\s|$)/i],
  ['pip install', /(^|[^\w])pip(?:3)?\s+install(?:\s|$)/i],
  ['curl 写请求', /(^|[^\w])curl\b[\s\S]*?(?:-X|--request)\s*(?:POST|PUT|DELETE)(?:\s|$)/i],
  ['git push', /(^|[^\w])git\s+push(?:\s|$)/i],
  ['git reset', /(^|[^\w])git\s+reset(?:\s|$)/i],
];

const SIMPLE_READ_COMMAND = /^(?:ls|cat|head|tail|grep|pwd|echo|printf|wc|stat|du|df|ps|pgrep|which|whoami|file|sort)(?:\s+[\s\S]*)?$/;
const SAFE_PM2 = /^pm2\s+(?:list|ls|logs|status)(?:\s+[\s\S]*)?$/;
const SAFE_GIT = /^git\s+(?:status|log|diff|show)(?:\s+[\s\S]*)?$/;
const SAFE_NPM = /^npm\s+(?:ls|list|view)(?:\s+[\s\S]*)?$|^npm\s+test$/;
const SAFE_NODE = /^node\s+--version$/;
const SAFE_DATE = /^date(?:\s+-u)?(?:\s+\+\S+)?$/;
const SAFE_ENV = /^env$/;

function dangerousReason(command) {
  for (const [reason, pattern] of DANGEROUS_RULES) {
    if (pattern.test(command)) return reason;
  }
  return '';
}

function splitCompound(command) {
  const parts = [];
  let current = '';
  let quote = '';
  let escaped = false;
  const push = () => {
    const value = current.trim();
    if (!value) return false;
    parts.push(value);
    current = '';
    return true;
  };
  for (let index = 0; index < command.length; index += 1) {
    const char = command[index];
    if (escaped) { current += char; escaped = false; continue; }
    if (char === '\\' && quote !== "'") { current += char; escaped = true; continue; }
    if (quote) {
      current += char;
      if (char === quote) quote = '';
      continue;
    }
    if (char === "'" || char === '"') { quote = char; current += char; continue; }
    if (char === '\n' || char === ';') {
      if (!push()) return null;
      continue;
    }
    if (char === '&') {
      if (command[index + 1] !== '&') return null;
      if (!push()) return null;
      index += 1;
      continue;
    }
    if (char === '|') {
      if (!push()) return null;
      if (command[index + 1] === '|' || command[index + 1] === '&') index += 1;
      continue;
    }
    current += char;
  }
  if (escaped || quote || !push()) return null;
  return parts;
}

function hasAnyToken(command, patterns) {
  return patterns.some((pattern) => pattern.test(command));
}

function isSafeFind(command) {
  if (!/^find(?:\s+[\s\S]*)?$/.test(command)) return false;
  return !hasAnyToken(command, [
    /(?:^|\s)-(?:exec|execdir|ok|okdir|delete|fls|fprint|fprint0|fprintf)(?:\s|$)/,
  ]);
}

function isSafeFd(command) {
  if (!/^fd(?:\s+[\s\S]*)?$/.test(command)) return false;
  return !hasAnyToken(command, [/(?:^|\s)(?:-x|-X|--exec|--exec-batch)(?:\s|=|$)/]);
}

function isSafeRg(command) {
  if (!/^rg(?:\s+[\s\S]*)?$/.test(command)) return false;
  return !hasAnyToken(command, [/(?:^|\s)--pre(?:\s|=|$)/]);
}

function isSafeGit(command) {
  if (/^git\s+branch$/.test(command)) return true;
  if (/^git\s+branch\s+(?:-a|-r|-v|-vv|--list|--show-current)$/.test(command)) return true;
  if (!SAFE_GIT.test(command)) return false;
  return !hasAnyToken(command, [
    /(?:^|\s)--output(?:\s|=|$)/,
    /(?:^|\s)--ext-diff(?:\s|=|$)/,
    /(?:^|\s)--textconv(?:\s|=|$)/,
  ]);
}

function isBuiltinReadonlySegment(segment) {
  if (SIMPLE_READ_COMMAND.test(segment)) {
    if (/^file(?:\s|$)/.test(segment) && /(?:^|\s)(?:-C|--compile)(?:\s|$)/.test(segment)) return false;
    return true;
  }
  return SAFE_PM2.test(segment)
    || isSafeGit(segment)
    || SAFE_NPM.test(segment)
    || SAFE_NODE.test(segment)
    || SAFE_DATE.test(segment)
    || SAFE_ENV.test(segment)
    || isSafeFind(segment)
    || isSafeFd(segment)
    || isSafeRg(segment);
}

function loadExtensions(path, log) {
  if (!path) return { tools: [], patterns: [] };
  try {
    const value = JSON.parse(readFileSync(path, 'utf8'));
    const tools = Array.isArray(value.tools) ? value.tools.map(String).filter(Boolean) : [];
    const patterns = [];
    for (const source of Array.isArray(value.bashPatterns) ? value.bashPatterns : []) {
      const text = String(source);
      if (!text.startsWith('^') || !text.endsWith('$')) {
        log?.warn?.('忽略未完整锚定的 readonly bashPatterns', text);
        continue;
      }
      try { patterns.push(new RegExp(text)); } catch (error) { log?.warn?.('忽略无效 readonly 正则', error.message); }
    }
    return { tools, patterns };
  } catch (error) {
    if (error?.code !== 'ENOENT') log?.warn?.('readonly-allow.json 读取失败', error.message);
    return { tools: [], patterns: [] };
  }
}

export function createReadonlyPolicy({ configPath = '', log = console } = {}) {
  const extension = loadExtensions(configPath, log);
  const tools = new Set([...READONLY_TOOLS, ...extension.tools]);
  return {
    evaluate(toolName, input = {}) {
      const name = String(toolName || '');
      if (tools.has(name)) return { allowed: true, summary: name, reason: '只读工具' };
      if (name !== 'Bash') return { allowed: false, summary: name || '未知工具', reason: '非只读工具' };
      const command = typeof input.command === 'string' ? input.command.trim() : '';
      if (!command) return { allowed: false, summary: 'Bash（无命令）', reason: '缺少命令' };
      const danger = dangerousReason(command);
      if (danger) return { allowed: false, summary: `Bash ${command.slice(0, 120)}`, reason: `危险否决:${danger}` };
      if (command.includes('<')) return { allowed: false, summary: `Bash ${command.slice(0, 120)}`, reason: '不确定的输入/进程重定向' };
      const segments = splitCompound(command);
      if (!segments?.length) return { allowed: false, summary: `Bash ${command.slice(0, 120)}`, reason: '无法安全解析复合命令' };
      const unknown = segments.find((segment) => !isBuiltinReadonlySegment(segment) && !extension.patterns.some((pattern) => pattern.test(segment)));
      if (unknown) return { allowed: false, summary: `Bash ${command.slice(0, 120)}`, reason: `未知只读段:${unknown.slice(0, 80)}` };
      return { allowed: true, summary: `Bash ${command.slice(0, 120)}`, reason: `只读 ${segments.length} 段` };
    },
  };
}

