/**
 * 单元测试 —— 漫画名规范化、编号与阅读顺序排序。
 * 依据：《03-翻译服务接口契约-ver1.0》§6.1 / §6.3 / §7.2 / §7.3 / §7.4，《01》§5.3。
 */

import { describe, expect, it } from 'vitest';
import {
  COMIC_NAME_MAX_CHARS,
  ROW_TOLERANCE,
} from '../src/types/contract';
import {
  RESERVED_NAMES,
  checkComicName,
  compareReadingOrder,
  formatBytes,
  nextSeq,
  originalFileName,
  padSeq,
  parseSeqFromFileName,
  previewOutputPath,
  seqInRange,
  sortByReadingOrder,
  sortKeyOf,
  splitIntoBatches,
  translatedFileName,
} from '../src/naming';

describe('《03》§6.1 漫画名规范化管线', () => {
  it('步骤 3：剥离 `/ \\ :` —— 「第12话/学园祭」→「第12话学园祭」', () => {
    const r = checkComicName('第12话/学园祭');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe('第12话学园祭');
      expect(r.changed).toBe(true);
    }
  });

  it('步骤 1：NFKC 折叠 —— 全角冒号与全角数字（`：`→`:` 后按步骤 3 剥离，`１２３`→`123`）', () => {
    const r = checkComicName('第１２３话：学园祭');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('第123话学园祭');
  });

  it('步骤 4：剥离 Windows 非法字符 `< > " | ? *`', () => {
    const r = checkComicName('第<12>话?"学|园*祭');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('第12话学园祭');
  });

  it('步骤 5：连续空白折叠为单个半角空格', () => {
    const r = checkComicName('第12话    学园祭');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('第12话 学园祭');
  });

  it('步骤 6：去尾部所有 `.` 与空格（Windows 不允许目录名以 . 或空格结尾）', () => {
    const r = checkComicName('第12话 ...  ');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.normalized).toBe('第12话');
  });

  it('步骤 7：超长**拒绝**而非截断（静默截断会造成「用户以为叫 A、落盘叫 A′」）', () => {
    const tooLong = 'あ'.repeat(COMIC_NAME_MAX_CHARS + 1);
    const r = checkComicName(tooLong);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('INVALID_COMIC_NAME');
  });

  it(`步骤 7 边界：恰好 ${COMIC_NAME_MAX_CHARS} 个字符通过`, () => {
    const exact = 'あ'.repeat(COMIC_NAME_MAX_CHARS);
    expect(checkComicName(exact).ok).toBe(true);
  });

  it('步骤 8：保留名拒绝，且**必须在 NFKC 之后**匹配 —— 全角 `ＣＯＮ` 也要挡住', () => {
    for (const name of ['CON', 'con', 'ＮＵＬ', 'COM3']) {
      const r = checkComicName(name);
      expect(r.ok, `${name} 应被拒绝`).toBe(false);
    }
  });

  it('保留名清单含 COM0 / LPT0（文档要求连带拒绝，避免混淆）', () => {
    expect(RESERVED_NAMES.has('COM0')).toBe(true);
    expect(RESERVED_NAMES.has('LPT0')).toBe(true);
    expect(RESERVED_NAMES.size).toBe(24);
  });

  it('保留名匹配忽略扩展名 —— `CON.png` 同样拒绝', () => {
    expect(checkComicName('CON.png').ok).toBe(false);
  });

  it('步骤 9：空名 → COMIC_NAME_REQUIRED（输入 `///` 剥空后亦如此）', () => {
    const blank = checkComicName('   ');
    expect(blank.ok).toBe(false);
    if (!blank.ok) expect(blank.code).toBe('COMIC_NAME_REQUIRED');

    const slashes = checkComicName('///');
    expect(slashes.ok).toBe(false);
    if (!slashes.ok) expect(slashes.code).toBe('COMIC_NAME_REQUIRED');
  });

  it('步骤 0：含 \\x00 直接拒绝', () => {
    expect(checkComicName('第1\x002话').ok).toBe(false);
  });

  it('真实漫画名原样通过（常规路径不应被误伤）', () => {
    const r = checkComicName('第12话 · 学园祭');
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.normalized).toBe('第12话 · 学园祭');
      expect(r.changed).toBe(false);
    }
  });
});

describe('《01》§6.5 落盘路径预览', () => {
  it('用规范化后的名字拼接，与《03》§5.2 的 outputDir 同源', () => {
    expect(previewOutputPath('第12话/学园祭')).toBe('~/Pictures/Box 漫画/第12话学园祭/');
  });

  it('名字非法时预览仍可用（退化为原文），不抛异常', () => {
    expect(previewOutputPath('   ')).toContain('~/Pictures/Box 漫画/');
  });
});

describe('《03》§7.2 三位补零编号', () => {
  it('padSeq 恰好三位', () => {
    expect(padSeq(1)).toBe('001');
    expect(padSeq(20)).toBe('020');
    expect(padSeq(999)).toBe('999');
  });

  it('文件名规范：下划线分隔 + 嗅探得到的扩展名', () => {
    expect(originalFileName(7, 'png')).toBe('007.png');
    expect(translatedFileName(7, 'png')).toBe('007_translated.png');
  });

  it('从文件名反解序号，译文与原图同号', () => {
    expect(parseSeqFromFileName('001.png')).toBe(1);
    expect(parseSeqFromFileName('031_translated.webp')).toBe(31);
    expect(parseSeqFromFileName('1.png')).toBeNull();
    expect(parseSeqFromFileName('abc.png')).toBeNull();
  });

  it('序号范围 1–999（超 999 → 服务端 SEQUENCE_OVERFLOW）', () => {
    expect(seqInRange(1)).toBe(true);
    expect(seqInRange(999)).toBe(true);
    expect(seqInRange(1000)).toBe(false);
    expect(seqInRange(0)).toBe(false);
  });

  it('《03》§7.4 续编号：空目录 → 1，否则 max+1', () => {
    expect(nextSeq([])).toBe(1);
    expect(nextSeq([1, 2, 3])).toBe(4);
    expect(nextSeq([7])).toBe(8);
  });
});

describe('《03》§7.3 阅读顺序排序（rowBucket = 8px）', () => {
  it('sortKey = ( floor(top / 8), left )', () => {
    expect(sortKeyOf({ top: 100, left: 30 })).toEqual([12, 30]);
    expect(sortKeyOf({ top: 0, left: 0 })).toEqual([0, 0]);
    expect(sortKeyOf({ top: 8, left: 0 })).toEqual([1, 0]);
    expect(ROW_TOLERANCE).toBe(8);
  });

  it('同一行内按 left 从左到右', () => {
    const left = { top: 100, left: 10 };
    const right = { top: 103, left: 300 };
    // 两者 rowBucket 都是 12 → 同一行，按 left
    expect(compareReadingOrder(left, right)).toBeLessThan(0);
    expect(compareReadingOrder(right, left)).toBeGreaterThan(0);
  });

  it('不同行先看行，与 left 无关', () => {
    const upper = { top: 100, left: 900 };
    const lower = { top: 108, left: 10 };
    expect(compareReadingOrder(upper, lower)).toBeLessThan(0);
  });

  /**
   * ⚠️ 规格缺陷留痕（**已裁定，见 docs/03-偏差与规格缺陷记录.md D-01**）
   *
   * 《03》§7.3 正文与它自己的公式**不等价**：
   *   - 公式（规范性）：`rowBucket = floor(top / 8)`，8px 是**分桶宽度**
   *   - 散文：        「`top` 差值 < 8px 视为同一行」，读起来像**容差阈值**
   *
   * 两者在「跨桶边界」时给出不同结论，例如 top=100 与 top=105（相差 5px）：
   *   公式 → 桶 12 vs 桶 13 → **不同行**
   *   散文 → 相差 < 8px      → **同一行**
   *
   * 本用例按**公式**断言，理由有两条：
   *   1. 公式才是规范性表述（带标注的 sortKey 定义），散文是对它的不精确转述；
   *   2. 「差值 < 8px」作为比较器**不满足传递性**（a~b、b~c 推不出 a~c），
   *      拿它喂 `Array.prototype.sort` 会让结果依赖引擎实现 ——
   *      而 §7.3 本身要求跨批次排序稳定可复现。公式给出的
   *      (bucket, left) 字典序才是合法的全序，下面一并把传递性钉住。
   */
  it('【规格缺陷 D-01】跨桶边界时按**公式**判定为不同行（散文口径会给出相反结论）', () => {
    const a = { top: 100, left: 300 };
    const b = { top: 105, left: 10 };
    expect(sortKeyOf(a)[0]).toBe(12);
    expect(sortKeyOf(b)[0]).toBe(13);
    // 公式：a 在 b 之前（b 落到下一桶，虽然它 left 更小）
    expect(compareReadingOrder(a, b)).toBeLessThan(0);
    // 散文口径「差值 5 < 8 → 同一行」会认为 b 应在 a 之前 —— 两者结论相反
    expect(Math.abs(a.top - b.top)).toBeLessThan(ROW_TOLERANCE);
  });

  it('比较器满足全序（自反为 0 / 反对称 / 可传递）—— 这是弃用散文口径的理由', () => {
    const pts = [
      { top: 0, left: 0 },
      { top: 5, left: 900 },
      { top: 7, left: 1 },
      { top: 8, left: 2 },
      { top: 16, left: 3 },
      { top: 103, left: 300 },
      { top: 105, left: 10 },
    ];
    for (const p of pts) expect(compareReadingOrder(p, p)).toBe(0);
    for (const p of pts) {
      for (const q of pts) {
        // 用 === 数值比较：`Math.sign(-0)` 是 `-0`，`toBe` 走 Object.is 会把 -0 与 0 判为不等
        expect(compareReadingOrder(p, q) === -compareReadingOrder(q, p)).toBe(true);
      }
    }
    // 传递性：p < q 且 q < r ⇒ p < r
    for (const p of pts) {
      for (const q of pts) {
        for (const r of pts) {
          if (compareReadingOrder(p, q) < 0 && compareReadingOrder(q, r) < 0) {
            expect(compareReadingOrder(p, r)).toBeLessThan(0);
          }
        }
      }
    }
  });

  it('排序是阅读顺序而非勾选顺序 —— 输入逆序也能排回来', () => {
    const items = [
      { id: '右下', top: 200, left: 300 },
      { id: '左上', top: 100, left: 10 },
      { id: '右上', top: 100, left: 300 },
      { id: '左下', top: 200, left: 10 },
    ];
    expect(sortByReadingOrder(items).map((x) => x.id)).toEqual(['左上', '右上', '左下', '右下']);
  });

  it('位置完全相同时按原索引保序（结果不随引擎抖动）', () => {
    const items = [
      { id: 'a', top: 50, left: 50 },
      { id: 'b', top: 50, left: 50 },
    ];
    expect(sortByReadingOrder(items).map((x) => x.id)).toEqual(['a', 'b']);
  });
});

describe('《01》§5.3 分批切分', () => {
  it('31 张 → 20 + 11（两批在**同一任务**内，序号连续）', () => {
    const items = Array.from({ length: 31 }, (_, i) => i + 1);
    const batches = splitIntoBatches(items, 20);
    expect(batches).toHaveLength(2);
    expect(batches[0]).toHaveLength(20);
    expect(batches[1]).toHaveLength(11);
    // B2 的 seqFrom 恒等于 B1 的 seqTo + 1（《03》§3 关键性质 2）
    expect(batches[1]![0]).toBe(batches[0]![batches[0]!.length - 1]! + 1);
  });

  it('恰好 20 张 → 单批；0 张 → 无批次', () => {
    expect(splitIntoBatches(Array.from({ length: 20 }, (_, i) => i), 20)).toHaveLength(1);
    expect(splitIntoBatches([], 20)).toHaveLength(0);
  });

  it('400 张 → 恰好 20 批（跨批次总量不设上限，仅受 999 约束）', () => {
    expect(splitIntoBatches(Array.from({ length: 400 }, (_, i) => i), 20)).toHaveLength(20);
  });
});

describe('回执副行的字节格式化（事实展示，非估算）', () => {
  it('38.6 MB 这类展示值', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(38.6 * 1024 * 1024)).toBe('38.6 MB');
  });
});
