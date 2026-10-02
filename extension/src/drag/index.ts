/**
 * 悬浮球拖动 + 边界 clamp —— 对应《01》§8 的 `src/drag/`。
 *
 * 规格（《01》§6.1）：默认右下、可拖动、**边界 clamp 不越出视口**。
 *
 * 两个容易漏掉的点：
 *   1. clamp 必须考虑**球自身尺寸**，否则球会有一半停在视口外
 *   2. 拖动结束要区分「拖动」与「点击」—— 否则用户拖完球，面板会顺带被展开
 */

import { useCallback, useEffect, useRef, useState } from 'react';

export interface Point {
  x: number;
  y: number;
}

export interface DragOptions {
  /** 元素尺寸（用于 clamp） */
  width: number;
  height: number;
  /** 距视口边缘的最小留白 */
  margin?: number;
  /** 拖动位移超过该值即视为拖动而非点击 */
  clickThreshold?: number;
  /** 初始位置（右下角）；传 null 表示按默认策略 */
  initial?: Point | null;
  /** 位置变化时回调（持久化用） */
  onPositionChange?: (p: Point) => void;
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

export function useDrag(options: DragOptions) {
  const { width, height, margin = 8, clickThreshold = 4, initial = null } = options;
  const [position, setPosition] = useState<Point>(
    () => initial ?? defaultPosition(width, height),
  );
  const dragState = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);
  const [dragging, setDragging] = useState(false);

  // 视口尺寸变化时重新 clamp —— 否则缩小窗口后球会「失踪」
  useEffect(() => {
    const onResize = (): void => {
      setPosition((p) => clampPoint(p, width, height, margin));
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [width, height, margin]);

  const onPointerDown = useCallback(
    (e: React.PointerEvent) => {
      // 只响应主键；右键 / 中键不参与拖动
      if (e.button !== 0) return;
      (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
      dragState.current = {
        startX: e.clientX,
        startY: e.clientY,
        originX: position.x,
        originY: position.y,
        moved: false,
      };
      setDragging(true);
    },
    [position.x, position.y],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const st = dragState.current;
      if (!st) return;
      const dx = e.clientX - st.startX;
      const dy = e.clientY - st.startY;
      if (Math.abs(dx) > clickThreshold || Math.abs(dy) > clickThreshold) st.moved = true;
      setPosition(clampPoint({ x: st.originX + dx, y: st.originY + dy }, width, height, margin));
    },
    [width, height, margin],
  );

  const onPointerUp = useCallback(
    (e: React.PointerEvent) => {
      const st = dragState.current;
      dragState.current = null;
      setDragging(false);
      if (!st) return;
      try {
        (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
      } catch {
        /* 指针已释放 */
      }
      if (st.moved) options.onPositionChange?.(position);
    },
    [position, options],
  );

  /** 供 click 处理判断：这次抬手是不是一次纯点击 */
  const wasDragged = useCallback((): boolean => dragState.current?.moved ?? false, []);

  return { position, setPosition, dragging, onPointerDown, onPointerMove, onPointerUp, wasDragged };
}

/** 面板锚定：默认在球左侧，空间不足则 flip 到右侧（《01》§6.2） */
export function anchorPanel(
  ball: Point,
  ballSize: number,
  panelWidth: number,
  panelHeight: number,
  gap = 12,
): { x: number; y: number; flipped: boolean } {
  // 矮视口下面板实际高度是 min(规格, vh−16)（见 panel.css 的 max-height 降级），
  // 锚定必须用同一份有效高度，否则 y 会把面板推出视口
  const effH = Math.min(panelHeight, window.innerHeight - 16);
  const rightSpace = window.innerWidth - (ball.x + ballSize) - gap;
  const leftSpace = ball.x - gap;
  const flipped = rightSpace < panelWidth && leftSpace >= panelWidth;
  const x = flipped ? ball.x - gap - panelWidth : ball.x + ballSize + gap;
  const y = Math.min(
    Math.max(ball.y + ballSize - effH, 8),
    Math.max(8, window.innerHeight - effH - 8),
  );
  return { x: Math.max(8, x), y, flipped };
}
