/**
 * 翻译方向 —— ver2.1 插件端新增（英译中）。
 *
 * 背景：引擎默认档只做「日译中」；英文漫画必须由服务端按方向切到离线 `nllb`
 * （见 `miao-dock` 的 `service/src/config.mjs::buildEngineConfig`）。方向是**逐任务**
 * 参数，随建单下发（《03》§5.2 的 `payload.lang`），因此插件侧只需给出**有限白名单**，
 * 不允许自由输入 —— 服务端对非法方向会硬拒（400 `INVALID_TRANSLATE_LANG`）。
 *
 * 白名单与 `miao-dock` 服务端 `TRANSLATE_DIRECTIONS` **逐条对齐**；两侧不一致时，
 * 插件发出的方向会在服务端被判非法，表现为提交报错（比静默翻错语言好，但仍是缺陷）。
 */

/** 方向的纯数据形态（可进 Redux；`label` 只属于 UI，不进状态） */
export interface DirectionCode {
  /** 源语言短码 */
  from: string;
  /** 目标语言短码 */
  to: string;
}

/** 带界面文案的方向项 */
export interface TranslateDirection extends DirectionCode {
  label: string;
}

/** 默认方向：日译中（与引擎默认档、服务端默认方向一致） */
export const DEFAULT_DIRECTION: DirectionCode = { from: 'ja', to: 'zh' };

/** 可选方向白名单 —— 与 `miao-dock` 的 `TRANSLATE_DIRECTIONS` 对齐 */
export const TRANSLATE_DIRECTIONS: readonly TranslateDirection[] = [
  { from: 'ja', to: 'zh', label: '日译中' },
  { from: 'en', to: 'zh', label: '英译中' },
];

/** 两个方向是否等价（分段控件选中态判定的唯一口径） */
export function sameDirection(a: DirectionCode, b: DirectionCode): boolean {
  return a.from === b.from && a.to === b.to;
}

/** 方向对应的界面文案；不在白名单内时回落为「短码>短码」（不猜、不抛） */
export function labelOfDirection(d: DirectionCode): string {
  const hit = TRANSLATE_DIRECTIONS.find((x) => sameDirection(x, d));
  return hit ? hit.label : `${d.from}>${d.to}`;
}
