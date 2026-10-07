import { sleep as defaultSleep } from './utils.mjs';

export const ROUTINE_REBUILD_MS = 4 * 60 * 60_000;
export const MAX_RECONNECT_DELAY_MS = 5 * 60_000;

function eventMeta(data) {
  const type = data?.header?.event_type || data?.event?.type || 'unknown';
  const eventId = data?.header?.event_id || data?.event_id || data?.event?.event_id || '';
  return { type: String(type), id: String(eventId).slice(-8) || 'unknown' };
}

export function createObservedDispatcher(dispatcher, {
  health, log = console, now = Date.now,
} = {}) {
  const invoke = dispatcher.invoke.bind(dispatcher);
  dispatcher.invoke = async (data, params) => {
    const arrivedAt = now();
    if (health) health.lastEventAt = arrivedAt;
    const meta = eventMeta(data);
    log.info?.(`事件到达 ${meta.type} id=${meta.id}`);
    return invoke(data, params);
  };
  return dispatcher;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function sdkErrorMessage(args, secrets) {
  let text = args
    .map((value) => value instanceof Error ? value.message : typeof value === 'string' ? value : '')
    .filter(Boolean)
    .join(' ');
  for (const secret of secrets.filter(Boolean)) {
    text = text.replace(new RegExp(escapeRegExp(secret), 'g'), '[已脱敏]');
  }
  text = text
    .replace(/Bearer\s+[^\s,;]+/gi, 'Bearer [已脱敏]')
    .replace(/((?:app[_-]?secret|token|authorization)\s*[=:]\s*)[^\s,;]+/gi, '$1[已脱敏]')
    .replace(/\b(?:wss?|https?):\/\/[^\s]+/gi, '[连接地址已脱敏]');
  const cleaned = text.trim() || '未知错误';
  return cleaned.length > 120 ? `${cleaned.slice(0, 119)}…` : cleaned;
}

export function createSdkLogger({ log = console, secrets = [] } = {}) {
  return {
    debug: () => {},
    info: () => {},
    warn: () => log.warn?.('飞书 SDK 警告（敏感细节已隐藏）'),
    error: (...args) => log.error?.(`飞书 SDK 请求失败：${sdkErrorMessage(args, secrets)}`),
  };
}

export function reconnectDelay(attempt, {
  baseMs = 5000, maxMs = MAX_RECONNECT_DELAY_MS,
} = {}) {
  return Math.min(maxMs, baseMs * (2 ** Math.max(0, Number(attempt) - 1)));
}

export class LarkConnectionManager {
  constructor({
    clientFactory, dispatcher, health, log = console, now = Date.now,
    secrets = [],
    routineMs = ROUTINE_REBUILD_MS, retryBaseMs = 5000,
    retryMaxMs = MAX_RECONNECT_DELAY_MS, readyTimeoutMs = 45_000,
    schedule = setTimeout, cancelSchedule = clearTimeout, sleep = defaultSleep,
  }) {
    this.clientFactory = clientFactory;
    this.dispatcher = dispatcher;
    this.health = health;
    this.log = log;
    this.now = now;
    this.secrets = secrets;
    this.routineMs = routineMs;
    this.retryBaseMs = retryBaseMs;
    this.retryMaxMs = retryMaxMs;
    this.readyTimeoutMs = readyTimeoutMs;
    this.schedule = schedule;
    this.cancelSchedule = cancelSchedule;
    this.sleep = sleep;
    this.client = null;
    this.candidate = null;
    this.routineTimer = null;
    this.rebuilding = null;
    this.closed = false;
  }

  async start() {
    this.closed = false;
    return this.rebuild('启动');
  }

  async rebuild(reason = '例行') {
    if (this.rebuilding) return this.rebuilding;
    this.rebuilding = this._rebuildLoop(reason);
    try {
      return await this.rebuilding;
    } finally {
      this.rebuilding = null;
    }
  }

  async _rebuildLoop(reason) {
    this._cancelRoutine();
    if (reason === '例行') this.log.info?.('主动重建飞书长连接（例行）');
    else if (reason === '故障') this.log.warn?.('主动重建飞书长连接（故障恢复）');
    let attempt = 0;
    while (!this.closed) {
      attempt += 1;
      try {
        await this._replaceClient();
        if (this.closed) return;
        this.log.info?.(reason === '启动' ? '飞书长连接已就绪' : '飞书长连接重建完成');
        this._scheduleRoutine();
        return;
      } catch (error) {
        this._closeCandidate();
        if (this.closed) return;
        const delay = reconnectDelay(attempt, {
          baseMs: this.retryBaseMs,
          maxMs: this.retryMaxMs,
        });
        this.log.error?.(`飞书长连接${reason === '启动' ? '建立' : '重建'}失败（第 ${attempt} 次）：${this._errorMessage(error)}；${Math.ceil(delay / 1000)} 秒后重试`);
        await this.sleep(delay);
      }
    }
  }

  async _replaceClient() {
    let candidate;
    let readyResolve;
    let readyReject;
    let readySettled = false;
    let terminalAfterReady = null;
    const ready = new Promise((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const callbacks = {
      onReady: () => {
        if (readySettled) return;
        readySettled = true;
        this.health.connectedAt = this.now();
        readyResolve();
      },
      onReconnecting: () => this.log.warn?.('飞书长连接断开，SDK 正在重连'),
      onReconnected: () => {
        this.health.connectedAt = this.now();
        this.log.info?.('飞书长连接已恢复');
      },
      onError: (error) => {
        if (!readySettled) {
          readySettled = true;
          readyReject(error instanceof Error ? error : new Error(this._errorMessage(error)));
          return;
        }
        this.log.error?.(`飞书长连接终止错误：${this._errorMessage(error)}`);
        if (!this.closed && this.client === candidate) {
          this.rebuild('故障').catch((rebuildError) => {
            this.log.error?.(`飞书长连接故障重建异常：${this._errorMessage(rebuildError)}`);
          });
        } else {
          terminalAfterReady = error;
        }
      },
    };
    candidate = this.clientFactory(callbacks);
    this.candidate = candidate;
    const previous = this.client;
    this.client = null;
    previous?.close?.({ force: true });

    Promise.resolve()
      .then(() => candidate.start({ eventDispatcher: this.dispatcher }))
      .catch((error) => {
        if (!readySettled) {
          readySettled = true;
          readyReject(error);
        }
      });
    let timeout;
    const timedReady = new Promise((resolve, reject) => {
      timeout = setTimeout(() => reject(new Error(`等待飞书长连接就绪超过 ${this.readyTimeoutMs}ms`)), this.readyTimeoutMs);
      timeout.unref?.();
      ready.then(resolve, reject);
    });
    try {
      await timedReady;
      if (terminalAfterReady) throw terminalAfterReady;
      this.client = candidate;
      this.candidate = null;
    } finally {
      clearTimeout(timeout);
    }
  }

  _scheduleRoutine() {
    if (this.closed) return;
    this.routineTimer = this.schedule(() => {
      this.routineTimer = null;
      this.rebuild('例行').catch((error) => {
        this.log.error?.(`飞书长连接例行重建异常：${this._errorMessage(error)}`);
      });
    }, this.routineMs);
    this.routineTimer?.unref?.();
  }

  _cancelRoutine() {
    if (!this.routineTimer) return;
    this.cancelSchedule(this.routineTimer);
    this.routineTimer = null;
  }

  _closeCandidate() {
    this.candidate?.close?.({ force: true });
    this.candidate = null;
  }

  _errorMessage(error) {
    return sdkErrorMessage([error], this.secrets);
  }

  close() {
    this.closed = true;
    this._cancelRoutine();
    this._closeCandidate();
    this.client?.close?.({ force: true });
    this.client = null;
  }
}
