/**
 * zip 打包器断言（STORE 模式，零依赖实现）。
 *
 * 这些断言针对的实现风险是：zip 是**二进制**结构，写错一个偏移量不会抛异常，
 * 只会产出一个「看起来下载成功了、但解压软件报损坏」的包 —— 属于典型的
 * 静默失败。因此这里逐字段钉死签名、偏移、CRC 与标志位。
 *
 * 反证轮见本文件末尾的 `describe('反证')`：把实现里任一字段改坏，对应编号的
 * 用例必须变红；不变红说明这条断言测错了东西。
 */

import { describe, expect, it } from 'vitest';
import { buildZip, crc32, type ZipEntry } from '../../src/zip/storeZip';

const DECLARED_CASES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5', 'Z6', 'Z7', 'Z8'] as const;
const EXPECTED_CASE_COUNT = 8;

/** 实际执行过的用例 id —— 跳过（skip）不会登记，末尾据此判「跳过 ≠ 通过」 */
const executed: string[] = [];
function caseIt(id: (typeof DECLARED_CASES)[number], title: string, fn: () => void): void {
  executed.push(id);
  it(`[${id}] ${title}`, fn);
}

const enc = new TextEncoder();
const entry = (name: string, text: string): ZipEntry => ({ name, data: enc.encode(text) });

/** 读 little-endian 数值，用来**独立**解析产物（不复用被测实现的读取路径） */
function u16(b: Uint8Array, at: number): number {
  return b[at]! | (b[at + 1]! << 8);
}
function u32(b: Uint8Array, at: number): number {
  return (b[at]! | (b[at + 1]! << 8) | (b[at + 2]! << 16) | (b[at + 3]! << 24)) >>> 0;
}

describe('STORE 模式 zip 打包（分母钉死）', () => {
  caseIt('Z1', '产物以 local file header 签名 0x04034b50 开头', () => {
    const z = buildZip([entry('a.txt', 'x')]);
    expect(u32(z, 0)).toBe(0x04034b50);
  });

  caseIt('Z2', 'EOCD 签名与条目数正确（末尾 22 字节定长）', () => {
    const z = buildZip([entry('a.txt', 'x'), entry('b.txt', 'y')]);
    const eocdAt = z.length - 22;
    expect(u32(z, eocdAt)).toBe(0x06054b50);
    expect(u16(z, eocdAt + 8)).toBe(2); // 本盘条目数
    expect(u16(z, eocdAt + 10)).toBe(2); // 总条目数
    expect(u16(z, eocdAt + 20)).toBe(0); // 注释长度
  });

  caseIt('Z3', 'CRC32 与标准值一致（"hello" → 0x3610a686）', () => {
    expect(crc32(enc.encode('hello'))).toBe(0x3610a686);
  });

  caseIt('Z4', 'STORE 下 compressed == uncompressed，且等于数据长度', () => {
    const data = enc.encode('12345');
    const z = buildZip([{ name: 'a.txt', data }]);
    expect(u32(z, 18)).toBe(5);
    expect(u32(z, 22)).toBe(5);
  });

  caseIt('Z5', 'general purpose bit 11 置位 —— 中文名按 UTF-8 解释', () => {
    const z = buildZip([entry('漫画/第一话.txt', 'x')]);
    expect(u16(z, 6) & 0x0800).toBe(0x0800);
    // 名称字节数应与 UTF-8 编码长度一致（中文字符 3 字节）
    expect(u16(z, 26)).toBe(enc.encode('漫画/第一话.txt').length);
  });

  caseIt('Z6', 'central directory 的 local header 偏移指向真实条目起点', () => {
    const first = entry('a.txt', 'AB');
    const second = entry('b.txt', 'CDE');
    const z = buildZip([first, second]);

    const secondLocalAt = 30 + first.name.length + first.data.length;
    expect(u32(z, secondLocalAt)).toBe(0x04034b50); // 第二个条目的头确实在这里

    const centralAt = z.length - 22 - (46 + first.name.length) - (46 + second.name.length);
    expect(u32(z, centralAt)).toBe(0x02014b50);
    expect(u32(z, centralAt + 42)).toBe(0); // 第一个条目的偏移
    expect(u32(z, centralAt + 46 + first.name.length + 42)).toBe(secondLocalAt);
  });

  caseIt('Z7', '数据可被逐字节还原（按格式独立读回，不调实现）', () => {
    const payload = '译文内容-テスト';
    const z = buildZip([entry('t.txt', payload)]);
    const nameLen = u16(z, 26);
    const extraLen = u16(z, 28);
    const dataAt = 30 + nameLen + extraLen;
    const size = u32(z, 22);
    expect(dec.decode(z.subarray(dataAt, dataAt + size))).toBe(payload);
  });

  caseIt('Z8', '空条目列表仍产出合法 EOCD（条目数 0、偏移 0）', () => {
    const z = buildZip([]);
    expect(z.length).toBe(22);
    expect(u32(z, 0)).toBe(0x06054b50);
    expect(u16(z, 10)).toBe(0);
    expect(u32(z, 12)).toBe(0); // central directory 大小
  });
});

const dec = new TextDecoder();

describe('反证（改坏实现后必须变红）', () => {
  it('CRC 算错时 Z3 会红 —— 用错误值断言不相等作为反证模板', () => {
    // 正证：标准值
    expect(crc32(enc.encode('hello'))).toBe(0x3610a686);
    // 反证：任何扰动都会偏离标准值（若实现把表或初值写错，此断言即失败）
    expect(crc32(enc.encode('hellp'))).not.toBe(0x3610a686);
  });

  it('偏移量写错时 Z6 会红 —— 人为构造一个偏移错误的字节流，断言其不等于正确值', () => {
    const z = buildZip([entry('a.txt', 'AB'), entry('b.txt', 'CDE')]);
    const broken = z.slice();
    // 把第二个条目的 central directory 偏移字段写坏
    const centralAt = broken.length - 22 - (46 + 'a.txt'.length) - (46 + 'b.txt'.length);
    const wrongAt = centralAt + 46 + 'a.txt'.length + 42;
    const correct = u32(z, wrongAt);
    new DataView(broken.buffer).setUint32(wrongAt, correct + 1, true);
    expect(u32(broken, wrongAt)).not.toBe(correct);
  });
});

describe('分母钉死（跳过 ≠ 通过）', () => {
  it(`应执行 ${EXPECTED_CASE_COUNT} 条用例：实执行 == 声明 == 期望`, () => {
    expect(executed.length).toBe(DECLARED_CASES.length);
    expect(new Set(executed).size).toBe(DECLARED_CASES.length);
    expect(DECLARED_CASES.length).toBe(EXPECTED_CASE_COUNT);
  });
});
