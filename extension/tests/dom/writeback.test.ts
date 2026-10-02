/**
 * DOM 硬规则测试（jsdom）—— 回写校验与路由变更检测。
 *
 * 这两条是《01》§6.4 里唯一**必须在真实 DOM 上验证**的规则：
 * 纯函数层的 `canWriteBack` / `shouldClearSelection` 已在 selection.test.ts 覆盖，
 * 这里验证的是「它们被正确地接到了 DOM 事件上」。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  MARK_ATTR,
  ORIGINAL_SRC_ATTR,
  findImageByExpectedUrl,
  releaseAllWriteBacks,
  revertImage,
  writeBackImage,
} from '../../src/content/writeback';
import { installRouteWatcher, type RouteChangeInfo } from '../../src/content/routeWatcher';

/** jsdom 不实现 createObjectURL —— 补一个可控替身，顺便能断言 revoke 被调用 */
const created: string[] = [];
const revoked: string[] = [];

beforeEach(() => {
  created.length = 0;
  revoked.length = 0;
  let n = 0;
  vi.stubGlobal('URL', Object.assign(URL, {
    createObjectURL: () => {
      n += 1;
      const u = `blob:mock/${n}`;
      created.push(u);
      return u;
    },
    revokeObjectURL: (u: string) => {
      revoked.push(u);
    },
  }));
  document.body.innerHTML = '';
});

afterEach(() => {
  releaseAllWriteBacks();
  vi.unstubAllGlobals();
});

function addImg(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.src = src;
  document.body.appendChild(img);
  return img;
}

describe('《01》§6.4 P0-1 回写在 DOM 上的行为', () => {
  it('命中时替换 src 并打上标记，同时记住原 src（供回滚）', () => {
    const img = addImg('https://cdn.example.com/003.png');
    const res = writeBackImage(3, img, img.src, new Blob(['translated'], { type: 'image/png' }));
    expect(res).toEqual({ ok: true, seq: 3 });
    expect(img.src).toBe('blob:mock/1');
    expect(img.getAttribute(MARK_ATTR)).toBe('3');
    expect(img.getAttribute(ORIGINAL_SRC_ATTR)).toBe('https://cdn.example.com/003.png');
  });

  it('**元素已离开 DOM → 跳过**，不改任何 src（这是防译文串图的关键）', () => {
    const img = addImg('https://cdn.example.com/003.png');
    const expected = img.src;
    img.remove();
    const res = writeBackImage(3, img, expected, new Blob(['x'], { type: 'image/png' }));
    expect(res).toEqual({ ok: false, seq: 3, reason: 'left-dom' });
    expect(img.src).toBe('https://cdn.example.com/003.png');
    expect(img.hasAttribute(MARK_ATTR)).toBe(false);
  });

  it('**src 已被换成别的图 → 跳过**（新页同位置元素不等于原页那一张）', () => {
    const img = addImg('https://cdn.example.com/014.png');
    const res = writeBackImage(3, img, 'https://cdn.example.com/003.png', new Blob(['x'], { type: 'image/png' }));
    expect(res).toEqual({ ok: false, seq: 3, reason: 'src-mismatch' });
    expect(img.src).toBe('https://cdn.example.com/014.png');
  });

  it('元素不存在时返回 not-found，不抛异常', () => {
    expect(writeBackImage(9, null, 'https://a/1.png', new Blob(['x']))).toEqual({
      ok: false,
      seq: 9,
      reason: 'not-found',
    });
  });

  it('同一张重复回写不会泄漏 blob URL（旧的先 revoke）', () => {
    const img = addImg('https://cdn.example.com/003.png');
    const expected = img.src;
    writeBackImage(1, img, expected, new Blob(['a']));
    const img2 = addImg('https://cdn.example.com/004.png');
    writeBackImage(1, img2, img2.src, new Blob(['b']));
    expect(created).toHaveLength(2);
    expect(revoked).toContain('blob:mock/1');
  });

  it('回滚能恢复原图（自检用，正常路径不暴露给用户）', () => {
    const img = addImg('https://cdn.example.com/003.png');
    const expected = img.src;
    writeBackImage(5, img, expected, new Blob(['a']));
    expect(revertImage(5)).toBe(true);
    expect(img.src).toBe('https://cdn.example.com/003.png');
    expect(img.hasAttribute(MARK_ATTR)).toBe(false);
  });

  it('按 expectedUrl 找元素时跳过已回写的那张（避免二次覆盖）', () => {
    const img = addImg('https://cdn.example.com/003.png');
    expect(findImageByExpectedUrl('https://cdn.example.com/003.png')).toBe(img);
    img.setAttribute(MARK_ATTR, '1');
    expect(findImageByExpectedUrl('https://cdn.example.com/003.png')).toBeNull();
  });
});

describe('《01》§6.4 路由变更检测（三类）', () => {
  it('类型 ③ 无限滚动：**URL 不变**但追加了图片 → 上报 infinite-scroll', async () => {
    const events: RouteChangeInfo[] = [];
    const dispose = installRouteWatcher((info) => events.push(info), { debounceMs: 10 });
    try {
      const img = document.createElement('img');
      img.src = 'https://cdn.example.com/021.png';
      document.body.appendChild(img);
      await new Promise((r) => setTimeout(r, 60));
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('infinite-scroll');
      expect(events[0]?.addedImages).toBe(1);
      expect(events[0]?.url).toBe(events[0]?.previousUrl);
    } finally {
      dispose();
    }
  });

  it('类型 ② SPA：pushState 改 URL → 立即上报 spa（不等 debounce）', async () => {
    const events: RouteChangeInfo[] = [];
    const dispose = installRouteWatcher((info) => events.push(info), { debounceMs: 5_000 });
    try {
      history.pushState({}, '', '/chapter/13');
      expect(events).toHaveLength(1);
      expect(events[0]?.kind).toBe('spa');
      expect(events[0]?.url).toContain('/chapter/13');
      expect(events[0]?.previousUrl).not.toContain('/chapter/13');
    } finally {
      dispose();
    }
  });

  it('连续追加会被合并成一次事件（无限滚动是一串 DOM 操作，不能逐个上报）', async () => {
    const events: RouteChangeInfo[] = [];
    const dispose = installRouteWatcher((info) => events.push(info), { debounceMs: 20 });
    try {
      for (let i = 0; i < 5; i += 1) {
        const img = document.createElement('img');
        img.src = `https://cdn.example.com/0${30 + i}.png`;
        document.body.appendChild(img);
      }
      await new Promise((r) => setTimeout(r, 80));
      expect(events).toHaveLength(1);
      expect(events[0]?.addedImages).toBe(5);
    } finally {
      dispose();
    }
  });

  it('卸载后不再上报（页面卸载时不能留下孤儿观察者）', async () => {
    const events: RouteChangeInfo[] = [];
    const dispose = installRouteWatcher((info) => events.push(info), { debounceMs: 10 });
    dispose();
    const img = document.createElement('img');
    document.body.appendChild(img);
    await new Promise((r) => setTimeout(r, 50));
    expect(events).toHaveLength(0);
  });

  it('卸载会还原被包装的 history 方法（不能污染宿主页面）', () => {
    const original = history.pushState;
    const dispose = installRouteWatcher(() => undefined);
    expect(history.pushState).not.toBe(original);
    dispose();
    expect(history.pushState).toBe(original);
  });
});
