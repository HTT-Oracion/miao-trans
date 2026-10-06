/**
 * 选图与提交的纯规则层。
 *
 * 全部函数都是**无副作用纯函数**，输入基本类型、输出判定结果 —— 这样《01》§5 的
 * 分层拦截、§6.3 的悬停硬规则、§6.4 的三条 P0 规则都能被单元测试逐条钉住，
 * 不依赖浏览器环境。
 */

import { SELECT_LIMIT, type ItemDto } from '../types/contract';
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
 * | 已选 | 色彩   | 文案                                     |
 * |------|--------|------------------------------------------|
 * | ≤49  | ink-2  | 已选 6 张 · 分布于 1 页                   |
 * | =50  | yellow | 已选 50 张 · 已达选择上限 · 分布于 3 页    |
 * | >50  | error  | 已选 51 张 · 超出上限 1 张 · 分布于 3 页   |
 *
 * ⚠️ **三档都带「分布于 N 页」**：选择上限 50 > 每页 20 格之后，选满必然跨页，
 * "还要翻几页"从锦上添花变成了必要信息（它原先只在 ≤19 档显示）。
 *
 * **为什么超限不用 pink**：pink 是本稿主强调色，用于主按钮与选中态。用它表达超限
 * 会让「可点的东西」与「出错的东西」同色，破坏语义分层。
 */
export function computeSelectionCounter(
  count: number,
  pageCount: number,
  limit: number = SELECT_LIMIT,
): SelectionCounter {
  if (count > limit) {
    return {
      count,
      pageCount,
      tone: 'over-limit',
      token: 'error',
      text: `已选 ${count} 张 · 超出上限 ${count - limit} 张 · 分布于 ${pageCount} 页`,
      overflow: count - limit,
    };
  }
  if (count === limit) {
    return {
      count,
      pageCount,
      tone: 'at-limit',
      token: 'yellow',
      text: `已选 ${count} 张 · 已达选择上限 · 分布于 ${pageCount} 页`,
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

/**
 * 「确定」被拦截时给出的动作 —— 顺序即界面顺序。
 *
 * 《01》§5.1 拍板：选择上限抬到 50 之后，20–50 是**正常区间**，"分批"成了纯内部行为。
 * 因此**只剩一个动作**：`'batch'`（分批提交）已从用户可选项里删掉 ——
 * 切批不是用户的决定，教他"可以分批提交"反而让他以为得自己动手。
 */
export const OVER_LIMIT_ACTIONS = [{ id: 'trim', label: '取消勾选（回到 50 张内）' }] as const;

export type OverLimitActionId = (typeof OVER_LIMIT_ACTIONS)[number]['id'];

export type SubmitDecision =
  | { kind: 'allow'; batchCount: number }
  | { kind: 'block'; reason: 'over-limit' | 'name-missing' | 'empty'; message: string; actions: typeof OVER_LIMIT_ACTIONS | readonly [] };

/**
 * 提交决策（《01》§5.1 分层拦截的「提交阶段硬拦」+《03》§2.2）。
 *
 * 关键：超限（> **选择上限**）时**拦截并给出动作**，且**不发网络请求**。服务端的
 * `BATCH_LIMIT_EXCEEDED` 保留作为跨客户端一致性保障，在面板内正常路径不可达。
 */
export function decideSubmit(input: {
  selectedCount: number;
  comicNameOk: boolean;
  limit?: number;
}): SubmitDecision {
  const limit = input.limit ?? SELECT_LIMIT;
  if (input.selectedCount === 0) {
    return { kind: 'block', reason: 'empty', message: '请先选择要翻译的图片', actions: [] };
  }
  if (input.selectedCount > limit) {
    return {
      kind: 'block',
      reason: 'over-limit',
      message: `已超出选择上限 ${input.selectedCount - limit} 张`,
      actions: OVER_LIMIT_ACTIONS,
    };
  }
  if (!input.comicNameOk) {
    return { kind: 'block', reason: 'name-missing', message: '请填写漫画名', actions: [] };
  }
  return { kind: 'allow', batchCount: 1 };
}

/**
 * 勾选第 51 张起**仍然允许**（不阻断），只是计数转 error + 内联提示。
 *
 * 这是「分层拦截」全部分量的来源 —— 选择阶段是软的、提交阶段才是硬的。
 * 若改成硬拦截，必须同时满足 §5.4 的三条回落条件。
 */
export function canSelectMore(): boolean {
  return true;
}

/** 内联提示：仅超限时出现（《01》§5.1「勾选第 51 张起」行） */
export function inlineOverLimitHint(count: number, limit: number = SELECT_LIMIT): string | null {
  if (count <= limit) return null;
  return `已超出选择上限 ${count - limit} 张`;
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
 * 语义边界（**故意从严**）：
 *   1. 任一为空 → 不判等。原实现用 `a === b` 短路，会让两个空串「相等」。
 *   2. 两侧都按**页面真实 base**（`document.baseURI`，可显式注入）解析后再比。
 *      这样「页面里写 `src="/comic/003.png"`、浏览器把 `currentSrc` 补成绝对路径」
 *      这一对能正确判等。
 *   3. **跨站不判等**：`/comic/003.png` 与 `https://cdn.example.com/comic/003.png`
 *      在无从得知基址时返回 `false`。这是 P0-1 的安全取向 ——
 *      **错杀优于串图**：误判「不等」只会跳过这张并标记「原图已离开页面」
 *      （可见、可恢复）；误判「相等」会把译文写到新页面的图上（静默串图）。
 *
 * 注意：这里**不做**启发式路径匹配（例如只比 `pathname`）。一旦放宽，
 * `a.com/1.png` 与 `b.com/1.png` 会被判等，P0-1 就失去意义了。
 */
export function sameImageUrl(a: string, b: string, base?: string): boolean {
  if (!a || !b) return false;
  if (a === b) return true;

  const resolvedBase =
    base ?? (typeof document !== 'undefined' ? document.baseURI : undefined);

  try {
    const ua = resolvedBase ? new URL(a, resolvedBase) : new URL(a);
    const ub = resolvedBase ? new URL(b, resolvedBase) : new URL(b);
    return ua.href === ub.href;
  } catch {
    // 无 base 且任一侧是相对路径 → 无法断定相等，一律不判等（从严）
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
 * 理由：已提交的任务由服务端持有、与页面无关；强行取消会让用户刚提交的 50 张白跑。
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
