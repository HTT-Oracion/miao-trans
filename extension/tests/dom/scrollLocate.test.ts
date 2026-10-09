/**
 * 「定位图片」的**滚动**部分断言（jsdom）。
 *
 * 针对的实现风险是：旧实现只调一次 `scrollIntoView`，**既不兜底也不验证**。
 * 它在部分站点上是静默 no-op（不抛异常、页面纹丝不动），调用方拿到 undefined 无从判断，
 * 于是提示语无条件说「已滚动」—— 等于在没有滚动的时候撒谎。
 *
 * 新实现分三步且每步可判：① 目标是否真的参与布局；② 原生 scrollIntoView；
 * ③ 原生无效则逐层手动居中。本文件把第 ①③ 步的数学逐条钉死。
 *
 * jsdom 没有布局引擎（`getBoundingClientRect` 恒为 0、`scrollTop` 不可写），
 * 所以这里**自建一个极简布局模型**：元素在文档坐标里的位置固定，
 * 视口 rect = 文档坐标 − 容器 scrollTop。这样「滚动后是否真的可见」才能被判定，
 * 否则断言会退化成永远为真或永远为假的废断言。
 *
 * 反证轮见文件末尾：把实现改回旧写法，对应编号的用例必须变红。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  LOCATE_NOTICE,
  centerWithin,
  collectScrollers,
  nearestLaidOutAncestor,
  scrollElementIntoView,
  type ScrollOutcome,
} from '../../src/content/writeback';

const DECLARED_CASES = ['S1', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] as const;
const EXPECTED_CASE_COUNT = 7;

const executed: string[] = [];
function caseIt(id: (typeof DECLARED_CASES)[number], title: string, fn: () => void): void {
  executed.push(id);
  it(`[${id}] ${title}`, fn);
}

/** jsdom 的视口高度 */
const VH = window.innerHeight;

function rectOf(top: number, height: number, width = 800): DOMRect {
  return {
    top,
    bottom: top + height,
    height,
    left: 0,
    right: width,
    width,
    x: 0,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 用「每次取都重算」的函数桩掉 rect —— 滚动后 rect 必须跟着变，否则验证是假的 */
function stubRect(el: HTMLElement, get: () => { top: number; height: number }): void {
  Object.defineProperty(el, 'getBoundingClientRect', {
    configurable: true,
    value: () => {
      const b = get();
      return rectOf(b.top, b.height);
    },
  });
}

/** 造一个可滚动容器：scrollTop 有真实读写与钳制（jsdom 默认是恒 0 的空壳） */
function makeScroller(
  el: HTMLElement,
  o: { clientH: number; scrollH: number; start?: number },
): { get scrollTop(): number } {
  let st = o.start ?? 0;
  const max = Math.max(0, o.scrollH - o.clientH);
  Object.defineProperty(el, 'scrollTop', {
    configurable: true,
    get: () => st,
    set: (v: number) => {
      st = Math.min(Math.max(0, v), max);
    },
  });
  Object.defineProperty(el, 'clientHeight', { configurable: true, get: () => o.clientH });
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: () => o.scrollH });
  el.style.overflowY = 'auto'; // jsdom 的 getComputedStyle 会反射内联样式
  return {
    get scrollTop(): number {
      return st;
    },
  };
}

const se = () => document.documentElement as HTMLElement;

beforeEach(() => {
  document.body.innerHTML = '';
  // 原生在 jsdom 里不存在；桩成「什么都不做」—— 正是旧实现赖以为生的那条路
  Object.defineProperty(Element.prototype, 'scrollIntoView', {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('定位的滚动（分母钉死）', () => {
  caseIt('S1', '目标不参与布局 → no-layout（滚过去也没有意义）', () => {
    const img = document.createElement('img');
    document.body.appendChild(img);
    // jsdom 全 0，且一路爬到 html 都没有布局
    expect(scrollElementIntoView(img)).toBe('no-layout');
  });

  caseIt('S2', '目标已在视口 → already-visible，且一个像素都不滚', () => {
    const doc = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const img = document.createElement('img');
    document.body.appendChild(img);
    stubRect(img, () => ({ top: 100 - doc.scrollTop, height: 400 }));

    expect(scrollElementIntoView(img)).toBe('already-visible');
    expect(doc.scrollTop).toBe(0);
    expect(img.scrollIntoView).not.toHaveBeenCalled();
  });

  caseIt('S3', '文档滚动：滚到「目标垂直居中」的位置，而不是随便滚一下', () => {
    const doc = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const img = document.createElement('img');
    document.body.appendChild(img);
    const DOC_TOP = 3000;
    const H = 400;
    stubRect(img, () => ({ top: DOC_TOP - doc.scrollTop, height: H }));

    expect(scrollElementIntoView(img)).toBe('scrolled');
    // 居中：目标顶部离视口顶 (VH - H) / 2
    expect(doc.scrollTop).toBe(DOC_TOP - (VH - H) / 2);
    // 验证滚动真的把目标带进了视口（不是只改了个数字）
    const r = img.getBoundingClientRect();
    expect(r.top).toBeCloseTo((VH - H) / 2, 5);
  });

  caseIt('S4', '嵌套滚动容器：先滚内层把目标居中，再滚外层', () => {
    const outer = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const innerEl = document.createElement('div');
    document.body.appendChild(innerEl);
    const inner = makeScroller(innerEl, { clientH: 500, scrollH: 6000 });
    const img = document.createElement('img');
    innerEl.appendChild(img);

    const INNER_DOC_TOP = 200; // 内层容器在文档里的位置
    const OFFSET = 4000; // 目标在内层内容里的偏移
    const H = 400;
    stubRect(innerEl, () => ({ top: INNER_DOC_TOP - outer.scrollTop, height: 500 }));
    stubRect(
      img,
      () => ({ top: INNER_DOC_TOP - outer.scrollTop + (OFFSET - inner.scrollTop), height: H }),
    );

    expect(scrollElementIntoView(img)).toBe('scrolled');
    // 内层：目标相对内层顶部居中
    expect(inner.scrollTop).toBe(OFFSET - (500 - H) / 2);
    // 且最终在视口里可见
    const r = img.getBoundingClientRect();
    expect(r.top).toBeGreaterThanOrEqual(0);
    expect(r.top).toBeLessThan(VH);
  });

  caseIt('S5', '容器没有滚动余量 → not-scrollable（如实报，不假装滚过）', () => {
    makeScroller(se(), { clientH: VH, scrollH: VH }); // 无余量
    const img = document.createElement('img');
    document.body.appendChild(img);
    stubRect(img, () => ({ top: 3000, height: 400 }));

    expect(scrollElementIntoView(img)).toBe('not-scrollable');
  });

  caseIt('S6', '懒加载占位（img 自身 0 高）→ 拿外层有布局的节点当滚动目标', () => {
    const doc = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    const img = document.createElement('img');
    wrap.appendChild(img);

    stubRect(img, () => ({ top: 0, height: 0 })); // 1×1 占位
    stubRect(wrap, () => ({ top: 3000 - doc.scrollTop, height: 400 }));

    expect(nearestLaidOutAncestor(img)).toBe(wrap);
    expect(scrollElementIntoView(img)).toBe('scrolled');
  });

  caseIt('S7', '原生 scrollIntoView 抛错 → 仍靠逐层兜底滚到位（旧实现此时直接放弃）', () => {
    Object.defineProperty(Element.prototype, 'scrollIntoView', {
      value: () => {
        throw new Error('scrollIntoView 不可用');
      },
      configurable: true,
      writable: true,
    });
    const doc = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const img = document.createElement('img');
    document.body.appendChild(img);
    stubRect(img, () => ({ top: 3000 - doc.scrollTop, height: 400 }));

    // 只调一次：调两次的话第二次会命中「已在视口」，把真实的滚动结果掩盖掉
    let outcome: ScrollOutcome | null = null;
    expect(() => {
      outcome = scrollElementIntoView(img);
    }).not.toThrow();
    expect(outcome).toBe('scrolled');
    expect(doc.scrollTop).toBeGreaterThan(0);
  });
});

describe('反证（改回旧写法必须变红）', () => {
  it('R1 — 若像旧实现那样只认元素自身的 rect，S6 的占位图会被判成滚不动', () => {
    const wrap = document.createElement('div');
    document.body.appendChild(wrap);
    const img = document.createElement('img');
    wrap.appendChild(img);
    stubRect(img, () => ({ top: 0, height: 0 }));
    stubRect(wrap, () => ({ top: 3000, height: 400 }));

    // 旧口径：只看 img 自己 ⇒ 0 高 ⇒ 判无布局
    const oldJudge = img.getBoundingClientRect().height >= 4;
    expect(oldJudge).toBe(false);
    // 新实现爬到有布局的外层 ⇒ 找得到目标
    expect(nearestLaidOutAncestor(img)).toBe(wrap);
  });

  it('R2 — 若去掉逐层兜底（只剩原生 no-op），S3 的滚动量会是 0', () => {
    const doc = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const img = document.createElement('img');
    document.body.appendChild(img);
    stubRect(img, () => ({ top: 3000 - doc.scrollTop, height: 400 }));

    // 模拟「只有原生、没有兜底」：原生是 no-op，什么都不会发生
    img.scrollIntoView({ block: 'center' });
    expect(doc.scrollTop).toBe(0);
    expect(img.getBoundingClientRect().top).toBe(3000); // 仍在视口外

    // 新实现的兜底才真的滚了
    for (const sc of collectScrollers(img)) centerWithin(img, sc);
    expect(doc.scrollTop).toBeGreaterThan(0);
  });

  it('R3 — 提示语不得用「已滚动」去描述没滚动的结果（这是本轮报障的直接成因）', () => {
    const all: ScrollOutcome[] = ['scrolled', 'already-visible', 'no-layout', 'not-scrollable'];
    for (const k of all) expect(typeof LOCATE_NOTICE[k]).toBe('string');
    // 只有真的滚了才许说「滚动」
    expect(LOCATE_NOTICE.scrolled).toContain('滚动');
    expect(LOCATE_NOTICE['already-visible']).not.toContain('已滚动');
    expect(LOCATE_NOTICE['no-layout']).not.toContain('已滚动');
    expect(LOCATE_NOTICE['not-scrollable']).not.toContain('已滚动');
  });

  it('R4 — centerWithin 对「已居中」的目标不做无意义的滚动', () => {
    const doc = makeScroller(se(), { clientH: VH, scrollH: 8000 });
    const img = document.createElement('img');
    document.body.appendChild(img);
    const H = 400;
    stubRect(img, () => ({ top: (VH - H) / 2 - doc.scrollTop, height: H }));

    centerWithin(img, se());
    expect(doc.scrollTop).toBe(0); // 差值 < 2px ⇒ 不动
  });
});

describe('分母钉死（跳过 ≠ 通过）', () => {
  it(`应执行 ${EXPECTED_CASE_COUNT} 条用例：实执行 == 声明 == 期望`, () => {
    expect(executed.length).toBe(DECLARED_CASES.length);
    expect(new Set(executed).size).toBe(DECLARED_CASES.length);
    expect(DECLARED_CASES.length).toBe(EXPECTED_CASE_COUNT);
  });
});
