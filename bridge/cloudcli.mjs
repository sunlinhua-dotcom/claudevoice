// CloudCLI 网页链接是可选功能：CC_WEB_URL 不设（默认空）就不生成任何链接，卡片不带按钮、消息不带链接行。
export const DEFAULT_CC_WEB_URL = '';

export function normalizeWebUrl(value = process.env.CC_WEB_URL || DEFAULT_CC_WEB_URL) {
  const url = String(value || '').trim().replace(/\/+$/, '');
  return /^https?:\/\//i.test(url) ? url : '';
}

export function buildSessionUrl(sessionId, baseUrl = process.env.CC_WEB_URL || DEFAULT_CC_WEB_URL) {
  const base = normalizeWebUrl(baseUrl);
  if (!sessionId || !base) return '';
  return `${base}/session/${sessionId}`;
}

export function formatRelativeTime(timestamp, now = Date.now()) {
  const elapsed = Math.max(0, Number(now) - (Number(timestamp) || 0));
  const minutes = Math.floor(elapsed / 60_000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  return `${days} 天前`;
}

export async function probeCloudCli({ fetchImpl = globalThis.fetch, timeoutMs = 1500 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl('http://127.0.0.1:3001/', {
      method: 'GET', signal: controller.signal,
    });
    return Boolean(response?.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}
