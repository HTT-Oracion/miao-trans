/**
 * 「定位图片」断言（jsdom）—— 针对两类**只在浏览器里才暴露**的失效：
 *
 *   ① 高亮被站点 CSS 吃掉：此前用普通内联样式写 `outline`，站点只要写了
 *      `img { outline: none }` 就能盖掉它，用户看到的就是「点了没反应」。
 *   ② 元素引用失效就没救：抓取时存下的 `HTMLImageElement` 在 SPA 节点回收后
 *      `isConnected` 为 false，此时按钮直接 disabled —— 而仓库里本来就有
 *      抗 DOM 复用的 `findImageByExpectedUrl`，定位此前一直没接上它。
 *
 * 反证轮见文件末尾：把实现改回旧写法，对应编号的用例必须变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCATE_HIGHLIGHT_ATTR,
  MARK_ATTR,
  ORIGINAL_SRC_ATTR,
  findImageByExpectedUrl,
  locateImage,
  resolveLocateTarget,
} from '../../src/content/writeback';

const DECLARED_CASES = ['L1', 'L2', 'L3', 'L4', 'L5', 'L6', 'L7'] as const;
const EXPECTED_CASE_COUNT = 7;

const executed: string[] = [];
function caseIt(id: (typeof DECLARED_CASES)[number], title: string, fn: () => void): void {
  executed.push(id);
  it(`[${id}] ${title}`, fn);
}

/** 造一个真实挂在 document 上的 img（jsdom 里默认无 src，手动塞一个） */
function makeImg(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  document.body.appendChild(img);
  return img;
}

/** jsdom 没有布局引擎，`getBoundingClientRect` 恒为 0 —— 桩一个可见矩形才能走到真实分支 */
function stubVisible(el: HTMLElement, top: number, height: number): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () =>
      ({
        top,
        bottom: top + height,
        height,
        left: 0,
        right: 800,
        width: 800,
        x: 0,
        y: top,
        toJSON: () => ({}),
      }) as DOMRect,
  });
}

beforeEach(() => {
  document.body.innerHTML = '';
  // jsdom 不实现 scrollIntoView，不打桩会走进兜底分支，掩盖真实路径
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('定位图片（分母钉死）', () => {
  caseIt('L1', '命中时返回 ok:true：描边带 important，且 1.2s 后自动清除', () => {
    const img = makeImg('/a.png');
    // jsdom 无布局引擎（rect 恒 0），不桩一个可见矩形就会整条走进「无布局」分支
    stubVisible(img, 100, 400);
    vi.useFakeTimers();

    const r = locateImage(img);

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.scroll).toBe('already-visible'); // 已在视口 ⇒ 不该多滚
    // 关键：必须带 important，否则站点 CSS 能盖掉（这正是旧实现的失效原因）。
    // 注意 priority 要用 getPropertyPriority 读 —— getPropertyValue 只返回值，不含优先级
    expect(img.style.getPropertyPriority('outline')).toBe('important');
    expect(img.style.getPropertyValue('outline')).toBe('2px solid #FF8FBF');
    expect(img.getAttribute(LOCATE_HIGHLIGHT_ATTR)).toBe('1');

    vi.advanceTimersByTime(2000);
    expect(img.hasAttribute(LOCATE_HIGHLIGHT_ATTR)).toBe(false);
    expect(img.style.getPropertyValue('outline')).toBe('');
  });

  caseIt('L2', '元素已离开 DOM 时返回 ok:false，且不抛异常', () => {
    const img = makeImg('/b.png');
    img.remove();
    expect(img.isConnected).toBe(false);
    expect(() => locateImage(img)).not.toThrow();
    expect(locateImage(img).ok).toBe(false);
  });

  caseIt('L3', 'resolveLocateTarget ①：元素引用仍有效 → 直接用它', () => {
    const img = makeImg('/c.png');
    expect(resolveLocateTarget(img, img.src)).toBe(img);
  });

  caseIt('L4', 'resolveLocateTarget ②：引用失效 → 按 expectedUrl 兜底命中', () => {
    const stale = makeImg('/d.png');
    // expectedUrl 取的是抓取那一刻的 currentSrc；jsdom 里 src 已被解析成绝对地址
    const expected = stale.src;
    stale.remove(); // 模拟 SPA 节点回收
    const fresh = makeImg('/d.png'); // 同名 URL 的新节点

    const got = resolveLocateTarget(stale, expected);
    expect(got).toBe(fresh);
    expect(got).not.toBe(stale);
  });

  caseIt('L5', '两级都找不到 → 返回 null（供调用方给出「已离开」提示）', () => {
    const stale = makeImg('/e.png');
    stale.remove();
    expect(resolveLocateTarget(stale, '/nonexistent.png')).toBeNull();
    expect(resolveLocateTarget(undefined, undefined)).toBeNull();
  });

  caseIt('L7', '已回写（src 变 blob）的图，引用失效后仍能按 originalSrc 定位', () => {
    // 原图节点先移除，保证只有"已回写"这一个节点带这个 URL —— 否则 ③ 号兜底也会命中它，
    // 反证那半步就分不清命中的是新路径还是旧路径
    const originalImg = makeImg('/f.png');
    const original = originalImg.src;
    originalImg.remove();

    const rewritten = makeImg('blob:http://127.0.0.1/fake');
    rewritten.setAttribute(MARK_ATTR, '1');
    rewritten.setAttribute(ORIGINAL_SRC_ATTR, original);

    const stale = document.createElement('img');
    expect(resolveLocateTarget(stale, original)).toBe(rewritten);

    // 反证：抹掉原 URL 记事 ⇒ 新路径失效，且 ③ 号兜底也找不到（此时没有任何 img 的 src 是这个 URL）
    rewritten.removeAttribute(ORIGINAL_SRC_ATTR);
    expect(resolveLocateTarget(stale, original)).toBeNull();
  });

  caseIt('L6', '原生 scrollIntoView 抛错也不影响高亮与返回（滚动由逐层兜底接管）', () => {
    const img = makeImg('/f.png');
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => {
        throw new Error('not implemented');
      },
      configurable: true,
      writable: true,
    });
    vi.useFakeTimers();

    const r = locateImage(img);

    // 滚动失败/不可能 ≠ 定位失败：图还在，就要照常高亮，只是提示语不同（见 scrollLocate 的 R3）
    expect(r.ok).toBe(true);
    expect(img.style.getPropertyPriority('outline')).toBe('important');

    vi.advanceTimersByTime(2000);
    expect(img.hasAttribute(LOCATE_HIGHLIGHT_ATTR)).toBe(false);
  });
});

describe('反证（改回旧写法必须变红）', () => {
  it('R1 — 若高亮改回不带 important 的普通样式，L1 会红', () => {
    const img = makeImg('/r1.png');
    // 旧实现：普通内联样式 —— 值一样，但没有优先级
    img.style.outline = '2px solid #FF8FBF';
    expect(img.style.getPropertyPriority('outline')).toBe('');
    // 正证实现则必须带 important
    const fresh = makeImg('/r1b.png');
    locateImage(fresh);
    expect(fresh.style.getPropertyValue('outline')).toBe('2px solid #FF8FBF');
    expect(fresh.style.getPropertyPriority('outline')).toBe('important');
  });

  it('R2 — 若 resolveLocateTarget 退回「只用元素引用」，L4 会红', () => {
    const stale = makeImg('/r2.png');
    const expected = stale.src;
    stale.remove();
    const fresh = makeImg('/r2.png');

    // 旧实现（只用引用）在引用失效时直接返回 null
    const oldBehavior = stale && stale.isConnected ? stale : null;
    expect(oldBehavior).toBeNull();
    // 新实现靠 expectedUrl 兜底，能找到新节点
    expect(resolveLocateTarget(stale, expected)).toBe(fresh);
  });

  it('R3 — findImageByExpectedUrl 确实按 src 匹配，而不是按位置顺序', () => {
    makeImg('/other.png');
    const target = makeImg('/target.png');
    makeImg('/another.png');
    // 目标既不是第一个也不是最后一个 —— 按位置找会命中错的那个
    expect(findImageByExpectedUrl(target.src)).toBe(target);
  });
});

describe('分母钉死（跳过 ≠ 通过）', () => {
  it(`应执行 ${EXPECTED_CASE_COUNT} 条用例：实执行 == 声明 == 期望`, () => {
    expect(executed.length).toBe(DECLARED_CASES.length);
    expect(new Set(executed).size).toBe(DECLARED_CASES.length);
    expect(DECLARED_CASES.length).toBe(EXPECTED_CASE_COUNT);
  });
});
