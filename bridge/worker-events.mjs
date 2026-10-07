const STAGES = {
  start: { kind: 'notification', title: '任务开始' },
  permission: { kind: 'permission', title: '等待审批' },
  done: { kind: 'done', title: '任务完成' },
  failed: { kind: 'failed', title: '任务失败' },
};

export function buildBridgeEvent(stage, task, extra = {}) {
  const mapped = STAGES[stage] || STAGES.start;
  const defaults = {
    start: `#${task.number} 已进入 Claude Code 执行`,
    permission: `#${task.number} 需要确认工具权限`,
    done: task.result || `#${task.number} 已完成`,
    failed: task.error || task.stderrTail || `#${task.number} 执行失败`,
  };
  const detail = String(extra.detail || defaults[stage] || defaults.start).slice(0, 1000);
  return {
    hook_event_name: 'Bridge',
    source: 'bridge', noLark: true, noNotify: true,
    project: task.project || 'unknown', projectKey: task.project || 'unknown', cwd: extra.cwd || '',
    kind: mapped.kind, title: extra.title || mapped.title, detail, message: detail,
    speak: extra.speak || `${task.project || '项目'}：${extra.title || mapped.title}。${detail}`,
    taskId: task.id || '', taskNumber: task.number || 0, ts: Date.now(),
  };
}

export class BridgeEventClient {
  constructor({ url = process.env.CV_WORKER_URL || '', secret = process.env.HOOK_SECRET || '', fetchImpl = globalThis.fetch } = {}) {
    this.url = url && !url.endsWith('/hook') ? `${url.replace(/\/$/, '')}/hook` : url;
    this.secret = secret;
    this.fetchImpl = fetchImpl;
  }

  async emit(stage, task, extra = {}) {
    if (!this.url || !this.secret || !this.fetchImpl) return false;
    try {
      const response = await this.fetchImpl(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-cv-secret': this.secret },
        body: JSON.stringify(buildBridgeEvent(stage, task, extra)),
      });
      return Boolean(response?.ok);
    } catch { return false; }
  }
}
