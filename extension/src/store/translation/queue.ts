/**
 * 队列位次订阅 —— 对应《01》§8 的 `queue.ts`（「SSE → store」）。
 *
 * **本文件最重要的性质：它不做任何估算。**
 * 《03》§5.7 的客户端禁令：「屏幕上出现的任何阿拉伯数字，其值必须来自服务端
 * 响应字段，不得由客户端计算。」理由是客户端看不到前方任务张数与单张耗时；
 * 且 Box 窗口与插件同时开启时，两处各自估算必然显示不同数字，属于契约不一致。
 *
 * 因此这里的每个函数要么**透传服务端字符串**，要么在服务端返回 null 时给出
 * **不含任何数字**的不定态文案。
 */

import type { QueueDto, TaskDto } from '../../types/contract';

/** 服务端未给 eta 时的不定态文案 —— **不含任何阿拉伯数字** */
export const ETA_UNDETERMINED_TEXT = '时间待估算';

export interface QueueEntry {
  taskId: string;
  comicName: string;
  /** 服务端 position（1 起，1 = 下一个执行）；running 中的任务为 0 */
  position: number | null;
  etaText: string | null;
  imageCount: number | null;
}

/**
 * 从队列快照里取本任务的位置与 eta。
 *
 * 三种情形（《03》§5.7）：
 *   - 在 `running` 里 → 已在执行，位次不适用
 *   - 在 `queued` 里 → 用服务端 `position` 与 `etaSeconds`
 *   - 都不在 → 任务可能刚终态、也可能已过期；返回空而非猜一个位次
 */
export function readQueueEntry(dto: QueueDto, taskId: string): QueueEntry | null {
  if (dto.running && dto.running.taskId === taskId) {
    return { taskId, comicName: dto.running.comicName, position: null, etaText: null, imageCount: null };
  }
  const q = dto.queued.find((x) => x.taskId === taskId);
  if (!q) return null;
  return {
    taskId,
    comicName: q.comicName,
    position: q.position,
    etaText: etaTextFromQueue(q.etaSeconds),
    imageCount: q.imageCount,
  };
}

/** 队列项的 etaSeconds → 文案；null → 不定态（不显示数字） */
export function etaTextFromQueue(
  eta: { min: number; max: number } | null | undefined,
): string | null {
  if (!eta) return null;
  return formatSecondsRange(eta.min, eta.max);
}

/**
 * 秒区间 → 人类可读文案。
 *
 * 注意：这是**服务端已给出的区间**的格式化，不是估算。若产品要求连这个格式化
 * 都由服务端下发（`eta.text`），则应改用 `TaskDto.eta.text` —— 两条路都可，
 * 但**绝不允许**在客户端用「张数 × 单张耗时」去算。
 */
export function formatSecondsRange(minSeconds: number, maxSeconds: number): string {
  const sec = (n: number): string => (n < 60 ? `${n} 秒` : `${Math.round(n / 60)} 分钟`);
  return `预计 ${sec(minSeconds)}–${sec(maxSeconds)}`;
}

/** 任务详情里的 eta → 文案（优先用服务端给的 `text`） */
export function etaTextFromTask(task: Pick<TaskDto, 'eta'>): string | null {
  const eta = task.eta;
  if (!eta) return null;
  return eta.text && eta.text.length > 0 ? eta.text : formatSecondsRange(eta.minSeconds, eta.maxSeconds);
}

/**
 * 提示行文案组装（《01》§7：`queued` → 「排队 · 第 2 位 · 预计 2–4 分钟」）。
 *
 * 组装是模板拼接；其中**每个数字都来自服务端字段**。
 * `position == null` 或 `0` 时**不显示位次**，避免出现「第 0 位」这种无意义文案。
 */
export function queueLineText(entry: Pick<QueueEntry, 'position' | 'etaText'>): string {
  const bits: string[] = [];
  if (typeof entry.position === 'number' && entry.position > 0) {
    bits.push(`排队 · 第 ${entry.position} 位`);
  } else {
    bits.push('排队中');
  }
  bits.push(entry.etaText ?? ETA_UNDETERMINED_TEXT);
  return bits.join(' · ');
}

/** 应用队列快照 → 供 `batchSlice.queueSnapshot` 使用的载荷 */
export function toQueuePatch(
  dto: QueueDto,
  taskId: string,
): { position: number | null; etaText: string | null } {
  const entry = readQueueEntry(dto, taskId);
  if (!entry) return { position: null, etaText: null };
  return { position: entry.position, etaText: entry.etaText };
}
