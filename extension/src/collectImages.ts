/**
 * 抓图 + 稳定等待 + 阅读顺序排序 —— 对应《01》§8 的 `src/collectImages.ts`。
 *
 * 《03》§7.3 规定：`top` / `left` 取自 `getBoundingClientRect()`，在**抓图完成快照**
 * 后取一次（等 `img.decode()` 或 `complete === true`，超时 1500ms 兜底）。
 * 本模块把「快照」这件事做实：位置必须在**图片解码完成后**取，否则懒加载图片
 * 高度为 0，会让整页挤进同一个 rowBucket、阅读顺序全乱。
 */

import { compareReadingOrder, type BoxPosition } from './naming';

/** 稳定等待兜底超时（《03》§7.3：超时 1500ms 兜底） */
export const DECODE_TIMEOUT_MS = 1_500;

/** 过滤阈值：排除头像 / 图标 / 分隔线等非漫画图 */
export const MIN_RENDERED_SIZE = 60;
export const MIN_NATURAL_SIZE = 100;

/** 常见懒加载属性（站点适配，非契约要求；见文件末说明） */
const LAZY_ATTRS = ['data-src', 'data-original', 'data-lazy-src', 'data-url', 'data-actualsrc'];

export interface PageImage {
  /** 稳定的抓取期 id —— 与 seq 无关，seq 在提交时才按阅读顺序分配 */
  key: string;
  element: HTMLImageElement;
  /** 下载用 URL（可能是懒加载属性里的真实地址） */
  fetchUrl: string;
  /**
   * 快照时刻的 `img.currentSrc`。
   *
   * 这是 **P0-1 回写校验的 `expectedUrl`** —— 必须是「抓取时看到的那张图」，
   * 而不是我们拿去下载的地址。两者在懒加载场景下会不同。
   */
  expectedUrl: string;
  position: BoxPosition;
  renderedWidth: number;
  renderedHeight: number;
  naturalWidth: number;
  naturalHeight: number;
  /** 文档顺序，仅用于排序稳定性兜底 */
  documentIndex: number;
}

export interface CollectOptions {
  minRenderedSize?: number;
  minNaturalSize?: number;
  /** 是否把 `position: fixed` / 隐藏元素排除（默认 true） */
  skipHidden?: boolean;
}

/** 判断元素是否可见（考虑 `display:none` / `visibility:hidden` / 0 尺寸） */
export function isVisible(el: HTMLElement): boolean {
  const rect = el.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  const win = el.ownerDocument.defaultView;
  if (!win) return true;
  const style = win.getComputedStyle(el);
  return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
}

/**
 * 解析图片的真实地址。
 *
 * 站点适配（**超出契约规格的必要实现**）：漫画站的懒加载常常把所有未加载的
 * `<img>` 指向同一个占位图（1×1 gif 或 spinner）。若直接取 `currentSrc`，
 * 会把 20 张缩略图全部指向同一张占位图 —— 抓回来的是 20 份同样的 1×1。
 * 因此：同一 URL 在页面上重复超过 2 次时，视为占位图，改从 `data-*` 属性取真实地址。
 */
export function resolveImageUrl(img: HTMLImageElement): string {
  const current = img.currentSrc || img.src || '';
  return current;
}

function resolveLazyUrl(img: HTMLImageElement): string | null {
  for (const attr of LAZY_ATTRS) {
    const v = img.getAttribute(attr);
    if (v && v.trim().length > 0) return v.trim();
  }
  return null;
}

/**
 * 扫描页面图片。
 *
 * 过滤规则（避免把头像、图标、Logo 选进来）：
 *   - 渲染尺寸 ≥ 60×60，原始尺寸 ≥ 100×100
 *   - 可见（非 `display:none`）
 *   - 有可用 URL
 */
export function collectPageImages(
  root: Document | HTMLElement = document,
  opts: CollectOptions = {},
): PageImage[] {
  const minRendered = opts.minRenderedSize ?? MIN_RENDERED_SIZE;
  const minNatural = opts.minNaturalSize ?? MIN_NATURAL_SIZE;
  const skipHidden = opts.skipHidden ?? true;

  const all = Array.from(root.querySelectorAll('img'));
  const raw: Array<{ img: HTMLImageElement; url: string; documentIndex: number }> = [];

  all.forEach((img, documentIndex) => {
    if (skipHidden && !isVisible(img)) return;
    const url = resolveImageUrl(img);
    if (!url) return;
    raw.push({ img, url, documentIndex });
  });

  // 占位图判定：同一 URL 出现次数 > 2 → 认为是占位图，优先用 data-* 属性里的真实地址
  const freq = new Map<string, number>();
  for (const r of raw) freq.set(r.url, (freq.get(r.url) ?? 0) + 1);

  const out: PageImage[] = [];
  for (const r of raw) {
    const { img } = r;
    const rect = img.getBoundingClientRect();
    const naturalWidth = img.naturalWidth || 0;
    const naturalHeight = img.naturalHeight || 0;

    if (rect.width < minRendered || rect.height < minRendered) continue;
    // 未解码完成时 naturalWidth 为 0；这种情况下放行，交给 waitForImagesStable 之后的复核
    if (naturalWidth > 0 && naturalWidth < minNatural) continue;
    if (naturalHeight > 0 && naturalHeight < minNatural) continue;

    let fetchUrl = r.url;
    if ((freq.get(r.url) ?? 0) > 2) {
      const lazy = resolveLazyUrl(img);
      if (lazy) fetchUrl = lazy;
    }

    out.push({
      key: `img-${r.documentIndex}`,
      element: img,
      fetchUrl,
      // P0-1 的 expectedUrl：抓取时刻的 currentSrc，不替换为懒加载地址
      expectedUrl: img.currentSrc || img.src || r.url,
      position: { top: rect.top + window.scrollY, left: rect.left + window.scrollX },
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      naturalWidth,
      naturalHeight,
      documentIndex: r.documentIndex,
    });
  }
  return out;
}

/**
 * 等待图片解码完成（《03》§7.3 的「抓图完成快照」）。
 *
 * 只用 `img.decode()` 会在图片加载失败时 reject、在 `loading="lazy"` 且未进入
 * 视口时长时间 pending；因此三条路径竞速：decode / load 事件 / 超时兜底。
 */
export async function waitForImagesStable(
  images: readonly PageImage[],
  timeoutMs = DECODE_TIMEOUT_MS,
): Promise<void> {
  await Promise.all(
    images.map(async (item) => {
      const img = item.element;
      if (img.complete && img.naturalWidth > 0) return;
      await new Promise<void>((resolve) => {
        let settled = false;
        const finish = (): void => {
          if (settled) return;
          settled = true;
          img.removeEventListener('load', finish);
          img.removeEventListener('error', finish);
          clearTimeout(timer);
          resolve();
        };
        const timer = setTimeout(finish, timeoutMs);
        img.addEventListener('load', finish, { once: true });
        img.addEventListener('error', finish, { once: true });
        if (typeof img.decode === 'function') {
          img.decode().then(finish, finish);
        }
      });
    }),
  );
}

/** 解码完成后刷新一次几何快照 —— 懒加载图片此前高度为 0，位置全部失真 */
export function refreshPositions(images: PageImage[]): void {
  for (const item of images) {
    const rect = item.element.getBoundingClientRect();
    item.position = { top: rect.top + window.scrollY, left: rect.left + window.scrollX };
    item.renderedWidth = rect.width;
    item.renderedHeight = rect.height;
    item.naturalWidth = item.element.naturalWidth || item.naturalWidth;
    item.naturalHeight = item.element.naturalHeight || item.naturalHeight;
  }
}

/**
 * 完整抓图流程：扫描 → 等稳定 → 刷新几何 → 按**阅读顺序**排序。
 *
 * 返回顺序即提交顺序，也就是 seq `001..NNN` 的分配顺序。
 * 排序必须是阅读顺序而非勾选顺序（《03》§7.3）：勾选顺序随机无稳定语义，
 * 且跨批次时在第二批没有全局参照系。
 */
export async function collectOrderedImages(
  root: Document | HTMLElement = document,
  opts: CollectOptions & { timeoutMs?: number } = {},
): Promise<PageImage[]> {
  const images = collectPageImages(root, opts);
  await waitForImagesStable(images, opts.timeoutMs ?? DECODE_TIMEOUT_MS);
  refreshPositions(images);
  return images
    .map((item, i) => ({ item, i }))
    .sort((a, b) => {
      const byOrder = compareReadingOrder(a.item.position, b.item.position);
      if (byOrder !== 0) return byOrder;
      return a.item.documentIndex - b.item.documentIndex;
    })
    .map((x) => x.item);
}

/** 页面图片 URL 集合的轻量签名 —— 用于无限滚动检测（类型 ③：URL 不变、图片持续追加） */
export function imageSetSignature(images: readonly PageImage[]): string {
  return images.map((i) => i.fetchUrl).join('|');
}
