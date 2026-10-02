/**
 * 面板根容器 —— 装配层（《01》§6.1 / §6.2，本轮修订）。
 *
 * 在这一层解决的四件事（都只出现一次）：
 *   1. **Shadow DOM 下的 AntD 样式注入**：`StyleProvider(container=shadowRoot)`。
 *      未做这一步，AntD 的 CSS-in-JS 会把样式注入到 document.head，
 *      而 Shadow DOM 的边界把它挡在外面 —— 结果是「组件渲染出来了，但完全没样式」。
 *   2. **互斥显示**：展开态只渲染面板、收起态只渲染悬浮球（同一时刻只有一个载体）。
 *   3. **各自独立的拖动坐标**：球位与面板位各一份，均由本层持有（唯一真源）。
 *   4. **展开 / 收起的位置换算**：展开时 `anchorPanel`（球 → 面板），
 *      收起时 `ballFromPanel`（面板 → 球，逆运算）—— 保证「拖完面板再收起」
 *      球落在面板旁，且再次展开回到同一位置。
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { ConfigProvider } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';

import { FLOATING_BALL, PANEL, cssVars } from '../theme/tokens';
import { makeStore, selectBatch, type AppStore, type RootState } from '../store/translation';
import { selectedCountOf } from '../store/translation/selectionSlice';
import {
  anchorPanel,
  ballFromPanel,
  clampPoint,
  defaultPosition,
  effectivePanelHeight,
  useDrag,
  type Point,
} from '../drag';
import { FloatingBall, loadBallPosition, saveBallPosition } from './FloatingBall';
import { Panel } from './Panel';

export function PanelRoot({ shadowRoot, theme }: { shadowRoot: ShadowRoot; theme: 'light' | 'dark' }) {
  // store 只建一次 —— 重新创建会让任务状态在每次渲染时丢光
  const storeRef = useRef<AppStore | null>(null);
  if (!storeRef.current) storeRef.current = makeStore();
  const store = storeRef.current;

  return (
    <StyleProvider container={shadowRoot} hashPriority="high">
      <ConfigProvider
        theme={{
          token: {
            colorPrimary: '#FF8FBF',
            borderRadius: 10,
            fontFamily: "'Noto Sans SC', system-ui, sans-serif",
          },
        }}
      >
        <Provider store={store}>
          <Dock theme={theme} />
        </Provider>
      </ConfigProvider>
    </StyleProvider>
  );
}

function Dock({ theme }: { theme: 'light' | 'dark' }) {
  const dispatch = useDispatch();
  const batch = useSelector(selectBatch);
  const selection = useSelector((s: RootState) => s.selection);
  // 《01》§6.1：收起态（悬浮球）是常驻载体，面板只按需展开 —— 默认收起
  const [expanded, setExpanded] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  /** 球位 —— 收起态的位置；收起时会被面板位置反算覆盖 */
  const [ballPos, setBallPos] = useState<Point>(() =>
    defaultPosition(FLOATING_BALL.ringSize, FLOATING_BALL.ringSize, 24),
  );
  /** 面板位 —— 仅展开态有意义（null = 尚未展开过） */
  const [panelPos, setPanelPos] = useState<Point | null>(null);
  /** 展开时的锚定侧 —— 收起反算必须用同一侧，否则球会左右横跳 */
  const [flipped, setFlipped] = useState(false);

  // ── 球：独立拖动，拖动结束才持久化 ──
  const ballDrag = useDrag({
    width: FLOATING_BALL.ringSize,
    height: FLOATING_BALL.ringSize,
    margin: 8,
    position: ballPos,
    onDrag: setBallPos,
    onCommit: (p) => void saveBallPosition(p),
  });

  // ── 面板：独立拖动（把手 = 面板头），拖动不落库（收起时由球位承载） ──
  const panelDrag = useDrag({
    width: PANEL.width,
    height: effectivePanelHeight(PANEL.height),
    margin: 8,
    position: panelPos ?? { x: 0, y: 0 },
    onDrag: setPanelPos,
    /**
     * 面板头里还有「收起」按钮：按下它时不该起拖，否则一次点击会被当成拖动，
     * 按钮的 click 反而被吞掉。凡命中可交互元素一律放行给元素自己处理。
     */
    canStart: (e) => {
      const t = e.target as HTMLElement | null;
      return !t?.closest?.('button, input, textarea, select, a, [data-no-drag]');
    },
  });

  // 恢复上次的球位置；恢复失败或越界则回落到右下角
  useEffect(() => {
    void (async () => {
      const saved = await loadBallPosition();
      setBallPos(
        saved
          ? clampPoint(saved, FLOATING_BALL.ringSize, FLOATING_BALL.ringSize, 8)
          : defaultPosition(FLOATING_BALL.ringSize, FLOATING_BALL.ringSize, 24),
      );
      setHydrated(true);
    })();
  }, []);

  /** 展开：面板锚定到**当前**球位（含 flip），球隐去（互斥显示） */
  const expand = useCallback(() => {
    const anchor = anchorPanel(ballPos, FLOATING_BALL.ringSize, PANEL.width, PANEL.height);
    setPanelPos({ x: anchor.x, y: anchor.y });
    setFlipped(anchor.flipped);
    setExpanded(true);
  }, [ballPos]);

  /**
   * 收起：球位由**面板位**反算（《01》§6.1 本轮修订），并立刻持久化 ——
   * 收起态才是常驻状态，此刻的球位就是用户下次看到的位置。
   */
  const collapse = useCallback(() => {
    if (panelPos) {
      const next = ballFromPanel(
        panelPos,
        FLOATING_BALL.ringSize,
        PANEL.width,
        PANEL.height,
        12,
        flipped,
      );
      setBallPos(next);
      void saveBallPosition(next);
    }
    setExpanded(false);
  }, [panelPos, flipped]);

  /** Esc = 面板头「收起」按钮的键盘等价物（《01》§6.1） */
  useEscapeCollapse(expanded, collapse);

  /** 服务端 progress 换算的比例 —— 仅用于进度环弧长，屏幕上不出现派生数字 */
  const progressRatio = useMemo(() => {
    const p = batch.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(1, Math.max(0, p.done / p.total));
  }, [batch.progress]);

  return (
    <div className={`mt-root mt-root--${theme}`} data-testid="miao-root" style={cssVars(theme)}>
      {/* 互斥显示：展开态只有面板 … */}
      {expanded && panelPos && hydrated && (
        <div className="mt-panelanchor" style={{ left: panelPos.x, top: panelPos.y }}>
          <Panel
            dispatch={dispatch}
            serviceReady={batch.serviceReady}
            progressRatio={progressRatio}
            onCollapse={collapse}
            dragging={panelDrag.dragging}
            onHeaderPointerDown={panelDrag.onPointerDown}
            onHeaderPointerMove={panelDrag.onPointerMove}
            onHeaderPointerUp={panelDrag.onPointerUp}
          />
        </div>
      )}
      {/* … 收起态只有悬浮球 */}
      {!expanded && (
        <FloatingBall
          state={batch.state}
          selectedCount={selectedCountOf(selection)}
          progressRatio={progressRatio}
          position={ballPos}
          dragging={ballDrag.dragging}
          wasDragged={ballDrag.wasDragged}
          onToggle={expand}
          onPointerDown={ballDrag.onPointerDown}
          onPointerMove={ballDrag.onPointerMove}
          onPointerUp={ballDrag.onPointerUp}
        />
      )}
    </div>
  );
}

/** 面板整体的 Esc 收起 —— 面板头「收起」按钮的键盘等价物，**不丢状态**（《01》§6.1） */
export function useEscapeCollapse(enabled: boolean, onCollapse: () => void): void {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onCollapse();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [enabled, onCollapse]);
}
