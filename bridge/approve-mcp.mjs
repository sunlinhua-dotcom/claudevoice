#!/usr/bin/env node
import { createInterface } from 'node:readline';

const port = Number(process.env.CC_APPROVAL_PORT) || 18791;
const token = process.env.CC_APPROVAL_TOKEN || '';
const taskId = process.env.CC_BRIDGE_TASK_ID || '';
const approvalTimeoutMs = Number(process.env.CC_APPROVAL_TIMEOUT_MS) || 10 * 60_000;
const askTimeoutMs = Number(process.env.CC_ASK_TIMEOUT_MS) || 15 * 60_000;

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function result(id, value) { send({ jsonrpc: '2.0', id, result: value }); }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }); }

async function postBridge(path, body, timeoutMs) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify({ taskId, ...body }),
    signal: AbortSignal.timeout(timeoutMs + 5000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || `交互服务 HTTP ${response.status}`);
  return value;
}

async function askBridgePermission(args) {
  const toolName = args.tool_name || args.toolName || args.name || '未知工具';
  const input = args.input || args.tool_input || args.toolInput || {};
  try {
    const value = await postBridge('/permission', { toolName, input }, approvalTimeoutMs);
    if (value.behavior === 'allow') return { behavior: 'allow', updatedInput: value.updatedInput ?? input };
    return { behavior: 'deny', message: value.message || '审批被拒绝' };
  } catch (requestError) {
    return { behavior: 'deny', message: `无法连接 cc-bridge 审批服务：${requestError.message}` };
  }
}

async function askBridgeUser(args) {
  try {
    return await postBridge('/ask-user', {
      question: args.question,
      options: args.options,
      allow_custom: args.allow_custom !== false,
    }, askTimeoutMs);
  } catch (requestError) {
    return { answer: `ask_user 无法连接 cc-bridge：${requestError.message}`, failed: true };
  }
}

async function handle(message) {
  const { id, method, params = {} } = message || {};
  if (method === 'initialize') {
    return result(id, {
      protocolVersion: params.protocolVersion || '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'cc-bridge-approval', version: '0.1.0' },
    });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') return;
  if (method === 'ping') return result(id, {});
  if (method === 'tools/list') {
    return result(id, {
      tools: [{
        name: 'permission_prompt',
        description: '向 BRIGHT 请求是否允许 Claude Code 工具调用。',
        inputSchema: {
          type: 'object',
          properties: {
            tool_name: { type: 'string' },
            input: { type: 'object', additionalProperties: true },
          },
          required: ['tool_name', 'input'],
          additionalProperties: true,
        },
      }, {
        name: 'ask_user',
        description: '遇到需要 BRIGHT 拍板的多选决策时，在飞书主聊天流发送选项卡并等待答案。',
        inputSchema: {
          type: 'object',
          properties: {
            question: { type: 'string' },
            options: { type: 'array', minItems: 2, maxItems: 6, items: { type: 'string' } },
            allow_custom: { type: 'boolean' },
          },
          required: ['question', 'options'],
          additionalProperties: false,
        },
      }],
    });
  }
  if (method === 'tools/call') {
    if (params.name === 'permission_prompt') {
      const decision = await askBridgePermission(params.arguments || {});
      return result(id, { content: [{ type: 'text', text: JSON.stringify(decision) }], isError: false });
    }
    if (params.name === 'ask_user') {
      const answer = await askBridgeUser(params.arguments || {});
      return result(id, { content: [{ type: 'text', text: answer.answer || '用户未回应，请按你的最佳判断继续' }], isError: false });
    }
    return error(id, -32602, `未知工具：${params.name}`);
  }
  if (id !== undefined) return error(id, -32601, `未知方法：${method}`);
}

const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
lines.on('line', (line) => {
  let message;
  try { message = JSON.parse(line); } catch { return; }
  Promise.resolve(handle(message)).catch((cause) => error(message.id, -32603, cause.message));
});
