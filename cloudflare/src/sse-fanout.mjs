// Hub 的 SSE 扇出。纯函数，Node 里能用真 TransformStream 直接测。
//
// 旧写法在 broadcast / alarm 里对每个 writer `await w.write()`：TransformStream 的可读端水位是 0，
// 客户端连着但不读（网络半死、代理卡住）时 write 的 Promise 永远不 resolve，整条广播（连带 Web Push /
// Telegram / 飞书）和 alarm 都被它拖住。这里改成不 await：每个 writer 各自排队，积压超过上限就判定卡死、
// abort 掉让客户端重连；已出错（客户端断开）的立刻摘除，这样没有活 writer 时 alarm 不会多续一轮。

export const SSE_MAX_BACKLOG = 8;

// 'ok' | 'dead'（流已出错 / 客户端断了） | 'stalled'（积压超过上限）
export function writerHealth(w, maxBacklog = SSE_MAX_BACKLOG) {
  let ds;
  try { ds = w.desiredSize; } catch (_) { return 'dead'; }
  if (ds === null) return 'dead';
  if (typeof ds === 'number' && ds <= -maxBacklog) return 'stalled';
  return 'ok';
}

// makeChunk：每个 writer 单独生成一份 Uint8Array（不跨流共享同一块 buffer）。
// 返回仍然挂着的 writer 数；调用方据此决定 alarm 要不要续。
export function fanoutWrite(writers, makeChunk, { maxBacklog = SSE_MAX_BACKLOG, onDrop } = {}) {
  for (const [id, w] of [...writers]) {
    const health = writerHealth(w, maxBacklog);
    if (health !== 'ok') {
      writers.delete(id);
      // abort 会让 closed / ready / 排队中的 write 一并 reject；全部接住，免得变成未处理的 rejection
      try { w.closed.catch(() => {}); w.ready.catch(() => {}); Promise.resolve(w.abort(new Error('sse ' + health))).catch(() => {}); } catch (_) {}
      if (onDrop) onDrop(id, health);
      continue;
    }
    try { w.write(makeChunk()).catch(() => { writers.delete(id); }); }
    catch (_) { writers.delete(id); if (onDrop) onDrop(id, 'dead'); }
  }
  return writers.size;
}
