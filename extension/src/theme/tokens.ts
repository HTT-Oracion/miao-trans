/**
 * 设计令牌 —— 值与设计稿《插件与box ver1.0》的变量集**逐字一致**。
 *
 * 来源：设计稿文件 732136506189423 的 Color 变量集（id `3:2`），
 *       Light 模式 `3:1` / Dark 模式 `3:3`。共 18 色（ver1.0 新增 warning）。
 * 说明：`$3:n` 是设计稿里的变量 id，保留在注释里以便与设计稿对账。
 */

export const COLOR_TOKENS_LIGHT = {
  ink: '#3B3352', // $3:4
  'ink-2': '#5C5478', // $3:5
  muted: '#8C85A3', // $3:6
  surface: '#FFFFFF', // $3:7
  'surface-2': '#F5F5FF', // $3:8
  board: '#FAFAFF', // $3:9
  line: '#E5DEF5', // $3:10
  'line-soft': '#F0EBFA', // $3:11
  pink: '#FF8FBF', // $3:12
  'pink-soft': '#FFE0ED', // $3:13
  blue: '#8FC7FF', // $3:14
  'blue-soft': '#DEEDFF', // $3:15
  lavender: '#C9B5FF', // $3:16
  yellow: '#FFE066', // $3:17
  success: '#70D9AD', // $3:18
  error: '#FF7D85', // $3:19
  'on-accent': '#FFFFFF', // $3:20
  warning: '#C97B12', // $3:21（ver1.0 新增，用于「部分失败」）
} as const;

export const COLOR_TOKENS_DARK = {
  ink: '#F5F2FF',
  'ink-2': '#C9C2E0',
  muted: '#9994B8',
  surface: '#262140',
  'surface-2': '#2E294F',
  board: '#140F29',
  line: '#3B3361',
  'line-soft': '#292447',
  pink: '#FF9EC4',
  'pink-soft': '#4A2440',
  blue: '#8FC7FF',
  'blue-soft': '#1F304F',
  lavender: '#C9B5FF',
  yellow: '#FFE066',
  success: '#80E3BD',
  error: '#FF99A1',
  'on-accent': '#291A2E',
  warning: '#FFC46B',
} as const;

export type TokenName = keyof typeof COLOR_TOKENS_LIGHT;
export type ThemeMode = 'light' | 'dark';

/** 《01》§9：圆角档 */
export const RADIUS = {
  xs: 6,
  sm: 10,
  md: 16,
  lg: 22,
  xl: 28,
  thumb: 14,
} as const;

/** 《01》§9：字体分工 —— Zen Maru Gothic（标题/强调）、Noto Sans SC（正文）、Inter Medium（纯数字） */
export const FONT = {
  display: "'Zen Maru Gothic', 'Noto Sans SC', system-ui, sans-serif",
  body: "'Noto Sans SC', 'Zen Maru Gothic', system-ui, sans-serif",
  numeric: "'Inter', 'Noto Sans SC', system-ui, sans-serif",
} as const;

/** 品牌色为冻结值 —— 不绑令牌、不随主题切换（《01》§9） */
export const BRAND = {
  catEar: '#FF8FBF',
  bubble: '#FFFFFF',
  blush: '#FFC2D8',
} as const;

/**
 * 面板几何 —— 全部取自《01》§6.2 / §6.3 与设计稿规格卡，逐值可对账。
 *
 * | 分区            | 高  |
 * |-----------------|-----|
 * | 面板头           | 56  |
 * | 漫画名行         | 52  |
 * | 提示行           | 48  |
 * | 工具条           | 44  |
 * | 网格区           | 395 |
 * | 本页提示行       | 24  |
 * | 分隔线           | 1   |
 * | 底栏             | 60  |
 * | 合计             | 680 |
 */
export const PANEL = {
  width: 360,
  height: 680,
  radius: 24,
  header: 56,
  nameRow: 52,
  hintRow: 48,
  toolbar: 44,
  grid: 395,
  pageHint: 24,
  divider: 1,
  footer: 60,
  padding: 16,
} as const;

/**
 * 网格与缩略图几何（《01》§6.3）
 * 宽：5×58 + 4×8 = 322 ≤ 328 ✓ ｜ 高：4×84 + 3×8 = 360 ≤ 363 ✓
 */
export const GRID = {
  cellW: 58,
  cellH: 84,
  gap: 8,
  cols: 5,
  rows: 4,
  perPage: 20,
  radius: RADIUS.thumb,
  get usableW() {
    return PANEL.width - PANEL.padding * 2; // 328
  },
  get usableH() {
    return PANEL.grid - PANEL.padding * 2; // 363
  },
} as const;

/** 缩略图各层几何（L0–L6） */
export const THUMB_LAYER = {
  /** L2 勾选框 18×18，inset 6 */
  checkbox: { size: 18, radius: 6, inset: 6 },
  /** L3 序号角标 高 16 / 最小宽 16（两位数自适应，上限 26），圆角 6，inset 4 */
  seqBadge: { h: 16, minW: 16, maxW: 26, radius: 6, inset: 4, fontSize: 10 },
  /** L4 状态点 16×16 圆 */
  statusDot: { size: 16, inset: 6 },
  /** L5 悬停条 46×20 @ (6,58) —— 2×20 + 6 = 46 ✓，58+20 = 78 ≤ 84 ✓ */
  hoverBar: { w: 46, h: 20, x: 6, y: 58, radius: 6, btnSize: 20, gap: 6 },
  /** L1 选中态描边 2px */
  selectBorder: 2,
  /** L1 选中态蒙层 pink-soft @18% */
  selectOverlay: 0.18,
  /** L3 序号角标底 board @88% */
  seqBadgeBg: 0.88,
} as const;

/** L6 更多菜单几何（《01》§6.3）—— 两项合计 86 高（8 + 34 + 2 + 34 + 8） */
export const MORE_MENU = {
  width: 168,
  radius: 14,
  padding: 8,
  itemH: 34,
  itemGap: 2,
  itemRadius: 9,
  shadow: '0 18px 40px -10px rgba(59, 51, 82, 0.24)',
  get height() {
    return this.padding * 2 + this.itemH * 2 + this.itemGap; // 86
  },
} as const;

/** 悬浮球几何（《01》§6.1）：收起态两层 —— 外进度环 72 + 内球 40 */
export const FLOATING_BALL = {
  ringSize: 72,
  ballSize: 40,
  /** 环笔画宽（视觉：72 环以内切 40 球，留 16 的环带） */
  ringStroke: 4,
  zIndex: 2_147_483_000,
} as const;

/** 召唤阵三档尺寸（《01》§7 落点 + 设计稿规格卡） */
export const MAGIC_CIRCLE_SIZES = {
  hintRow: 24, // ① 插件提示行左侧
  ballRing: 72, // ② 悬浮球收起态
  queueEmpty: 160, // ③ Box 队列空态（本迭代不实现 Box 端，规格保留）
  spec: [24, 48, 96] as const,
} as const;

/**
 * 24px 档的细节裁剪阈值（《01》§7 约束）。
 * 图形线宽 <1px 必然发糊 —— 24px 档必须去掉五芒星与最内环。
 */
export const MAGIC_CIRCLE_SIMPLIFY_BELOW = 32;

/** 生成一组 CSS 变量，供面板样式表使用（深色模式只换变量，不换结构 —— 《01》§9 + README §3） */
export function cssVars(mode: ThemeMode): Record<string, string> {
  const src = mode === 'dark' ? COLOR_TOKENS_DARK : COLOR_TOKENS_LIGHT;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(src)) out[`--mt-${k}`] = v;
  out['--mt-radius-xs'] = `${RADIUS.xs}px`;
  out['--mt-radius-sm'] = `${RADIUS.sm}px`;
  out['--mt-radius-md'] = `${RADIUS.md}px`;
  out['--mt-radius-lg'] = `${RADIUS.lg}px`;
  out['--mt-radius-xl'] = `${RADIUS.xl}px`;
  out['--mt-radius-thumb'] = `${RADIUS.thumb}px`;
  out['--mt-font-display'] = FONT.display;
  out['--mt-font-body'] = FONT.body;
  out['--mt-font-numeric'] = FONT.numeric;
  return out;
}
