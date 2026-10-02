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
 * 「定位图片」—— 菜单内唯一可执行项（《01》§6.3）。
 *
 * 行为：滚动到该原图并高亮 **1.2s**（2px `pink` 描边、闪烁 2 次 × 300ms）。
 * 纯定位、不改数据，任何面板状态都可点。
 */
export function locateImage(
  element: HTMLImageElement,
  options: { totalMs?: number; blinkMs?: number; blinks?: number } = {},
): void {
  const totalMs = options.totalMs ?? 1_200;
  const blinkMs = options.blinkMs ?? 300;
  const blinks = options.blinks ?? 2;

  element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  element.setAttribute(LOCATE_HIGHLIGHT_ATTR, '1');

  let count = 0;
  const timer = window.setInterval(() => {
    count += 1;
    const on = count % 2 === 1;
    element.style.outline = on ? '2px solid #FF8FBF' : 'none';
    element.style.outlineOffset = on ? '2px' : '0';
    if (count >= blinks * 2) {
      window.clearInterval(timer);
      element.style.outline = '';
      element.style.outlineOffset = '';
      element.removeAttribute(LOCATE_HIGHLIGHT_ATTR);
    }
  }, blinkMs);

  // 保底清理：即使定时器被节流，也不留下永久描边
  window.setTimeout(() => {
    window.clearInterval(timer);
    element.style.outline = '';
    element.style.outlineOffset = '';
  }, totalMs);
}

/** 定位是否可用 —— 原图已离开当前 DOM 时置灰（判据同 P0-1 的 `img.isConnected`） */
export function canLocate(element: HTMLImageElement | null): boolean {
  return !!element && element.isConnected;
}
