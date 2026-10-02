/**
 * 选图与提交的纯规则层。
 *
 * 全部函数都是**无副作用纯函数**，输入基本类型、输出判定结果 —— 这样《01》§5 的
 * 分层拦截、§6.3 的悬停硬规则、§6.4 的三条 P0 规则都能被单元测试逐条钉住，
 * 不依赖浏览器环境。
 */

import { BATCH_LIMIT, type ItemDto } from '../types/contract';
import type { TokenName } from '../theme/tokens';

// ─────────────────────── 《01》§5.2 计数三态 ───────────────────────

export type CounterTone = 'normal' | 'at-limit' | 'over-limit';

export interface SelectionCounter {
  count: number;
  pageCount: number;
  tone: CounterTone;
  /** 色彩令牌名 —— 直接喂给 UI，避免 UI 层再判一次 */
  token: TokenName;
  text: string;
  /** 超出上限的张数；未超限为 0 */
  overflow: number;
}

/**
 * 计数三态（《01》§5.2）：
 *
 * | 已选 | 色彩        | 文案                        |
 * |------|-------------|-----------------------------|
 * | ≤19  | ink-2       | 已选 6 张 · 分布于 1 页     |
 * | =20  | yellow      | 已选 20 张 · 已达单次上限   |
 * | >20  | error       | 已选 31 张 · 超出上限 11 张 |
 *
 * **为什么超限不用 pink**：pink 是本稿主强调色，用于主按钮与选中态。用它表达超限
 * 会让「可点的东西」与「出错的东西」同色，破坏语义分层。
 */
export function computeSelectionCounter(
  count: number,
  pageCount: number,
  limit: number = BATCH_LIMIT,
): SelectionCounter {
  if (count > limit) {
    return {
      count,
      pageCount,
      tone: 'over-limit',
      token: 'error',
      text: `已选 ${count} 张 · 超出上限 ${count - limit} 张`,
      overflow: count - limit,
    };
  }
  if (count === limit) {
    return {
      count,
      pageCount,
      tone: 'at-limit',
      token: 'yellow',
      text: `已选 ${count} 张 · 已达单次上限`,
      overflow: 0,
    };
  }
  return {
    count,
    pageCount,
    tone: 'normal',
    token: 'ink-2',
    text: `已选 ${count} 张 · 分布于 ${pageCount} 页`,
    overflow: 0,
  };
}

// ─────────────────────── 《01》§5.1 分层拦截 ───────────────────────

/** 「确定」被拦截时给出的两个动作 —— 顺序即界面顺序 */
export const OVER_LIMIT_ACTIONS = [
  { id: 'trim', label: '取消勾选（回到 20 张内）' },
  { id: 'batch', label: '分批提交' },
] as const;

export type OverLimitActionId = (typeof OVER_LIMIT_ACTIONS)[number]['id'];

export type SubmitDecision =
  | { kind: 'allow'; batchCount: number }
  | { kind: 'block'; reason: 'over-limit' | 'name-missing' | 'empty'; message: string; actions: typeof OVER_LIMIT_ACTIONS | readonly [] };

/**
 * 提交决策（《01》§5.1 分层拦截的「提交阶段硬拦」+《03》§2.2）。
 *
 * 关键：超限时**拦截并给出两个动作**，且**不发网络请求**。服务端的
 * `BATCH_LIMIT_EXCEEDED` 保留作为跨客户端一致性保障，在面板内正常路径不可达。
 */
export function decideSubmit(input: {
  selectedCount: number;
  comicNameOk: boolean;
  limit?: number;
}): SubmitDecision {
  const limit = input.limit ?? BATCH_LIMIT;
  if (input.selectedCount === 0) {
    return { kind: 'block', reason: 'empty', message: '请先选择要翻译的图片', actions: [] };
  }
  if (input.selectedCount > limit) {
    return {
      kind: 'block',
      reason: 'over-limit',
      message: `已超出单次上限 ${input.selectedCount - limit} 张`,
      actions: OVER_LIMIT_ACTIONS,
    };
  }
  if (!input.comicNameOk) {
    return { kind: 'block', reason: 'name-missing', message: '请填写漫画名', actions: [] };
  }
  return { kind: 'allow', batchCount: 1 };
}

/**
 * 勾选第 21 张起**仍然允许**（不阻断），只是计数转 error + 内联提示。
 *
 * 这是「分层拦截」全部分量的来源：《01》§5.3 注 ——「分批提交」这个功能的入口
 * **只在允许超选时才存在**。若改成硬拦截，必须同时满足 §5.4 的三条回落条件。
 */
export function canSelectMore(): boolean {
  return true;
}

/** 内联提示：仅超限时出现（《01》§5.1「勾选第 21 张起」行） */
export function inlineOverLimitHint(count: number, limit: number = BATCH_LIMIT): string | null {
  if (count <= limit) return null;
  return `已超出单次上限 ${count - limit} 张`;
}

// ─────────────────────── 《01》§6.4 三条 P0 硬规则 ───────────────────────

/**
 * **P0-1 回写前校验**。
 *
 * `img.isConnected && img.currentSrc === expectedUrl` 任一不成立即跳过，并把该张
 * 标记为「原图已离开页面」。
 *
 * 这是防止**译文串图**落到新页同位置元素上的唯一可靠手段 —— 按选择器或按位置
 * 回写都会写错（新页的第 3 个 `<img>` 未必是原页的第 3 张）。
 */
export function canWriteBack(input: {
  isConnected: boolean;
  currentSrc: string | null | undefined;
  expectedUrl: string;
}): { ok: true } | { ok: false; reason: 'left-dom' | 'src-mismatch' } {
  if (!input.isConnected) return { ok: false, reason: 'left-dom' };
  if (!input.currentSrc || !sameImageUrl(input.currentSrc, input.expectedUrl)) {
    return { ok: false, reason: 'src-mismatch' };
  }
  return { ok: true };
}

/**
 * 图片 URL 等价比较。
 *
 * `currentSrc` 可能被浏览器补全为绝对路径（`/a/b.png` → `https://host/a/b.png`），
 * 因此先用 `URL` 归一化；无法解析时退化为字符串全等。
 */
export function sameImageUrl(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new URL(a, 'http://127.0.0.1/').href === new URL(b, 'http://127.0.0.1/').href;
  } catch {
    return false;
  }
}

/** P0-2 的阈值：**超过 60% 已选图已离开当前 DOM** 即触发清空 */
export const LEAVE_DOM_CLEAR_THRESHOLD = 0.6;

/**
 * **P0-2 清空判据升级**。
 *
 * 由「URL 变化」改为「**URL 变化 或 已选图中超过 60% 已离开当前 DOM**」，两条件取**或**。
 * 这是让规则覆盖**无限滚动**场景的必要条件 —— 类型 ③ 下 URL 根本不变，
 * 「URL 变化才清空」永不触发，两话图片会混进同一任务、序号跨话连续。
 */
export function shouldClearSelection(input: {
  urlChanged: boolean;
  selectedCount: number;
  leftDomCount: number;
  threshold?: number;
}): { clear: boolean; reason: 'url-changed' | 'left-dom' | 'none' } {
  const threshold = input.threshold ?? LEAVE_DOM_CLEAR_THRESHOLD;
  if (input.urlChanged) return { clear: true, reason: 'url-changed' };
  if (input.selectedCount <= 0) return { clear: false, reason: 'none' };
  const ratio = input.leftDomCount / input.selectedCount;
  if (ratio > threshold) return { clear: true, reason: 'left-dom' };
  return { clear: false, reason: 'none' };
}

/** 已选图中已离开 DOM 的数量（喂给 `shouldClearSelection`） */
export function countLeftDom(
  selected: readonly { isConnected: boolean }[],
): number {
  return selected.reduce((n, it) => (it.isConnected ? n : n + 1), 0);
}

/**
 * P0-2 在「翻译中切页」时的口径（本轮裁定，方案 1）：
 * **不停当前任务，只清空尚未提交的已选集。**
 *
 * 理由：已提交的任务由服务端持有、与页面无关；强行取消会让用户刚提交的 20 张白跑。
 */
export function onRouteChangePlan(input: {
  hasRunningTask: boolean;
  urlChanged: boolean;
  selectedCount: number;
  leftDomCount: number;
}): { clearSelection: boolean; cancelTask: boolean; reason: string } {
  const r = shouldClearSelection({
    urlChanged: input.urlChanged,
    selectedCount: input.selectedCount,
    leftDomCount: input.leftDomCount,
  });
  return {
    clearSelection: r.clear,
    // 明确：切页**绝不**取消已提交的任务
    cancelTask: false,
    reason: r.reason,
  };
}

// ─────────────────────── 单图 L4 状态点映射 ───────────────────────

export type ThumbStatus = 'idle' | 'pending' | 'translating' | 'success' | 'failed' | 'warning';

/**
 * 把 item 映射为缩略图 L4 状态点（《01》§6.3 的 L4 行）。
 *
 * 设计稿 L4 有 `partial → warning + 感叹号` 一档，而契约的 item 级状态里没有
 * `partial`（`partial_failed` 是**任务级**状态）。这里的同构映射是：
 * `success && saved === false` → `warning`。
 * 依据《03》§4.2 注 —— 「`saved: false` 时 item 仍为 `success`：落盘失败不阻断主路径」，
 * 它是 item 级唯一「成功但不完整」的情形，正是被设计稿预留的 warning 档。
 */
export function thumbStatusOf(item: Pick<ItemDto, 'status' | 'saved'> | undefined): ThumbStatus {
  if (!item) return 'idle';
  switch (item.status) {
    case 'pending':
      return 'pending';
    case 'translating':
      return 'translating';
    case 'success':
      return item.saved === false ? 'warning' : 'success';
    case 'failed':
      return 'failed';
    case 'skipped':
      return 'idle';
    default:
      return 'idle';
  }
}
