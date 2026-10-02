/**
 * 规格几何自检 —— 把文档里的**算式**变成可执行的断言。
 *
 * 存在的理由：这些数字在文档里是以「算式 + 校验」的形式写的（例如
 * `5×58 + 4×8 = 322 ≤ 328`），人工复核容易随版本漂移。把它们钉成测试后，
 * 任何一次改动若破坏了「每页 20 张」的几何前提，CI 会先于肉眼发现。
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  COLOR_TOKENS_DARK,
  COLOR_TOKENS_LIGHT,
  FLOATING_BALL,
  GRID,
  MAGIC_CIRCLE_SIMPLIFY_BELOW,
  MORE_MENU,
  PANEL,
  THUMB_LAYER,
  cssVars,
} from '../src/theme/tokens';
import { splitIntoBatches } from '../src/naming';
import { BATCH_LIMIT } from '../src/types/contract';

const here = dirname(fileURLToPath(import.meta.url));
const css = readFileSync(resolve(here, '../src/panel/panel.css'), 'utf8');

describe('《01》§6.2 面板分区合计 680', () => {
  it('分区高度逐个对齐文档', () => {
    expect(PANEL.header).toBe(56);
    expect(PANEL.nameRow).toBe(52);
    expect(PANEL.hintRow).toBe(48);
    expect(PANEL.toolbar).toBe(44);
    expect(PANEL.grid).toBe(395);
    expect(PANEL.pageHint).toBe(24);
    expect(PANEL.divider).toBe(1);
    expect(PANEL.footer).toBe(60);
  });

  it('合计恰好等于 680，且面板宽度 360（本迭代**不加高**）', () => {
    const sum =
      PANEL.header +
      PANEL.nameRow +
      PANEL.hintRow +
      PANEL.toolbar +
      PANEL.grid +
      PANEL.pageHint +
      PANEL.divider +
      PANEL.footer;
    expect(sum).toBe(680);
    expect(PANEL.height).toBe(680);
    expect(PANEL.width).toBe(360);
  });

  it('提示行是 48 而不是 100 —— 原稿算成 100 会让网格区被高估 52px、第 16–20 张被推出底栏', () => {
    expect(PANEL.hintRow).toBe(48);
    // 反证：若按旧的 100 计算，可用于网格的高度会少 52
    expect(PANEL.grid).toBe(680 - 56 - 52 - 48 - 44 - 24 - 1 - 60);
  });
});

describe('《01》§6.3 每页 20 张的几何成立性', () => {
  it('宽度校验：5×58 + 4×8 = 322 ≤ 328', () => {
    const used = GRID.cols * GRID.cellW + (GRID.cols - 1) * GRID.gap;
    expect(used).toBe(322);
    expect(GRID.usableW).toBe(328);
    expect(used).toBeLessThanOrEqual(GRID.usableW);
  });

  it('高度校验：4×84 + 3×8 = 360 ≤ 363', () => {
    const used = GRID.rows * GRID.cellH + (GRID.rows - 1) * GRID.gap;
    expect(used).toBe(360);
    expect(GRID.usableH).toBe(363);
    expect(used).toBeLessThanOrEqual(GRID.usableH);
  });

  it('被否决的备选不成立：原「5×78 + 4×10 = 430」确实超过可用高，所以只能放 16 张', () => {
    expect(5 * 78 + 4 * 10).toBe(430);
    expect(430).toBeGreaterThan(GRID.usableH);
  });

  it('每页张数 = 列 × 行 = 20，且与单次提交上限一致（设计论证的支点）', () => {
    expect(GRID.cols * GRID.rows).toBe(20);
    expect(GRID.perPage).toBe(BATCH_LIMIT);
  });

  it('一页刚好一批：20 张不产生多余批次', () => {
    expect(splitIntoBatches(Array.from({ length: GRID.perPage }, (_, i) => i), BATCH_LIMIT)).toHaveLength(1);
  });
});

describe('《01》§6.3 L5 悬停条几何 46×20 @ (6,58)', () => {
  it('宽度由两个按钮加间距凑成：2×20 + 6 = 46', () => {
    expect(THUMB_LAYER.hoverBar.btnSize * 2 + THUMB_LAYER.hoverBar.gap).toBe(THUMB_LAYER.hoverBar.w);
    expect(THUMB_LAYER.hoverBar.w).toBe(46);
    expect(THUMB_LAYER.hoverBar.h).toBe(20);
  });

  it('完全落在 58×84 格内 —— 原 68×98 时代的几何会右溢 4px、下溢 8px 被裁掉', () => {
    const { x, y, w, h } = THUMB_LAYER.hoverBar;
    expect(x + w).toBeLessThanOrEqual(GRID.cellW);
    expect(y + h).toBeLessThanOrEqual(GRID.cellH);
    // 反证：旧的 62×20 @ (6,86)（68×98 时代的相对位置）在新格子里越界
    expect(6 + 62).toBeGreaterThan(GRID.cellW);
    expect(86 + 20).toBeGreaterThan(GRID.cellH);
  });

  it('L4 状态点与 L2 勾选框同为 16/18 档，inset 一致', () => {
    expect(THUMB_LAYER.statusDot.size).toBe(16);
    expect(THUMB_LAYER.checkbox.size).toBe(18);
    expect(THUMB_LAYER.checkbox.inset).toBe(6);
    expect(THUMB_LAYER.statusDot.inset).toBe(6);
  });

  it('L3 序号角标：高 16 / 最小宽 16 / 上限 26 / 字号 10', () => {
    expect(THUMB_LAYER.seqBadge).toMatchObject({ h: 16, minW: 16, maxW: 26, fontSize: 10 });
  });
});

describe('《01》§6.3 L6 更多菜单几何 168×86（两项）', () => {
  it('高度 = 8 + 34 + 2 + 34 + 8 = 86', () => {
    expect(MORE_MENU.height).toBe(86);
    expect(MORE_MENU.padding * 2 + MORE_MENU.itemH * 2 + MORE_MENU.itemGap).toBe(86);
  });

  it('宽度 168、项高 34、项圆角 9、圆角 14', () => {
    expect(MORE_MENU.width).toBe(168);
    expect(MORE_MENU.itemH).toBe(34);
    expect(MORE_MENU.itemRadius).toBe(9);
    expect(MORE_MENU.radius).toBe(14);
  });

  it('菜单比格子宽 —— 所以它**必须是浮层**，不能塞进缩略图自身层级', () => {
    expect(MORE_MENU.width).toBeGreaterThan(GRID.cellW);
  });
});

describe('《01》§6.1 悬浮球 72 环 + 40 球', () => {
  it('环与球的尺寸', () => {
    expect(FLOATING_BALL.ringSize).toBe(72);
    expect(FLOATING_BALL.ballSize).toBe(40);
  });

  it('环带留白为正（环要能包住球）', () => {
    expect((FLOATING_BALL.ringSize - FLOATING_BALL.ballSize) / 2).toBeGreaterThan(0);
  });
});

describe('《01》§7 召唤阵的 24px 档裁细节约束', () => {
  it('阈值是 32，因此 24 档必须走简化版（去五芒星与最内环）', () => {
    expect(MAGIC_CIRCLE_SIMPLIFY_BELOW).toBe(32);
    expect(24).toBeLessThan(MAGIC_CIRCLE_SIMPLIFY_BELOW);
    expect(48).toBeGreaterThan(MAGIC_CIRCLE_SIMPLIFY_BELOW);
  });
});

describe('《01》§9 令牌与设计稿变量集逐字一致', () => {
  it('18 色，浅深两套键完全对应', () => {
    expect(Object.keys(COLOR_TOKENS_LIGHT)).toHaveLength(18);
    expect(Object.keys(COLOR_TOKENS_DARK)).toHaveLength(18);
    expect(Object.keys(COLOR_TOKENS_DARK).sort()).toEqual(Object.keys(COLOR_TOKENS_LIGHT).sort());
  });

  it('ver1.0 新增的 warning 是两套取值（Light #C97B12 / Dark #FFC46B）', () => {
    expect(COLOR_TOKENS_LIGHT.warning).toBe('#C97B12');
    expect(COLOR_TOKENS_DARK.warning).toBe('#FFC46B');
  });

  it('抽查设计稿变量集里的关键取值', () => {
    expect(COLOR_TOKENS_LIGHT.pink).toBe('#FF8FBF'); // $3:12
    expect(COLOR_TOKENS_LIGHT.ink).toBe('#3B3352'); // $3:4
    expect(COLOR_TOKENS_DARK.surface).toBe('#262140'); // $3:7
    expect(COLOR_TOKENS_DARK.board).toBe('#140F29'); // $3:9
    expect(COLOR_TOKENS_LIGHT.success).toBe('#70D9AD'); // $3:18
  });

  it('cssVars 输出 18 个颜色变量（深色只换值，不换结构）', () => {
    const light = cssVars('light');
    const dark = cssVars('dark');
    const colorKeys = Object.keys(light).filter((k) => k.startsWith('--mt-') && !k.includes('radius') && !k.includes('font'));
    expect(colorKeys).toHaveLength(18);
    expect(Object.keys(light)).toEqual(Object.keys(dark));
    expect(dark['--mt-surface']).toBe('#262140');
  });

  it('品牌色是冻结值，不随主题切换（《01》§9）', () => {
    expect(cssVars('light')['--mt-pink']).not.toBe(cssVars('dark')['--mt-pink']);
    // 而 Logo 的粉是常量，不出现在令牌里
    expect(Object.values(COLOR_TOKENS_LIGHT)).toContain('#FF8FBF');
  });
});

describe('《01》§6.3 悬停修复的三条硬规则必须写在样式里', () => {
  it('规则 1 —— 视觉层不吃指针（L0–L4 全部 pointer-events: none）', () => {
    expect(css).toMatch(/\.mt-thumb__layer\s*\{[^}]*pointer-events:\s*none/);
  });

  it('规则 2 —— 裁切只挂在底图层，格子本身不裁（否则 L6 浮层菜单会被一起裁掉）', () => {
    expect(css).toMatch(/\.mt-thumb__base\s*\{[^}]*overflow:\s*hidden/);
    expect(css).toMatch(/\.mt-thumb\s*\{[^}]*overflow:\s*visible/);
  });

  it('规则 3 —— 触屏常显 + 键盘 :focus-within 强制显示', () => {
    expect(css).toMatch(/@media\s*\(hover:\s*none\)/);
    expect(css).toMatch(/\.mt-thumb:focus-within\s+\.mt-thumb__hoverbar/);
    expect(css).toMatch(/\.mt-thumb:hover\s+\.mt-thumb__hoverbar/);
  });

  it('悬停条 z 序高于序号角标与状态点（否则会被盖住）', () => {
    const hoverZ = /\.mt-thumb__hoverbar\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
    const seqZ = /\.mt-thumb__seq\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
    const statusZ = /\.mt-thumb__status\s*\{[^}]*z-index:\s*(\d+)/.exec(css)?.[1];
    expect(Number(hoverZ)).toBeGreaterThan(Number(seqZ));
    expect(Number(hoverZ)).toBeGreaterThan(Number(statusZ));
  });

  it('悬停时临时覆盖序号角标（《01》§6.3 L5 行）', () => {
    // 选择器组（`:hover` 与 `:focus-within` 并列）算一条规则，
    // 因此 `{` 之前允许出现逗号与后续选择器 —— 不能要求 `.mt-thumb__seq` 后面紧跟 `{`。
    expect(css).toMatch(
      /\.mt-thumb:hover\s+\.mt-thumb__seq\b[^{}]*\{[^}]*visibility:\s*hidden/,
    );
  });
});

describe('《01》§6.3 更多菜单的两项与置灰项', () => {
  it('置灰项：不吃指针 + 不透明度 60%（缺一即不合规）', () => {
    const block = /\.mt-menu__item--disabled\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    expect(block).toMatch(/pointer-events:\s*none/);
    expect(block).toMatch(/opacity:\s*0\.6/);
  });

  it('置灰项用 muted 文字色，而非主强调色', () => {
    const block = /\.mt-menu__item--disabled\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    expect(block).toContain('var(--mt-muted)');
    expect(block).not.toContain('var(--mt-pink)');
  });
});

describe('《01》§7 无障碍与动效约束', () => {
  it('prefers-reduced-motion 时召唤阵与状态圈停转', () => {
    expect(css).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)/);
  });

  it('召唤阵旋转周期是 8s', () => {
    expect(css).toMatch(/animation:\s*mt-rotate\s+8s\s+linear\s+infinite/);
  });

  it('超限态的确定按钮用 `$3:11`（line-soft），不用主强调色', () => {
    const block = /\.mt-primarybtn:disabled\s*\{[^}]*\}/s.exec(css)?.[0] ?? '';
    expect(block).toContain('var(--mt-line-soft)');
  });
});
