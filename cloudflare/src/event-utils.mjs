const BRIDGE_KINDS = new Set(['notification', 'permission', 'done', 'failed']);

export function normalizeBridgePayload(payload) {
  if (payload?.source !== 'bridge' || !BRIDGE_KINDS.has(payload.kind)) return null;
  return {
    id: payload.id || crypto.randomUUID().replace(/-/g, '').slice(0, 16),
    ts: Number(payload.ts) || Date.now(),
    kind: payload.kind,
    needsAction: payload.kind === 'permission',
    silent: false,
    noLark: Boolean(payload.noLark),
    noNotify: Boolean(payload.noNotify),
    source: 'bridge',
    project: String(payload.project || payload.projectKey || 'unknown'),
    projectKey: String(payload.projectKey || payload.project || 'unknown'),
    cwd: String(payload.cwd || ''),
    color: payload.color || null,
    voice: payload.voice || '', gender: payload.gender || '', style: payload.style || '语气自然。',
    title: String(payload.title || '指挥台事件'),
    detail: String(payload.detail || payload.message || '').slice(0, 1000),
    speak: String(payload.speak || `${payload.project || '项目'}：${payload.title || '指挥台事件'}`),
    rawMessage: String(payload.message || ''),
    sessionId: String(payload.sessionId || payload.session_id || ''),
    taskId: String(payload.taskId || ''),
    taskNumber: Number(payload.taskNumber) || 0,
  };
}

export function deliveryPlan(event) {
  if (event?.noNotify) return [];
  const plan = ['push', 'telegram'];
  if (!event?.noLark) plan.push('lark');
  return plan;
}
