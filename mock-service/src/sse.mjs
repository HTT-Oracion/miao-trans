// SSE 写出工具（契约 §5.5）
// 事件类型：task.status / batch.status / item.status / heartbeat

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

export const HEARTBEAT_MS = 15000;

/** 单条事件序列化：id / event / data 三行 + 空行 */
export function formatSseEvent(rec) {
  return `id: ${rec.id}\nevent: ${rec.event}\ndata: ${JSON.stringify(rec.data)}\n\n`;
}

export function writeSseEvent(res, rec) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(formatSseEvent(rec));
    return true;
  } catch {
    return false;
  }
}

export function writeComment(res, text) {
  if (res.writableEnded || res.destroyed) return false;
  try {
    res.write(`: ${text}\n\n`);
    return true;
  } catch {
    return false;
  }
}
