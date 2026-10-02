/**
 * 召唤阵（全局翻译状态标识）—— 对应《01》§6.2 / §7 与「召唤阵规格行」。
 *
 * 它在 ver1.0 是**被找回来的**：既有稿有 16 处魔法阵图层，ver1.0 稿零命中，
 * 三段接力丢失（v2.1 取消整屏遮罩 → 承载卡没位置 → 只写了「顶部进度条」）。
 *
 * 两处落点（本迭代不实现 Box 端，第三处规格保留）：
 *   ① 插件提示行左侧 24px（`queued` / `running` 专用，`running` 时旋转）
 *   ② 悬浮球收起态 72 环 + 40 球 —— 收起态是全局进度**唯一常驻载体**
 *
 * 约束（《01》§7）：
 *   - 只用既有 4 色 + `$3:10` line 作灰轨，**不新增令牌**
 *   - `rotate 8s`；`prefers-reduced-motion` 时停转
 *   - **24px 档必须去掉五芒星与最内环**（线宽 <1px 必然糊）
 */

import type { CSSProperties } from 'react';
import { MAGIC_CIRCLE_SIMPLIFY_BELOW } from '../theme/tokens';

export interface MagicCircleProps {
  size: number;
  /** 是否旋转（8s 一圈） */
  spin?: boolean;
  className?: string;
  style?: CSSProperties;
}

/** 五芒星路径（按包围盒归一化到 0..100） */
const STAR_PATH =
  'M50 12 L61.2 68.5 L10.9 32.6 L89.1 32.6 L38.8 68.5 Z';

/**
 * 装饰型召唤阵。
 *
 * 层级（由外向内）：外环 → 弧线刻度 → 内环 → 五芒星。
 * 小于 32px 时只保留外环与刻度 —— 这是硬约束，不是审美取舍：
 * 24px 下若保留五芒星，其线宽不足 1px，渲染出来是一团灰雾。
 */
export function MagicCircle({ size, spin = false, className, style }: MagicCircleProps) {
  const simplified = size < MAGIC_CIRCLE_SIMPLIFY_BELOW;
  const stroke = simplified ? 1.6 : Math.max(1.2, size / 24);
  return (
    <div
      className={['mt-magic', spin ? 'mt-magic--spin' : '', className].filter(Boolean).join(' ')}
      style={{ width: size, height: size, ...style }}
      data-simplified={simplified ? '1' : '0'}
      aria-hidden="true"
    >
      <svg viewBox="0 0 100 100" width={size} height={size} fill="none">
        <circle cx="50" cy="50" r="46" stroke="var(--mt-line)" strokeWidth={stroke * 2} />
        <circle cx="50" cy="50" r="36" stroke="var(--mt-lavender)" strokeWidth={stroke * 1.6} />
        {!simplified && (
          <>
            <circle cx="50" cy="50" r="24" stroke="var(--mt-blue)" strokeWidth={stroke * 1.4} />
            <path d={STAR_PATH} stroke="var(--mt-pink)" strokeWidth={stroke * 1.4} strokeLinejoin="round" />
          </>
        )}
        {/* 刻度：8 段短线，24px 档保留（它承担「阵」的辨识度） */}
        {Array.from({ length: 8 }).map((_, i) => {
          const angle = (i / 8) * Math.PI * 2;
          const x1 = 50 + Math.cos(angle) * 41;
          const y1 = 50 + Math.sin(angle) * 41;
          const x2 = 50 + Math.cos(angle) * 46;
          const y2 = 50 + Math.sin(angle) * 46;
          return (
            <line
              key={i}
              x1={x1}
              y1={y1}
              x2={x2}
              y2={y2}
              stroke="var(--mt-pink)"
              strokeWidth={stroke * 2}
              strokeLinecap="round"
            />
          );
        })}
      </svg>
    </div>
  );
}

export interface ProgressRingProps {
  size: number;
  /**
   * 已完成比例 0..1。
   *
   * 说明：比例由**服务端 `progress` 字段**换算（`done / total`），用于决定弧长。
   * 这不违反《03》§5.7 的客户端禁令 —— 该禁令约束的是「屏幕上出现的阿拉伯数字」，
   * 而环上不出现任何数字；且参与换算的 done / total 全部来自服务端。
   */
  ratio: number;
  /** 当前批次所占比例（可选；服务端未给批次进度时传 0） */
  currentRatio?: number;
  stroke?: number;
  /** 中心内容（内球） */
  children?: React.ReactNode;
  className?: string;
}

/**
 * 三段弧进度环（悬浮球收起态，72）。
 *
 * 三段（《01》§6.1）：已完成 `$3:12` pink / 当前批次 `$3:16` lavender / 剩余 `$3:10` line。
 * 这是「全局进度在收起态的唯一载体」—— 收起时面板不可见，用户只能靠它判断进展。
 */
export function ProgressRing({
  size,
  ratio,
  currentRatio = 0,
  stroke = 4,
  children,
  className,
}: ProgressRingProps) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const done = clamp01(ratio);
  const current = clamp01(currentRatio);
  const rest = Math.max(0, 1 - done - current);

  const arc = (len: number, offset: number, color: string, key: string) => (
    <circle
      key={key}
      cx={size / 2}
      cy={size / 2}
      r={r}
      stroke={color}
      strokeWidth={stroke}
      strokeLinecap="round"
      fill="none"
      strokeDasharray={`${c * len} ${c * (1 - len)}`}
      strokeDashoffset={-c * offset}
      transform={`rotate(-90 ${size / 2} ${size / 2})`}
    />
  );

  return (
    <div className={['mt-ring', className].filter(Boolean).join(' ')} style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {arc(rest, done + current, 'var(--mt-line)', 'rest')}
        {arc(current, done, 'var(--mt-lavender)', 'current')}
        {arc(done, 0, 'var(--mt-pink)', 'done')}
      </svg>
      <div className="mt-ring__center">{children}</div>
    </div>
  );
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}
