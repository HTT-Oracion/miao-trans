/**
 * 缩略图 —— 七层结构，逐层对应《01》§6.3 的图层表。
 *
 * | 层 | 元素 | 关键规格 |
 * |----|------|----------|
 * | L0 | 底图 | `$3:11` 占位 / 真实图；`pointer-events: none` |
 * | L1 | 选中蒙层 | 2px `$3:12` 描边 + `$3:13` @18%；`pointer-events: none` |
 * | L2 | 勾选框 18×18 r6 inset6 | 可点 |
 * | L3 | 序号角标 h16 minW16 r6 inset4 | 纯数字 Inter Medium 10px |
 * | L4 | 状态点 16×16 | 蓝/绿/红/warning + **各自独立的形状** |
 * | L5 | 悬停条 46×20 @ (6,58) | **z 序最上**；两个 20×20 按钮 |
 * | L6 | 更多菜单 168 宽 | **浮层，不属缩略图自身层级** |
 *
 * 本文件承担 ver1.0 那三条 hover 硬规则中的两条（层级与兜底）：
 *
 * 1. **层级**：L5 置于 z 序最上，**L0–L4 全部 `pointer-events: none`**。
 *    否则覆盖整格的选中描边会吞掉指针事件 —— 那正是「为什么是**个别**图片
 *    hover 恒失效」的答案：失效的恰好是被勾选的那几张。
 * 2. **兜底**：`hover: none` 环境（触屏）改为**常显**；键盘 `:focus-within`
 *    **强制显示**，保证纯键盘可达。
 * 3. 几何（第三条）由 `theme/tokens.ts` 的 `THUMB_LAYER.hoverBar` 定死为
 *    46×20 @ (6,58)，完全落在 58×84 格内 —— 原 68×98 时代的几何在新格子下
 *    右溢 4px、下溢 8px，被 `clipsContent` 整体裁掉。
 */

import { useEffect, useRef, useState } from 'react';
import { GRID, MORE_MENU, THUMB_LAYER } from '../theme/tokens';
import { IconCheck, IconExpand, IconLocate, IconMore, IconStatusGlyph } from './icons';
import type { ThumbStatus } from '../selection/rules';

export interface ThumbCellProps {
  seq: number;
  /** 缩略图预览地址（原图 URL） */
  previewUrl?: string;
  selected: boolean;
  /** 面板页码（仅用于无障碍播报） */
  page: number;
  status: ThumbStatus;
  /** 是否允许交互（`running` 期间不可改选，但仍可 hover 预览） */
  selectable: boolean;
  /** 「定位图片」是否可用（原图已离开 DOM → 置灰） */
  locateAvailable: boolean;
  onToggle: () => void;
  onExpand: () => void;
  onLocate: () => void;
  onMenuOpenChange?: (open: boolean) => void;
  /** 由父级控制的菜单单例：同一时刻只存在一个（《01》§6.3） */
  menuOpen: boolean;
  onRequestMenuOpen: () => void;
  onRequestMenuClose: () => void;
}

const S = THUMB_LAYER;
const HB = S.hoverBar;

export function ThumbCell({
  seq,
  previewUrl,
  selected,
  page,
  status,
  selectable,
  locateAvailable,
  onToggle,
  onExpand,
  onLocate,
  onMenuOpenChange,
  menuOpen,
  onRequestMenuOpen,
  onRequestMenuClose,
}: ThumbCellProps) {
  const cellRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    onMenuOpenChange?.(menuOpen);
  }, [menuOpen, onMenuOpenChange]);

  // Esc 关闭菜单（点外部关闭由面板级别的捕获层负责）
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onRequestMenuClose();
      }
    };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [menuOpen, onRequestMenuClose]);

  return (
    <div
      ref={cellRef}
      className={['mt-thumb', selected ? 'mt-thumb--selected' : '', menuOpen ? 'mt-thumb--menu-open' : '']
        .filter(Boolean)
        .join(' ')}
      style={{ width: GRID.cellW, height: GRID.cellH, borderRadius: GRID.radius }}
      data-seq={seq}
      data-testid="thumb-cell"
    >
      {/* L0 底图 */}
      <div className="mt-thumb__layer mt-thumb__base" aria-hidden="true">
        {previewUrl ? <img src={previewUrl} alt="" loading="lazy" draggable={false} /> : null}
      </div>

      {/* L1 选中蒙层（整格 2px 描边 + pink-soft 18%） */}
      {selected && <div className="mt-thumb__layer mt-thumb__select" aria-hidden="true" />}

      {/* L2 勾选框 */}
      <button
        type="button"
        className="mt-thumb__checkbox"
        style={{
          width: S.checkbox.size,
          height: S.checkbox.size,
          borderRadius: S.checkbox.radius,
          top: S.checkbox.inset,
          left: S.checkbox.inset,
        }}
        disabled={!selectable}
        aria-pressed={selected}
        aria-label={`第 ${seq} 张，${selected ? '已选' : '未选'}`}
        onClick={(e) => {
          e.stopPropagation();
          onToggle();
        }}
      >
        {selected && <IconCheck size={12} color="var(--mt-on-accent)" />}
      </button>

      {/* L3 序号角标 */}
      <span
        className="mt-thumb__seq"
        style={{
          height: S.seqBadge.h,
          minWidth: S.seqBadge.minW,
          maxWidth: S.seqBadge.maxW,
          borderRadius: S.seqBadge.radius,
          right: S.seqBadge.inset,
          bottom: S.seqBadge.inset,
          fontSize: S.seqBadge.fontSize,
        }}
      >
        {seq}
      </span>

      {/* L4 状态点 —— 形状与色相双通道，不靠颜色单独承载信息 */}
      <StatusDot status={status} />

      {/* L5 悬停条（z 序最上） */}
      <div
        className="mt-thumb__hoverbar"
        style={{
          width: HB.w,
          height: HB.h,
          left: HB.x,
          top: HB.y,
          borderRadius: HB.radius,
          gap: HB.gap,
        }}
      >
        <button
          type="button"
          className="mt-thumb__hoverbtn"
          style={{ width: HB.btnSize, height: HB.btnSize }}
          aria-label="放大查看"
          onClick={(e) => {
            e.stopPropagation();
            onExpand();
          }}
        >
          <IconExpand size={HB.btnSize} />
        </button>
        <button
          type="button"
          className="mt-thumb__hoverbtn"
          style={{ width: HB.btnSize, height: HB.btnSize }}
          aria-label="更多"
          aria-haspopup="menu"
          aria-expanded={menuOpen}
          onClick={(e) => {
            e.stopPropagation();
            if (menuOpen) onRequestMenuClose();
            else onRequestMenuOpen();
          }}
        >
          <IconMore size={HB.btnSize} />
        </button>
      </div>

      {/* L6 更多菜单（浮层） */}
      {menuOpen && (
        <MoreMenu
          cellRef={cellRef}
          locateAvailable={locateAvailable}
          onLocate={() => {
            onLocate();
            onRequestMenuClose();
          }}
        />
      )}

      <span className="mt-visually-hidden">
        第 {seq} 张，第 {page} 页，{statusText(status)}
      </span>
    </div>
  );
}

function statusText(s: ThumbStatus): string {
  switch (s) {
    case 'pending':
      return '等待翻译';
    case 'translating':
      return '翻译中';
    case 'success':
      return '已完成';
    case 'failed':
      return '翻译失败';
    case 'warning':
      return '已完成但未落盘，或原图已离开页面';
    default:
      return '未开始';
  }
}

/** L4 状态点：色相 + 形状双通道 */
function StatusDot({ status }: { status: ThumbStatus }) {
  if (status === 'idle' || status === 'pending') return null;
  const tone =
    status === 'translating' ? 'blue' : status === 'success' ? 'success' : status === 'failed' ? 'error' : 'warning';
  const glyph =
    status === 'success' ? 'check' : status === 'failed' ? 'cross' : status === 'warning' ? 'bang' : null;
  return (
    <span
      className={`mt-thumb__status mt-thumb__status--${tone}`}
      style={{ width: S.statusDot.size, height: S.statusDot.size, top: S.statusDot.inset, right: S.statusDot.inset }}
      aria-hidden="true"
    >
      {status === 'translating' ? <span className="mt-thumb__statusspin" /> : null}
      {glyph ? <IconStatusGlyph kind={glyph} size={10} /> : null}
    </span>
  );
}

/**
 * L6 更多菜单 —— 168 宽、两项（《01》§6.3）。
 *
 * ver1.0 收敛为两项：**「定位图片」可用** + **「更多功能」永久置灰**。
 *
 * 置灰项的三个要点（缺一即不合规）：
 *   1. 文字 `$3:6` muted + 整项 `opacity 60%`
 *   2. **不接收指针事件**
 *   3. **不参与 Tab 序列**；读屏用 `aria-disabled="true"`（而非 `disabled`），
 *      使其**可被朗读但不可激活** —— 「保留可见而非隐藏」的理由是：
 *      隐藏之后用户无从判断是「没有」还是「没找到」。
 */
function MoreMenu({
  cellRef,
  locateAvailable,
  onLocate,
}: {
  cellRef: React.RefObject<HTMLDivElement | null>;
  locateAvailable: boolean;
  onLocate: () => void;
}) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: HB.x, top: HB.y + HB.h + 6 });

  // 锚定在悬停条下方、**左对齐该格**；距面板右缘不足 168 时向左翻转（《01》§6.3）
  useEffect(() => {
    const panel = cellRef.current?.closest('.mt-panel');
    if (!panel || !menuRef.current) return;
    const cellRect = (cellRef.current as HTMLElement).getBoundingClientRect();
    const panelRect = (panel as HTMLElement).getBoundingClientRect();
    let left = HB.x;
    const desiredRight = cellRect.left + HB.x + MORE_MENU.width;
    if (desiredRight > panelRect.right - 8) {
      // 翻转：让菜单右缘贴住该格右缘
      left = HB.x + HB.w - MORE_MENU.width;
    }
    setPos({ left, top: HB.y + HB.h + 6 });
  }, [cellRef]);

  return (
    <div
      ref={menuRef}
      className="mt-menu"
      role="menu"
      data-testid="more-menu"
      style={{
        width: MORE_MENU.width,
        borderRadius: MORE_MENU.radius,
        padding: MORE_MENU.padding,
        gap: MORE_MENU.itemGap,
        left: pos.left,
        top: pos.top,
        boxShadow: MORE_MENU.shadow,
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <button
        type="button"
        role="menuitem"
        className="mt-menu__item mt-menu__item--active"
        data-testid="menu-locate"
        style={{ height: MORE_MENU.itemH, borderRadius: MORE_MENU.itemRadius }}
        disabled={!locateAvailable}
        aria-disabled={!locateAvailable}
        onClick={onLocate}
      >
        <IconLocate size={16} />
        <span>定位图片</span>
      </button>

      <div
        role="menuitem"
        className="mt-menu__item mt-menu__item--disabled"
        data-testid="menu-more-disabled"
        aria-disabled="true"
        // 不参与 Tab 序列 + 不接收指针事件
        tabIndex={-1}
        style={{ height: MORE_MENU.itemH, borderRadius: MORE_MENU.itemRadius }}
      >
        <span className="mt-menu__placeholder" aria-hidden="true" />
        <span>更多功能</span>
      </div>
    </div>
  );
}
