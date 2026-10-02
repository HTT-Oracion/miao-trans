/**
 * 悬浮球 / 面板拖动 + 边界 clamp —— 对应《01》§8 的 `src/drag/`。
 *
 * 规格（《01》§6.1 / §6.2，本轮修订）：默认右下、**各自独立**可拖动、
 * 边界 clamp 不越出视口；**仅「点击」悬浮球展开面板**，拖动不展开；
 * 面板收起时按面板位置反算球位（`ballFromPanel` 是 `anchorPanel` 的逆运算）。
 *
 * 三个容易漏掉的点：
 *   1. clamp 必须考虑**元素自身尺寸**，否则球会有一半停在视口外
 *   2. 拖动结束要区分「拖动」与「点击」—— 否则用户拖完球，面板会顺带被展开
 *   3. 「拖动/点击」的判定必须在**抬手时快照**下来（见 `createDragTracker`）
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Point {
  x: number;
  y: number;
}

/**
 * 拖动 / 点击判定器 —— **纯逻辑，不依赖 React**，因此可以直接单测。
 *
 * 为什么需要它（缺陷修复记录）：原先的判定是「pointerup 时把拖动状态置空，
 * click 里再问 `dragState.current?.moved`」。但浏览器的事件顺序是
 * `pointerup → click`：等到 click 跑起来，状态已经是 null，`?? false` 恒为
 * false —— **拖动悬浮球也会顺带展开/收起面板**。修法是把抬手那一刻的
 * `moved` 快照进 `lastMoved`，`didMove()` 只读快照，与拖动状态解耦。
 */
export interface DragTracker {
  /** 按下：记录起点与元素原点，并清空上一次的快照 */
  down(x: number, y: number, origin: Point): void;
  /** 移动：返回未 clamp 的候选位置（无按下则返回 null） */
  move(x: number, y: number, threshold: number): Point | null;
  /** 抬手：返回本次是否发生了拖动，并把它快照下来 */
  up(): boolean;
  /** 抬手**之后**仍可查询「刚刚那次是不是拖动」（click 处理器用） */
  didMove(): boolean;
  /** 是否处于按下状态 */
  isDragging(): boolean;
}

export function createDragTracker(): DragTracker {
  let st: { startX: number; startY: number; originX: number; originY: number; moved: boolean } | null =
    null;
  let lastMoved = false;
  return {
    down(x, y, origin) {
      st = { startX: x, startY: y, originX: origin.x, originY: origin.y, moved: false };
      lastMoved = false;
    },
    move(x, y, threshold) {
      if (!st) return null;
      const dx = x - st.startX;
      const dy = y - st.startY;
      if (Math.abs(dx) > threshold || Math.abs(dy) > threshold) st.moved = true;
      return { x: st.originX + dx, y: st.originY + dy };
    },
    up() {
      lastMoved = st?.moved ?? false;
      st = null;
      return lastMoved;
    },
    didMove() {
      return lastMoved;
    },
    isDragging() {
      return st !== null;
    },
  };
}

export interface DragOptions {
  /** 元素尺寸（用于 clamp） */
  width: number;
  height: number;
  /** 距视口边缘的最小留白 */
  margin?: number;
  /** 拖动位移超过该值即视为拖动而非点击 */
  clickThreshold?: number;
  /**
   * 受控位置 —— **唯一真源在调用方**。
   *
   * 面板与悬浮球要互相换算坐标（收起时球位由面板位反算），
   * 所以位置不能由 hook 自己持有。
   */
  position: Point;
  /** 拖动过程中实时回调（位置**已 clamp**） */
  onDrag: (p: Point) => void;
  /** 拖动结束（仅位移超过阈值时回调）—— 用于持久化 */
  onCommit?: (p: Point) => void;
  /** 准入判断：返回 false 则本次按下不起拖（如面板头里的按钮） */
  canStart?: (e: React.PointerEvent) => boolean;
}

export interface DragHandle {
  dragging: boolean;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
  /** 供 click 处理器判断：这次抬手是不是一次纯点击 */
  wasDragged: () => boolean;
}

/** 当前视口下允许的位置区间 */
export function clampPoint(p: Point, width: number, height: number, margin = 8): Point {
  const maxX = Math.max(margin, window.innerWidth - width - margin);
  const maxY = Math.max(margin, window.innerHeight - height - margin);
  return {
    x: Math.min(Math.max(p.x, margin), maxX),
    y: Math.min(Math.max(p.y, margin), maxY),
  };
}

/** 默认位置：右下角（留 24 + 安全留白） */
export function defaultPosition(width: number, height: number, margin = 24): Point {
  return clampPoint(
    { x: window.innerWidth - width - margin, y: window.innerHeight - height - margin },
    width,
    height,
  );
}

/**
 * 面板**有效高度** —— 与 `panel.css` 的 `max-height: calc(100vh − 16px)` 同源。
 *
 * 矮视口（< 696）下面板被 CSS 压到 `vh − 16`。锚定与 clamp 若继续用规格 680，
 * 会把面板推出视口（底部按钮点不到），所以这里必须是唯一的一份计算。
 */
export function effectivePanelHeight(panelHeight: number, viewportHeight = window.innerHeight): number {
  return Math.min(panelHeight, viewportHeight - 16);
}

/**
 * 展开：由球位算面板位（《01》§6.2）。
 *
 * 规则：面板贴在球的**右侧**（间距 `gap`），右侧空间不足则 flip 到左侧；
 * 垂直方向**底边对齐**（面板底 = 球底），并 clamp 进视口。
 */
export function anchorPanel(
  ball: Point,
  ballSize: number,
  panelWidth: number,
  panelHeight: number,
  gap = 12,
): { x: number; y: number; flipped: boolean } {
  const effH = effectivePanelHeight(panelHeight);
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const rightSpace = vw - (ball.x + ballSize) - gap;
  const leftSpace = ball.x - gap;
  const flipped = rightSpace < panelWidth && leftSpace >= panelWidth;
  const rawX = flipped ? ball.x - gap - panelWidth : ball.x + ballSize + gap;
  // 两侧都不够（极窄视口）时，至少把面板压回视口内
  const maxX = Math.max(8, vw - panelWidth - 8);
  const x = Math.min(Math.max(rawX, 8), maxX);
  const y = Math.min(
    Math.max(ball.y + ballSize - effH, 8),
    Math.max(8, vh - effH - 8),
  );
  return { x, y, flipped };
}

/**
 * 收起：由面板位**反算**球位 —— `anchorPanel` 的逆运算（《01》§6.1 本轮修订）。
 *
 * 为什么需要逆运算：面板可独立拖动，收起时若把球放回旧位置，用户会觉得
 * 「球跳走了」。按面板位置反算，球就落在面板旁边（同一侧、间距 gap、底边对齐），
 * 视觉上有连续性；且「展开 → 拖面板 → 收起 → 再展开」能回到**同一个面板位置**
 * （可逆性由 `tests/drag.test.ts` 的往返断言钉死）。
 *
 * 注意距离计算的三件事：① 用 `effectivePanelHeight` 而不是规格 680；
 * ② 球的落点要以**球自身尺寸**参与 clamp；③ 面板侧向由展开时的 `flipped` 决定，
 * 反算必须用同一侧，否则会左右横跳。
 */
export function ballFromPanel(
  panel: Point,
  ballSize: number,
  panelWidth: number,
  panelHeight: number,
  gap = 12,
  flipped = false,
): Point {
  const effH = effectivePanelHeight(panelHeight);
  const x = flipped ? panel.x + panelWidth + gap : panel.x - gap - ballSize;
  const y = panel.y + effH - ballSize;
  return clampPoint({ x, y }, ballSize, ballSize, 8);
}

export function useDrag(options: DragOptions): DragHandle {
  const { width, height, margin = 8, clickThreshold = 4, position, canStart } = options;

  const tracker = useRef<DragTracker>(createDragTracker());
  const [dragging, setDragging] = useState(false);

  /** 每次渲染刷新 —— 事件回调因此不必把 position 塞进依赖数组（避免频繁重建句柄） */
  const latest = useRef({ position, width, height, margin, clickThreshold });
  latest.current = { position, width, height, margin, clickThreshold };
  /** 本次拖动的最后位置（抬手时用于 onCommit） */
  const lastPos = useRef<Point>(position);
  const cb = useRef({ onDrag: options.onDrag, onCommit: options.onCommit, canStart });
  cb.current = { onDrag: options.onDrag, onCommit: options.onCommit, canStart };

  // 视口尺寸变化时重新 clamp —— 否则缩小窗口后元素会「失踪」
  useEffect(() => {
    const onResize = (): void => {
      const l = latest.current;
      cb.current.onDrag(clampPoint(l.position, l.width, l.height, l.margin));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const onPointerDown = useCallback((e: React.PointerEvent) => {
    // 只响应主键；右键 / 中键不参与拖动
    if (e.button !== 0) return;
    if (cb.current.canStart && !cb.current.canStart(e)) return;
    const l = latest.current;
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    tracker.current.down(e.clientX, e.clientY, l.position);
    lastPos.current = l.position;
    setDragging(true);
  }, []);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const l = latest.current;
    const next = tracker.current.move(e.clientX, e.clientY, l.clickThreshold);
    if (!next) return;
    const clamped = clampPoint(next, l.width, l.height, l.margin);
    lastPos.current = clamped;
    cb.current.onDrag(clamped);
  }, []);

  const onPointerUp = useCallback((e: React.PointerEvent) => {
    const moved = tracker.current.up();
    setDragging(false);
    try {
      (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
    } catch {
      /* 指针已释放 */
    }
    if (moved) cb.current.onCommit?.(lastPos.current);
  }, []);

  /** 只读快照 —— 与拖动状态解耦，click（pointerup 之后触发）才能拿到正确结果 */
  const wasDragged = useCallback((): boolean => tracker.current.didMove(), []);

  return { dragging, onPointerDown, onPointerMove, onPointerUp, wasDragged };
}
