/**
 * 回写与定位 —— 《01》§6.4 P0-1 的落地实现。
 *
 * 回写是整条链路唯一**破坏网页现状**的动作，因此校验最严：
 * 写回前必须 `img.isConnected && img.currentSrc === expectedUrl`，
 * 任一不成立即跳过，并把该张标记为「原图已离开页面」。
 */

import { canWriteBack } from '../selection/rules';

/** 回写后挂的标记属性 —— 供「定位图片」「导出」与自检脚本查询 */
export const MARK_ATTR = 'data-miao-translated';
export const ORIGINAL_SRC_ATTR = 'data-miao-original-src';
export const LOCATE_HIGHLIGHT_ATTR = 'data-miao-locate-highlight';

export type WriteBackResult =
  | { ok: true; seq: number }
  | { ok: false; seq: number; reason: 'left-dom' | 'src-mismatch' | 'not-found' };

/**
 * 已回写记录 —— 保留可回滚能力。
 *
 * 设计取舍：插件**不落任何文件**（《01》§10），也不把译文写 storage；这里只持有
 * 内存态的对象 URL，页面关闭即释放。回写前的原 `src` 存在 DOM 属性里而非内存，
 * 因为内存态在 content script 重载后会丢，而 DOM 属性还在。
 */
export interface WriteBackRecord {
  seq: number;
  element: HTMLImageElement;
  /** 回滚用：原始 src */
  originalSrc: string;
  /** 创建的 blob URL，卸载时需 revokeObjectURL */
  objectUrl: string;
}

const records = new Map<number, WriteBackRecord>();

/** 按 seq 精确回写（**绝不**按选择器或位置回写 —— 新页第 3 个 img 未必是原页第 3 张） */
export function writeBackImage(
  seq: number,
  element: HTMLImageElement | null,
  expectedUrl: string,
  translated: Blob,
): WriteBackResult {
  if (!element) return { ok: false, seq, reason: 'not-found' };

  const verdict = canWriteBack({
    isConnected: element.isConnected,
    currentSrc: element.currentSrc || element.src,
    expectedUrl,
  });
  if (!verdict.ok) return { ok: false, seq, reason: verdict.reason };

  // 幂等：同一张重复回写时先释放旧的 blob URL
  const prev = records.get(seq);
  if (prev) URL.revokeObjectURL(prev.objectUrl);

  const objectUrl = URL.createObjectURL(translated);
  const originalSrc = element.getAttribute('src') ?? '';

  element.setAttribute(ORIGINAL_SRC_ATTR, originalSrc);
  element.setAttribute(MARK_ATTR, String(seq));
  element.src = objectUrl;

  records.set(seq, { seq, element, originalSrc, objectUrl });
  return { ok: true, seq };
}

/**
 * 找出某张原图当前对应的 `<img>`。
 *
 * 依据是**抓取时记录的 expectedUrl**：从页面现存 img 里找 `currentSrc` 相等且
 * 尚未回写过的那一个。这比记元素引用更抗 DOM 复用（SPA 场景下节点会被回收再利用）。
 */
export function findImageByExpectedUrl(
  expectedUrl: string,
  root: ParentNode = document,
): HTMLImageElement | null {
  const imgs = Array.from(root.querySelectorAll('img'));
  for (const img of imgs) {
    if (img.hasAttribute(MARK_ATTR)) continue;
    const current = img.currentSrc || img.src;
    if (!current) continue;
    try {
      if (new URL(current, 'http://127.0.0.1/').href === new URL(expectedUrl, 'http://127.0.0.1/').href) {
        return img;
      }
    } catch {
      if (current === expectedUrl) return img;
    }
  }
  return null;
}

/** 回滚单张（用于自检与调试；正常路径不暴露给用户） */
export function revertImage(seq: number): boolean {
  const rec = records.get(seq);
  if (!rec) return false;
  if (rec.element.isConnected) rec.element.src = rec.originalSrc;
  rec.element.removeAttribute(MARK_ATTR);
  rec.element.removeAttribute(ORIGINAL_SRC_ATTR);
  URL.revokeObjectURL(rec.objectUrl);
  records.delete(seq);
  return true;
}

/** 页面卸载时释放全部 blob URL */
export function releaseAllWriteBacks(): void {
  for (const rec of records.values()) URL.revokeObjectURL(rec.objectUrl);
  records.clear();
}

export function getWriteBackRecords(): WriteBackRecord[] {
  return [...records.values()];
}

// ─────────────────────────── 定位图片 ───────────────────────────

/**
 * 滚动结果 —— 只有「成功 / 失败」两值是不够的。
 *
 * 失败至少有四种**含义完全不同**的情况，混成一个 false 就只能给出一句没用的提示，
 * 用户无法区分「我该换页去看」还是「插件坏了」。因此逐条分开，由 `LOCATE_NOTICE` 一对一呈现。
 */
export type ScrollOutcome =
  | 'scrolled' /** 已滚动到该图 */
  | 'already-visible' /** 无需滚动：该图本来就在视口里 */
  | 'no-layout' /** 该图当前不参与布局（懒加载占位 / 被隐藏），滚过去也没有意义 */
  | 'not-scrollable'; /** 该图所在容器不可滚动（站点自定义滚动 / overflow 链断裂） */

export type LocateResult = { ok: true; scroll: ScrollOutcome } | { ok: false };

/** 提示语与 `ScrollOutcome` **一一对应**（单测钉死：「成功」不能拿去描述「没滚动」） */
export const LOCATE_NOTICE: Record<ScrollOutcome, string> = {
  scrolled: '已定位：页面已滚动到该图，高亮 1.2 秒',
  'already-visible': '已定位：该图已在可视区域内，高亮 1.2 秒',
  'no-layout': '已高亮，但该图当前未参与布局（懒加载占位或被隐藏），无法滚动过去',
  'not-scrollable': '已高亮，但该图所在容器不可滚动，页面没能动',
};

/** 小于此尺寸视为「没有布局」—— 1×1 懒加载占位 gif 与 jsdom 都落在这里 */
const MIN_LAYOUT_PX = 4;
/** 视口内可见比例达到这个值就算「已经在眼前」，不必再滚 */
const VISIBLE_ENOUGH = 0.6;

/** 该元素在视口中的可见比例（0~1）；高度异常时按 0 处理 */
function visibleRatio(rect: DOMRect): number {
  const vh = window.innerHeight || document.documentElement?.clientHeight || 0;
  if (vh <= 0 || rect.height <= 0) return 0;
  const inter = Math.max(0, Math.min(rect.bottom, vh) - Math.max(rect.top, 0));
  return inter / Math.min(rect.height, vh);
}

/**
 * 从 `element` 起向上找**第一个真正参与布局**的节点作为滚动目标。
 *
 * 为什么需要爬：图片本身可能是 0 高（懒加载占位、`content-visibility` 折叠），
 * 此时拿它算滚动位置没有意义，但它外面那层包裹 div 是有布局的 —— 滚到那层才对。
 * 反过来，如果元素**被显式隐藏**（`display:none` / `visibility:hidden`），
 * 祖先有布局也不该滚（滚过去用户还是看不到），如实判 `no-layout`。
 */
export function nearestLaidOutAncestor(element: HTMLElement | null): HTMLElement | null {
  let cur: HTMLElement | null = element;
  while (cur) {
    const r = cur.getBoundingClientRect();
    if (r.width >= MIN_LAYOUT_PX && r.height >= MIN_LAYOUT_PX) return cur;
    let cs: CSSStyleDeclaration | undefined;
    try {
      cs = getComputedStyle(cur);
    } catch {
      cs = undefined;
    }
    if (cs && (cs.display === 'none' || cs.visibility === 'hidden')) return null;
    cur = cur.parentElement;
  }
  return null;
}

function isScrollableY(el: HTMLElement): boolean {
  let overflowY = '';
  try {
    overflowY = getComputedStyle(el).overflowY || '';
  } catch {
    return false;
  }
  if (overflowY !== 'auto' && overflowY !== 'scroll' && overflowY !== 'overlay') return false;
  return el.scrollHeight - el.clientHeight > 1;
}

/** 可滚动的祖先，**内 → 外**；文档滚动器永远排在最后 */
export function collectScrollers(element: HTMLElement): HTMLElement[] {
  const out: HTMLElement[] = [];
  const se = (document.scrollingElement ?? document.documentElement) as HTMLElement | null;
  for (let p = element.parentElement; p; p = p.parentElement) {
    if (p === se || p === document.body) continue;
    if (isScrollableY(p)) out.push(p);
  }
  if (se) out.push(se);
  return out;
}

/** 把 `target` 在 `scroller` 里垂直居中（目标比容器高时退化为顶部对齐） */
export function centerWithin(target: HTMLElement, scroller: HTMLElement): void {
  const r = target.getBoundingClientRect();
  const cr = scroller.getBoundingClientRect();
  const visibleH = scroller.clientHeight || window.innerHeight || 0;
  const delta = r.top - cr.top - Math.max(0, (visibleH - r.height) / 2);
  if (!Number.isFinite(delta) || Math.abs(delta) < 2) return; // 已居中，别做无意义的滚动
  try {
    scroller.scrollTop += delta;
  } catch {
    /* 极少：只读容器。不影响高亮 */
  }
}

/**
 * 把一个元素滚进视口 —— 「定位图片」的滚动部分。
 *
 * 为什么不能只调 `scrollIntoView` 就完事：它在部分站点上是**静默 no-op**（不抛异常、
 * 页面纹丝不动），而调用方拿到的是 undefined，无从判断 ⇒ 用户看到「点了没反应」。
 * 因此这里分三步，且**每步都可判**：
 *   ① 先确认目标真的参与布局，否则滚了也白滚（如实报 `no-layout`）；
 *   ② 再走浏览器原生（能正确处理 `scroll-margin` / sticky / 嵌套滚动容器）；
 *   ③ 原生无效则**逐层手动居中**兜底 —— 每层都重新量，因为内层滚完会改变外层的相对位置。
 *
 * 用**瞬时**滚动（`behavior: 'auto'`）而非 smooth：长漫画页上平滑滚动动辄上千像素，
 * 既慢又让「有没有滚成功」无法同步判定 —— 而判定不了，提示就只能是句谎话。
 */
export function scrollElementIntoView(element: HTMLElement): ScrollOutcome {
  const target = nearestLaidOutAncestor(element);
  if (!target) return 'no-layout';

  if (visibleRatio(target.getBoundingClientRect()) >= VISIBLE_ENOUGH) return 'already-visible';

  const scrollers = collectScrollers(target);
  if (scrollers.length === 0) return 'not-scrollable';

  try {
    target.scrollIntoView({ block: 'center', inline: 'nearest' });
  } catch {
    /* 原生不可用 → 走下面的手动兜底 */
  }

  if (visibleRatio(target.getBoundingClientRect()) < VISIBLE_ENOUGH) {
    for (const sc of scrollers) centerWithin(target, sc);
  }

  return visibleRatio(target.getBoundingClientRect()) >= VISIBLE_ENOUGH
    ? 'scrolled'
    : 'not-scrollable';
}

/**
 * 「定位图片」—— 菜单内唯一可执行项（《01》§6.3）。
 *
 * 行为：滚动到该原图并高亮 **1.2s**（2px `pink` 描边、闪烁 2 次 × 300ms）。
 * 纯定位、不改数据，任何面板状态都可点。
 *
 * 返回值带滚动结果：调用方**必须**据此出提示（此前无条件说「已滚动」，
 * 实际没滚时也这么说，等于骗用户；这是本轮报障的直接成因之一）。
 */
export function locateImage(
  element: HTMLImageElement,
  options: { totalMs?: number; blinkMs?: number; blinks?: number } = {},
): LocateResult {
  const totalMs = options.totalMs ?? 1_200;
  const blinkMs = options.blinkMs ?? 300;
  const blinks = options.blinks ?? 2;

  if (!element.isConnected) return { ok: false };

  // ① 滚动：结果逐条可判，失败也如实回传
  const scroll = scrollElementIntoView(element);

  element.setAttribute(LOCATE_HIGHLIGHT_ATTR, '1');

  // ② 高亮必须带 important —— 站点 CSS 常写 `img { outline: none }`，
  //    普通内联样式会被它盖掉，表现为「点了没反应」
  const paint = (on: boolean): void => {
    element.style.setProperty('outline', on ? '2px solid #FF8FBF' : 'none', 'important');
    element.style.setProperty('outline-offset', on ? '2px' : '0', 'important');
  };
  const clear = (): void => {
    element.style.removeProperty('outline');
    element.style.removeProperty('outline-offset');
    element.removeAttribute(LOCATE_HIGHLIGHT_ATTR);
  };

  // 立即画上第一帧 —— 否则要等第一个 tick（300ms）才见描边，
  // 用户会先看到一段「什么都没发生」的空窗，判定为没生效
  paint(true);

  let count = 0;
  const timer = window.setInterval(() => {
    count += 1;
    paint(count % 2 === 1);
    if (count >= blinks * 2) {
      window.clearInterval(timer);
      clear();
    }
  }, blinkMs);

  // 保底清理：即使定时器被后台节流，也不留下永久描边
  window.setTimeout(() => {
    window.clearInterval(timer);
    clear();
  }, totalMs);

  return { ok: true, scroll };
}

/**
 * 为「定位图片」解析当前应高亮的元素。
 *
 * 三级兜底，**顺序不能反**：
 *   ① 抓取时存下的元素引用 —— 最快，节点还在就直接用
 *   ② 按 `originalSrc` 找回**已回写**的元素 —— 回写后 `src` 已是 blob，
 *      `findImageByExpectedUrl` 会跳过它；但每个回写过的元素都存了 `data-miao-original-src`，
 *      拿它比对原 URL 就能命中（**这条是"译完定位失效"的根因**）
 *   ③ 未回写的图 → 按 `expectedUrl` 找
 */
export function resolveLocateTarget(
  element: HTMLImageElement | undefined,
  expectedUrl: string | undefined,
): HTMLImageElement | null {
  if (element && element.isConnected) return element;
  if (expectedUrl) {
    const rewritten = findRewrittenByOriginalUrl(expectedUrl);
    if (rewritten) return rewritten;
    return findImageByExpectedUrl(expectedUrl);
  }
  return null;
}

/** 在**已回写**的图里按原始 URL 反查（回写时把原 src 记在 `ORIGINAL_SRC_ATTR`）。 */
function findRewrittenByOriginalUrl(expectedUrl: string): HTMLImageElement | null {
  for (const img of Array.from(document.querySelectorAll<HTMLImageElement>(`img[${MARK_ATTR}]`))) {
    if (!img.isConnected) continue;
    const original = img.getAttribute(ORIGINAL_SRC_ATTR);
    if (!original) continue;
    try {
      if (new URL(original, 'http://127.0.0.1/').href === new URL(expectedUrl, 'http://127.0.0.1/').href) {
        return img;
      }
    } catch {
      if (original === expectedUrl) return img;
    }
  }
  return null;
}

/** 定位是否可用 —— 原图已离开当前 DOM 时置灰（判据同 P0-1 的 `img.isConnected`） */
export function canLocate(element: HTMLImageElement | null): boolean {
  return !!element && element.isConnected;
}
