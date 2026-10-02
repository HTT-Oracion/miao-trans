/**
 * 拖动 / 点击判定 与 面板↔悬浮球位置换算（《01》§6.1 / §6.2 本轮修订）。
 *
 * 这些断言针对两类**只在浏览器里才暴露**的缺陷：
 *   ① 拖动悬浮球会顺带展开面板 —— 事件顺序是 `pointerup → click`，
 *      抬手时若把拖动状态清空，click 里再查就是 false（旧实现的实际行为）。
 *   ② 收起时球位算错 —— 忘记有效面板高（矮视口）、忘记 gap、忘记 clamp，
 *      或反算用了与展开不同的锚定侧，都会让球「跳走」或跑到视口外。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  anchorPanel,
  ballFromPanel,
  clampPoint,
  createDragTracker,
  defaultPosition,
  effectivePanelHeight,
  type Point,
} from '../../src/drag';
import { FLOATING_BALL, PANEL } from '../../src/theme/tokens';

const BALL = FLOATING_BALL.ringSize; // 72
const GAP = 12;

/** 视口替身 —— 这些函数直接读 window 尺寸 */
function setViewport(width: number, height: number): void {
  Object.defineProperty(window, 'innerWidth', { value: width, configurable: true, writable: true });
  Object.defineProperty(window, 'innerHeight', { value: height, configurable: true, writable: true });
}

const original = { w: window.innerWidth, h: window.innerHeight };
beforeEach(() => setViewport(1440, 900));
afterEach(() => setViewport(original.w, original.h));

describe('拖动 / 点击判定（createDragTracker）', () => {
  it('纯点击：抬手后 wasDragged 为 false —— 应当展开面板', () => {
    const t = createDragTracker();
    t.down(100, 100, { x: 0, y: 0 });
    expect(t.up()).toBe(false);
    expect(t.didMove()).toBe(false); // click 处理器此刻读到的值
  });

  it('**回归钉**：拖动后抬手，click 仍能读到「刚才是拖动」', () => {
    const t = createDragTracker();
    t.down(100, 100, { x: 0, y: 0 });
    t.move(140, 130, 4);
    expect(t.up()).toBe(true);
    // 关键：抬手已清空按下状态，但快照必须保留 —— 旧实现这里恒为 false，
    // 于是「拖完球顺带展开面板」。
    expect(t.isDragging()).toBe(false);
    expect(t.didMove()).toBe(true);
  });

  it('位移恰好等于阈值不算拖动（> 而非 >=），1px 抖动不误判', () => {
    const t = createDragTracker();
    t.down(100, 100, { x: 0, y: 0 });
    t.move(104, 100, 4);
    expect(t.up()).toBe(false);
    t.down(100, 100, { x: 0, y: 0 });
    t.move(100, 96, 4);
    expect(t.up()).toBe(false);
  });

  it('竖直方向超过阈值同样算拖动（不能只看 x）', () => {
    const t = createDragTracker();
    t.down(100, 100, { x: 0, y: 0 });
    t.move(100, 130, 4);
    expect(t.up()).toBe(true);
  });

  it('位置 = 原点 + 位移，不累积漂移；未按下时移动返回 null', () => {
    const t = createDragTracker();
    expect(t.move(10, 10, 4)).toBeNull();
    t.down(100, 100, { x: 30, y: 40 });
    expect(t.move(150, 120, 4)).toEqual({ x: 80, y: 60 });
    expect(t.move(200, 100, 4)).toEqual({ x: 130, y: 40 });
  });

  it('一次拖动后，下一次纯点击必须复位（快照在 down 时清空）', () => {
    const t = createDragTracker();
    t.down(0, 0, { x: 0, y: 0 });
    t.move(50, 50, 4);
    t.up();
    expect(t.didMove()).toBe(true);
    t.down(200, 200, { x: 0, y: 0 });
    t.up();
    expect(t.didMove()).toBe(false);
  });
});

describe('clamp / 默认位置', () => {
  it('clamp 把元素完整留在视口内（考虑自身尺寸）', () => {
    setViewport(1000, 800);
    expect(clampPoint({ x: -50, y: -50 }, BALL, BALL, 8)).toEqual({ x: 8, y: 8 });
    expect(clampPoint({ x: 9999, y: 9999 }, BALL, BALL, 8)).toEqual({
      x: 1000 - BALL - 8,
      y: 800 - BALL - 8,
    });
  });

  it('默认位置在右下角且不越界', () => {
    setViewport(1000, 800);
    expect(defaultPosition(BALL, BALL, 24)).toEqual({ x: 1000 - BALL - 24, y: 800 - BALL - 24 });
  });
});

describe('有效面板高（矮视口降级）', () => {
  it('常规视口用规格 680', () => {
    setViewport(1440, 900);
    expect(effectivePanelHeight(PANEL.height)).toBe(680);
  });
  it('矮视口压到 vh − 16 —— 与 panel.css 的 max-height 同源', () => {
    setViewport(1280, 660);
    expect(effectivePanelHeight(PANEL.height)).toBe(644);
  });
});

describe('展开锚定 anchorPanel（球 → 面板）', () => {
  it('默认右下角的球：面板 flip 到球左侧，底边对齐，间距 gap', () => {
    setViewport(1440, 900);
    const ball = defaultPosition(BALL, BALL, 24);
    const a = anchorPanel(ball, BALL, PANEL.width, PANEL.height, GAP);
    expect(a.flipped).toBe(true);
    expect(a.x).toBe(ball.x - GAP - PANEL.width);
    expect(a.y + PANEL.height).toBe(ball.y + BALL); // 底边对齐（未被 clamp 时）
  });

  it('球在左侧时面板贴到球右侧（不 flip）', () => {
    setViewport(1440, 900);
    const ball = { x: 40, y: 300 };
    const a = anchorPanel(ball, BALL, PANEL.width, PANEL.height, GAP);
    expect(a.flipped).toBe(false);
    expect(a.x).toBe(ball.x + BALL + GAP);
  });

  it('面板始终留在视口内（含极窄视口两侧都放不下的情况）', () => {
    setViewport(500, 800);
    for (const x of [8, 100, 200, 420]) {
      const a = anchorPanel({ x, y: 400 }, BALL, PANEL.width, PANEL.height, GAP);
      expect(a.x).toBeGreaterThanOrEqual(8);
      expect(a.x + PANEL.width).toBeLessThanOrEqual(500 - 8);
    }
  });
});

describe('收起反算 ballFromPanel（面板 → 球）', () => {
  it('距离计算：球落在面板同侧 gap 处，且底边对齐', () => {
    setViewport(1440, 900);
    const panel = { x: 400, y: 120 };
    // 未 flip：面板在球右侧 → 球在面板左侧
    expect(ballFromPanel(panel, BALL, PANEL.width, PANEL.height, GAP, false)).toEqual({
      x: panel.x - GAP - BALL,
      y: panel.y + PANEL.height - BALL,
    });
    // flip：面板在球左侧 → 球在面板右侧
    expect(ballFromPanel(panel, BALL, PANEL.width, PANEL.height, GAP, true)).toEqual({
      x: panel.x + PANEL.width + GAP,
      y: panel.y + PANEL.height - BALL,
    });
  });

  it('矮视口用有效面板高 —— 否则球会被算到视口外', () => {
    setViewport(1280, 660);
    const panel = { x: 300, y: 8 };
    const ball = ballFromPanel(panel, BALL, PANEL.width, PANEL.height, GAP, false);
    // 有效高 644：球 y = 8 + 644 − 72 = 580，在 660 视口内
    expect(ball.y).toBe(8 + 644 - BALL);
    expect(ball.y + BALL).toBeLessThanOrEqual(660 - 8);
  });

  it('反算结果一定在视口内（极端面板位置也不越界）', () => {
    setViewport(1280, 800);
    for (const panel of [
      { x: 8, y: 8 },
      { x: 900, y: 100 },
      { x: 8, y: 100 },
      { x: 600, y: 8 },
    ]) {
      for (const flipped of [false, true]) {
        const ball = ballFromPanel(panel, BALL, PANEL.width, PANEL.height, GAP, flipped);
        expect(ball.x).toBeGreaterThanOrEqual(8);
        expect(ball.x + BALL).toBeLessThanOrEqual(1280 - 8);
        expect(ball.y).toBeGreaterThanOrEqual(8);
        expect(ball.y + BALL).toBeLessThanOrEqual(800 - 8);
      }
    }
  });

  it('**往返一致**：展开 →（不拖动）→ 收起，球回到原点（面板未被 clamp 时）', () => {
    setViewport(1440, 900);
    /**
     * 只有「展开时面板不需要 clamp」的球位才能精确往返：面板高 680、视口 900，
     * 底边对齐要求 `球.y + 72 − 680 ≥ 8`，即球必须落在屏幕下方
     * `[616, 820]` 这段（默认右下角就在其中）。球在中部时面板会被顶到 y=8，
     * 此时球位不可精确还原 —— 那是正确行为，由下一条断言覆盖。
     */
    for (const y of [616, 700, 810]) {
      const ball = { x: 40, y };
      const a = anchorPanel(ball, BALL, PANEL.width, PANEL.height, GAP);
      const back = ballFromPanel({ x: a.x, y: a.y }, BALL, PANEL.width, PANEL.height, GAP, a.flipped);
      expect(back).toEqual(ball);
    }
  });

  it('球在屏幕中部（面板被顶到顶部）时：球位不还原，但**球一定落在面板旁**且面板位置稳定', () => {
    setViewport(1440, 900);
    const ball = { x: 40, y: 300 };
    const a = anchorPanel(ball, BALL, PANEL.width, PANEL.height, GAP);
    expect(a.y).toBe(8); // 面板被 clamp 到顶部
    const back = ballFromPanel({ x: a.x, y: a.y }, BALL, PANEL.width, PANEL.height, GAP, a.flipped);
    // 球落在面板左下角外侧（同侧、间距 gap、底边对齐）
    expect(back.x).toBe(a.x - GAP - BALL);
    expect(back.y + BALL).toBe(a.y + PANEL.height);
    // 再展开必须回到同一个面板位置（不来回跳）
    const a2 = anchorPanel(back, BALL, PANEL.width, PANEL.height, GAP);
    expect({ x: a2.x, y: a2.y }).toEqual({ x: a.x, y: a.y });
  });

  it('**往返一致（拖动后）**：拖面板到新位置再收起，球落在面板旁；再展开回到同一面板位置', () => {
    setViewport(1440, 900);
    const a0 = anchorPanel({ x: 40, y: 300 }, BALL, PANEL.width, PANEL.height, GAP);
    // 用户把面板拖到别处（已 clamp）
    const moved = clampPoint({ x: 260, y: 160 }, PANEL.width, PANEL.height, 8);
    const ball2 = ballFromPanel(moved, BALL, PANEL.width, PANEL.height, GAP, a0.flipped);
    // 再展开：面板必须回到 moved（而不是最初的位置）
    const a1 = anchorPanel(ball2, BALL, PANEL.width, PANEL.height, GAP);
    expect({ x: a1.x, y: a1.y }).toEqual(moved);
    expect(a1.flipped).toBe(a0.flipped);
  });

  it('往返在多个视口尺寸下都成立（含需要 clamp 的极端球位）', () => {
    for (const [w, h] of [
      [1280, 800],
      [1440, 900],
      [1920, 1080],
      [1280, 660],
    ] as Array<[number, number]>) {
      setViewport(w, h);
      const ball: Point = defaultPosition(BALL, BALL, 24);
      const a = anchorPanel(ball, BALL, PANEL.width, PANEL.height, GAP);
      const back = ballFromPanel({ x: a.x, y: a.y }, BALL, PANEL.width, PANEL.height, GAP, a.flipped);
      const a2 = anchorPanel(back, BALL, PANEL.width, PANEL.height, GAP);
      // 球位允许因 clamp 微调，但「展开出的面板位置」必须稳定（不来回跳）
      expect({ x: a2.x, y: a2.y }).toEqual({ x: a.x, y: a.y });
    }
  });
});
