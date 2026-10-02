/**
 * 图标集（内联 SVG）。
 *
 * 「四角展开」取型依据《01》§6.3 的选型说明：
 *   在工具栏语境里**放大镜首先会被读成「搜索」**，与右侧「更多」并排时歧义更重。
 *   四角展开无此歧义，且 16px 档下只剩 4 段直线，锐度优于「圆 + 手柄」。
 *   `stroke 1.6`、`linecap/linejoin: round`，视觉尺寸 13×13，刻意与右侧三点等重。
 */

import type { SVGProps } from 'react';

export interface IconProps extends Omit<SVGProps<SVGSVGElement>, 'children'> {
  size?: number;
  color?: string;
  strokeWidth?: number;
}

const base = (size: number): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 16 16',
  fill: 'none',
  xmlns: 'http://www.w3.org/2000/svg',
  'aria-hidden': true,
  focusable: false,
});

/**
 * 四角展开 —— 悬停条左钮（替代原放大镜）。
 * 四段 L 形折角，角点 2.6 / 13.4（span 10.8 + stroke 1.6 ≈ 视觉 12.4，对齐规格的 13）。
 */
export function IconExpand({ size = 20, color = 'currentColor', strokeWidth = 1.6, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <g stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        <path d="M6.5 2.6 L2.6 2.6 L2.6 6.5" />
        <path d="M9.5 2.6 L13.4 2.6 L13.4 6.5" />
        <path d="M2.6 9.5 L2.6 13.4 L6.5 13.4" />
        <path d="M13.4 9.5 L13.4 13.4 L9.5 13.4" />
      </g>
    </svg>
  );
}

/** 「更多」—— 横排三点，与左钮等重 */
export function IconMore({ size = 20, color = 'currentColor', ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <g fill={color}>
        <circle cx="3.4" cy="8" r="1.25" />
        <circle cx="8" cy="8" r="1.25" />
        <circle cx="12.6" cy="8" r="1.25" />
      </g>
    </svg>
  );
}

/** 对勾（勾选框 L2 用，12×12 视觉） */
export function IconCheck({ size = 12, color = 'currentColor', strokeWidth = 2, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path
        d="M2.6 8.4 L6 11.6 L13.4 4.2"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 编辑（漫画名只读态尾部的 16×16 图标） */
export function IconEdit({ size = 16, color = 'currentColor', strokeWidth = 1.5, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <g stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        <path d="M9.4 3.2 L12.8 6.6 L6.2 13.2 L2.8 13.2 L2.8 9.8 Z" />
        <path d="M8.2 4.4 L11.6 7.8" />
      </g>
    </svg>
  );
}

/** 刷新 */
export function IconRefresh({ size = 16, color = 'currentColor', strokeWidth = 1.5, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <g stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        <path d="M13.2 8 A5.2 5.2 0 1 1 10.4 3.4" />
        <path d="M13.4 2.6 L13.4 6.2 L9.8 6.2" />
      </g>
    </svg>
  );
}

/** 清除（叉） */
export function IconClose({ size = 14, color = 'currentColor', strokeWidth = 1.6, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path
        d="M3.6 3.6 L12.4 12.4 M12.4 3.6 L3.6 12.4"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
      />
    </svg>
  );
}

export function IconChevronLeft({ size = 16, color = 'currentColor', strokeWidth = 1.8, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path
        d="M9.8 3.4 L5 8 L9.8 12.6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function IconChevronRight({ size = 16, color = 'currentColor', strokeWidth = 1.8, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <path
        d="M6.2 3.4 L11 8 L6.2 12.6"
        stroke={color}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** 定位图片（聚光环） */
export function IconLocate({ size = 16, color = 'currentColor', strokeWidth = 1.5, ...rest }: IconProps) {
  return (
    <svg {...base(size)} {...rest}>
      <g stroke={color} strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 2.2 L8 4.2 M8 11.8 L8 13.8 M2.2 8 L4.2 8 M11.8 8 L13.8 8" />
      </g>
    </svg>
  );
}

/**
 * 状态点内的符号（白勾 / 白叉 / 感叹号）—— L4 用。
 * 颜色不可作为唯一信息载体（《01》§7.1），所以每个状态都有自己的**形状**。
 */
export function IconStatusGlyph({
  kind,
  size = 10,
  color = '#FFFFFF',
}: {
  kind: 'check' | 'cross' | 'bang';
  size?: number;
  color?: string;
}) {
  const common = { ...base(size), viewBox: '0 0 12 12' };
  if (kind === 'check') {
    return (
      <svg {...common}>
        <path
          d="M2.4 6.4 L4.8 8.8 L9.6 3.4"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          strokeLinejoin="round"
          fill="none"
        />
      </svg>
    );
  }
  if (kind === 'cross') {
    return (
      <svg {...common}>
        <path
          d="M3.2 3.2 L8.8 8.8 M8.8 3.2 L3.2 8.8"
          stroke={color}
          strokeWidth={1.8}
          strokeLinecap="round"
          fill="none"
        />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <g fill={color}>
        <rect x="5.2" y="2.2" width="1.6" height="5" rx="0.8" />
        <circle cx="6" cy="9.4" r="0.95" />
      </g>
    </svg>
  );
}
