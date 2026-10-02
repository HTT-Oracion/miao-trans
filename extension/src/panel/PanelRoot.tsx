/**
 * 面板根容器 —— 装配层。
 *
 * 三件事在这一层解决，且都只在装配层出现一次：
 *   1. **Shadow DOM 下的 AntD 样式注入**：`StyleProvider(container=shadowRoot)`。
 *      未做这一步，AntD 的 CSS-in-JS 会把样式注入到 document.head，
 *      而 Shadow DOM 的边界把它挡在外面 —— 结果是「组件渲染出来了，但完全没样式」。
 *   2. **拖动坐标的唯一持有者**：面板要锚定悬浮球，两者必须共享同一份坐标，
 *      所以 `useDrag` 提到这一层，悬浮球变成受控组件。
 *   3. **面板 flip 锚定**：靠边时自动翻到另一侧（《01》§6.2）。
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import { Provider, useDispatch, useSelector } from 'react-redux';
import { ConfigProvider } from 'antd';
import { StyleProvider } from '@ant-design/cssinjs';

import { FLOATING_BALL, PANEL, cssVars } from '../theme/tokens';
import { makeStore, selectBatch, type AppStore, type RootState } from '../store/translation';
import { selectedCountOf } from '../store/translation/selectionSlice';
import { anchorPanel, clampPoint, defaultPosition, useDrag } from '../drag';
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

  const {
    position,
    setPosition,
    dragging,
    onPointerDown,
    onPointerMove,
    onPointerUp,
    wasDragged,
  } = useDrag({
    width: FLOATING_BALL.ringSize,
    height: FLOATING_BALL.ringSize,
    margin: 8,
    clickThreshold: 4,
  });

  // 恢复上次的球位置；恢复失败或越界则回落到右下角
  useEffect(() => {
    void (async () => {
      const saved = await loadBallPosition();
      setPosition(
        saved
          ? clampPoint(saved, FLOATING_BALL.ringSize, FLOATING_BALL.ringSize, 8)
          : defaultPosition(FLOATING_BALL.ringSize, FLOATING_BALL.ringSize, 24),
      );
      setHydrated(true);
    })();
  }, [setPosition]);

  // 面板锚定：默认在球左侧，空间不足翻到右侧
  const anchor = useMemo(() => {
    if (!expanded || !hydrated) return null;
    return anchorPanel(position, FLOATING_BALL.ringSize, PANEL.width, PANEL.height, 12);
  }, [expanded, hydrated, position]);

  /** 服务端 progress 换算的比例 —— 仅用于进度环弧长，屏幕上不出现派生数字 */
  const progressRatio = useMemo(() => {
    const p = batch.progress;
    if (!p || p.total <= 0) return 0;
    return Math.min(1, Math.max(0, p.done / p.total));
  }, [batch.progress]);

  return (
    <div className={`mt-root mt-root--${theme}`} data-testid="miao-root" style={cssVars(theme)}>
      {anchor && (
        <div className="mt-panelanchor" style={{ left: anchor.x, top: anchor.y }}>
          <Panel
            dispatch={dispatch}
            serviceReady={batch.serviceReady}
            progressRatio={progressRatio}
            onCollapse={() => setExpanded(false)}
          />
        </div>
      )}
      <FloatingBall
        collapsed={!expanded}
        state={batch.state}
        selectedCount={selectedCountOf(selection)}
        progressRatio={progressRatio}
        position={position}
        dragging={dragging}
        wasDragged={wasDragged}
        onToggle={() => setExpanded((v) => !v)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      />
      {/* 拖动结束后持久化位置 */}
      <PersistPosition position={position} dragging={dragging} />
    </div>
  );
}

/** 位置持久化（拖动结束才写，避免拖动过程中高频写 storage） */
function PersistPosition({
  position,
  dragging,
}: {
  position: { x: number; y: number };
  dragging: boolean;
}) {
  const prevDragging = useRef(false);
  useEffect(() => {
    if (prevDragging.current && !dragging) void saveBallPosition(position);
    prevDragging.current = dragging;
  }, [dragging, position]);
  return null;
}

/** 面板整体的 Esc 收起 —— 点面板外或按 Esc 收起为悬浮球，**不丢状态**（《01》§6.1） */
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
