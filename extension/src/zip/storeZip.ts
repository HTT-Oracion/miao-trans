/**
 * 零依赖 zip 打包器 —— **仅 STORE 模式（不压缩）**。
 *
 * 为什么自己写而不装 jszip / fflate：
 *   1. 本仓库纪律（AGENTS.md §2.8）：**不引入未经确认的新依赖**。
 *   2. 打包的对象是 PNG/JPEG/WebP，本身就是压缩过的字节流，
 *      DEFLATE 再压一遍几乎不省体积，只白白吃 CPU 与内存。
 *   3. 需要跑在 **background service worker** 里 —— 那里没有 DOM，
 *      依赖 DOM API 的打包库会直接崩。
 *
 * 因此这里只实现 store 方式：local file header + 数据 + central directory + EOCD。
 * 格式依据 APPNOTE.TXT 6.3.x 的最小子集（单盘、无分卷、无 zip64）。
 */

/** CRC-32 表（IEEE 802.3 多项式 0xEDB88320），惰性生成一次 */
let crcTable: Uint32Array | null = null;

function getCrcTable(): Uint32Array {
  if (crcTable) return crcTable;
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  crcTable = table;
  return table;
}

/** CRC-32（与 zlib/crc32 同算法，可被系统解压工具校验） */
export function crc32(bytes: Uint8Array): number {
  const table = getCrcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    crc = table[(crc ^ bytes[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/** DOS 时间戳：zip 只认这种格式（date 高 7 位 = 年-1980） */
function dosDateTime(d: Date): { time: number; date: number } {
  const year = Math.max(1980, d.getFullYear());
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
    date: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
  };
}

export interface ZipEntry {
  /** 包内路径，用 `/` 分隔；含非 ASCII（中文漫画名）时必须 UTF-8 编码 */
  name: string;
  data: Uint8Array;
}

/**
 * 打包为 zip 字节流。
 *
 * @param entries 顺序即包内顺序；调用方需保证 name 不重复
 * @returns zip 的完整字节
 */
export function buildZip(entries: readonly ZipEntry[], now: Date = new Date()): Uint8Array {
  const enc = new TextEncoder();
  const { time, date } = dosDateTime(now);

  // 中文文件名必须走 UTF-8 并置 general purpose bit 11，否则解压出来是乱码
  const prepared = entries.map((e) => {
    const nameBytes = enc.encode(e.name);
    return { nameBytes, data: e.data, crc: crc32(e.data) };
  });

  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const item of prepared) {
    // ── local file header（30 字节定长 + 文件名） ──
    const local = new Uint8Array(30 + item.nameBytes.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true); // signature
    lv.setUint16(4, 20, true); // version needed
    lv.setUint16(6, 0x0800, true); // flags: bit 11 = UTF-8 名称
    lv.setUint16(8, 0, true); // method: store
    lv.setUint16(10, time, true);
    lv.setUint16(12, date, true);
    lv.setUint32(14, item.crc, true);
    lv.setUint32(18, item.data.length, true); // compressed size
    lv.setUint32(22, item.data.length, true); // uncompressed size（store 下相等）
    lv.setUint16(26, item.nameBytes.length, true);
    lv.setUint16(28, 0, true); // extra length
    local.set(item.nameBytes, 30);

    localParts.push(local, item.data);

    // ── central directory header（46 字节定长 + 文件名） ──
    const central = new Uint8Array(46 + item.nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(4, 20, true); // version made by
    cv.setUint16(6, 20, true); // version needed
    cv.setUint16(8, 0x0800, true);
    cv.setUint16(10, 0, true);
    cv.setUint16(12, time, true);
    cv.setUint16(14, date, true);
    cv.setUint32(16, item.crc, true);
    cv.setUint32(20, item.data.length, true);
    cv.setUint32(24, item.data.length, true);
    cv.setUint16(28, item.nameBytes.length, true);
    cv.setUint16(30, 0, true); // extra
    cv.setUint16(32, 0, true); // comment
    cv.setUint16(34, 0, true); // disk number start
    cv.setUint16(36, 0, true); // internal attrs
    cv.setUint32(38, 0, true); // external attrs
    cv.setUint32(42, offset, true); // local header 的起始偏移
    central.set(item.nameBytes, 46);

    centralParts.push(central);

    offset += local.length + item.data.length;
  }

  const centralSize = centralParts.reduce((n, p) => n + p.length, 0);

  // ── end of central directory（22 字节定长） ──
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(4, 0, true); // disk number
  ev.setUint16(6, 0, true); // disk with central directory
  ev.setUint16(8, prepared.length, true);
  ev.setUint16(10, prepared.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  ev.setUint16(20, 0, true); // comment length

  const total = offset + centralSize + eocd.length;
  const out = new Uint8Array(total);
  let cursor = 0;
  for (const part of [...localParts, ...centralParts, eocd]) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

/** 便捷封装：直接产出可下载的 Blob（service worker 里有 Blob/URL 构造器） */
export function buildZipBlob(entries: readonly ZipEntry[], now: Date = new Date()): Blob {
  const bytes = buildZip(entries, now);
  // 复制一份，避免 Blob 持有整个 out 缓冲区的引用（此处两者同为独占内存，保险起见切片）
  return new Blob([bytes.slice()], { type: 'application/zip' });
}
