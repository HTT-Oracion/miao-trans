/**
 * 静态资源完整性 —— 钉死一类**只在浏览器里才暴露**的缺陷。
 *
 * 缺陷背景：面板头用 `logoUrl(28)`、未就绪浮层用 `logoUrl(20)`，而
 * `public/icon/` 里只导出了 16/32/48/64/128/256/512 六档 —— 两个 `<img>`
 * 全部 404，面板左上角是破图。单测、构建、类型检查**都不会**报错，
 * 因为「尺寸」在 TS 里只是联合类型字面量，没有任何东西保证对应文件存在。
 *
 * 这里的判据：把 src 下所有 `logoUrl(N)` 的实参抽出来，逐个断言
 * `public/icon/plugin-logo-N.png` 真实存在且是非空 PNG。
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const EXT_ROOT = path.resolve(import.meta.dirname, '..');
const SRC = path.join(EXT_ROOT, 'src');
const ICON_DIR = path.join(EXT_ROOT, 'public', 'icon');

/** 递归收集 .ts/.tsx 源码 */
function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

/** 抽取源码中出现的全部 logoUrl(N) 尺寸 */
function referencedSizes(): Map<number, string[]> {
  const sizes = new Map<number, string[]>();
  for (const file of walk(SRC)) {
    const code = readFileSync(file, 'utf8');
    for (const m of code.matchAll(/logoUrl\((\d+)\)/g)) {
      const size = Number(m[1]);
      const rel = path.relative(EXT_ROOT, file);
      sizes.set(size, [...(sizes.get(size) ?? []), rel]);
    }
  }
  return sizes;
}

function readPngSize(file: string): { width: number; height: number } {
  const buf = readFileSync(file);
  // PNG: 8 字节签名 + 4 字节长度 + 'IHDR' + 宽(4) 高(4)
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  expect(buf.subarray(0, 8).equals(sig)).toBe(true);
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

describe('品牌 Logo 资源完整性（防止「代码引用了不存在的尺寸」破图）', () => {
  it('源码里至少引用了一处 logoUrl(N)（否则测试自身失效）', () => {
    expect(referencedSizes().size).toBeGreaterThan(0);
  });

  it('每个被引用的尺寸都有对应的 PNG，且像素尺寸与档位一致', () => {
    const missing: string[] = [];
    const wrongSize: string[] = [];
    for (const [size, files] of referencedSizes()) {
      const asset = path.join(ICON_DIR, `plugin-logo-${size}.png`);
      let actual: { width: number; height: number };
      try {
        actual = readPngSize(asset);
      } catch {
        missing.push(`plugin-logo-${size}.png ← ${files.join(', ')}`);
        continue;
      }
      if (actual.width !== size || actual.height !== size) {
        wrongSize.push(`plugin-logo-${size}.png 实际 ${actual.width}×${actual.height}`);
      }
    }
    expect(missing, `缺失的图标档位：\n${missing.join('\n')}`).toEqual([]);
    expect(wrongSize, `像素尺寸与档位不符：\n${wrongSize.join('\n')}`).toEqual([]);
  });

  it('面板头与未就绪浮层用到的 28 / 20 两档确实存在（本次修复的回归钉）', () => {
    for (const size of [20, 28]) {
      const asset = path.join(ICON_DIR, `plugin-logo-${size}.png`);
      const png = readPngSize(asset);
      expect(png).toEqual({ width: size, height: size });
      expect(statSync(asset).size).toBeGreaterThan(100);
    }
  });
});
