/**
 * 悬浮球 —— 《01》§6.1。
 *
 * **只在收起态渲染**（与面板互斥显示，见 `PanelRoot.Dock`），因此永远是
 * 「两层」形态：外进度环 72 + 内球 40。它是「全局翻译状态唯一常驻的载体」——
 * 面板可能正关着，用户只看得见它。
 * 原方案里收起态只有一枚 16px 纯色状态点，那是**状态**不是**进度**：
 * 全局进度在收起态没有任何载体，必须展开面板才看得到。
 *
 * 内球 5 态（《01》§6.1）：空闲 / 排队中（蓝）/ 翻译中（蓝 + 转圈）/ 完成（绿）/ 失败（红）。
 *
 * 位置与拖动由 `PanelRoot` 持有（收起时还要按面板位置反算球位，两者必须共享
 * 同一份坐标），因此本组件是**受控**的。
 */

import { ProgressRing } from './MagicCircle';
import { FLOATING_BALL } from '../theme/tokens';
import type { ClientState } from '../domain/clientState';
import type { Point } from '../drag';
import { logoUrl } from './assets';

export interface FloatingBallProps {
  state: ClientState;
  /** 已选张数；未选不显示角标（《01》§6.1） */
  selectedCount: number;
  /** 服务端 progress 换算的比例（0..1）；无任务传 0 */
  progressRatio?: number;
  currentBatchRatio?: number;
  position: Point;
  dragging: boolean;
  /**
   * 拖动位移是否已超过点击阈值 —— **仅在拖动后仍可查询**（抬手快照）。
   * 「仅点击展开」全靠这个判据：拖完球不该顺带展开面板。
   */
  wasDragged: () => boolean;
  onToggle: () => void;
  onPointerDown: (e: React.PointerEvent) => void;
  onPointerMove: (e: React.PointerEvent) => void;
  onPointerUp: (e: React.PointerEvent) => void;
}

export type BallTone = 'idle' | 'queued' | 'running' | 'done' | 'failed';

export function ballToneOf(state: ClientState): BallTone {
  switch (state) {
    case 'submitting':
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'partial_failed':
    case 'failed':
      return 'failed';
    default:
      return 'idle';
  }
}

const SIZE = FLOATING_BALL.ringSize;

export function FloatingBall({
  state,
  selectedCount,
  progressRatio = 0,
  currentBatchRatio = 0,
  position,
  dragging,
  wasDragged,
  onToggle,
  onPointerDown,
  onPointerMove,
  onPointerUp,
}: FloatingBallProps) {
  const tone = ballToneOf(state);

  return (
    <div
      className={['mt-ball', dragging ? 'mt-ball--dragging' : ''].filter(Boolean).join(' ')}
      style={{ left: position.x, top: position.y, width: SIZE, height: SIZE }}
      data-testid="floating-ball"
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onClick={() => {
        // 拖动过就只落位、不展开（判据来自抬手快照）
        if (wasDragged()) return;
        onToggle();
      }}
      role="button"
      tabIndex={0}
      aria-label="展开喵译面板"
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <ProgressRing
        size={SIZE}
        ratio={progressRatio}
        currentRatio={currentBatchRatio}
        stroke={FLOATING_BALL.ringStroke}
      >
        <BallCore tone={tone} size={FLOATING_BALL.ballSize} />
      </ProgressRing>

      {selectedCount > 0 && (
        <span className="mt-ball__badge" aria-label={`已选 ${selectedCount} 张`}>
          {selectedCount}
        </span>
      )}
    </div>
  );
}

function BallCore({ tone, size }: { tone: BallTone; size: number }) {
  return (
    <span className={`mt-ball__core mt-ball__core--${tone}`} style={{ width: size, height: size }}>
      <img src={brandLogoUrl()} alt="" width={size - 8} height={size - 8} draggable={false} />
      {tone === 'running' && <span className="mt-ball__spin" aria-hidden="true" />}
    </span>
  );
}

/**
 * 品牌标识 —— 冻结值，不随深浅色切换（《01》§9）。
 * 悬浮球用 64 档等比缩到 32，避免 16 档的糊边。
 */
function brandLogoUrl(): string {
  return logoUrl(64);
}

/** 悬浮球位置持久化（轻量配置，进 `chrome.storage.local` 是允许的 —— 《01》§3） */
export const BALL_POSITION_KEY = 'ballPosition';

export async function saveBallPosition(p: Point): Promise<void> {
  try {
    await browser.storage.local.set({ [BALL_POSITION_KEY]: p });
  } catch {
    /* 忽略：位置不是关键状态 */
  }
}

export async function loadBallPosition(): Promise<Point | null> {
  try {
    const got = await browser.storage.local.get(BALL_POSITION_KEY);
    const v = got[BALL_POSITION_KEY] as Point | undefined;
    return v && typeof v.x === 'number' && typeof v.y === 'number' ? v : null;
  } catch {
    return null;
  }
}
