// 极简 PNG 编码器：IHDR + IDAT(deflate) + IEND + CRC32
// 用于 mock 合成「译文」：纯色 PNG，颜色按 seq 偏移色相，方便人眼识别串图。
import zlib from 'node:zlib';

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

/** HSL(hue 0-360, s 0-1, l 0-1) → [r,g,b] 0-255 */
export function hslToRgb(hue, s = 0.55, l = 0.62) {
  const h = ((hue % 360) + 360) % 360 / 360;
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const conv = (t) => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return [
    Math.round(conv(h + 1 / 3) * 255),
    Math.round(conv(h) * 255),
    Math.round(conv(h - 1 / 3) * 255),
  ];
}

/**
 * 生成纯色（可带一条浅色对角标识）PNG。
 * @param {number} width
 * @param {number} height
 * @param {number} hue 0-360
 * @returns {Buffer}
 */
export function makeSolidPng(width, height, hue) {
  const w = Math.max(1, Math.min(4096, Math.floor(width) || 400));
  const h = Math.max(1, Math.min(4096, Math.floor(height) || 600));
  const [r, g, b] = hslToRgb(hue);
  // 顶部 4px 用更亮的同色带，作为「译文」的视觉标识
  const [br, bg, bb] = hslToRgb(hue, 0.7, 0.85);

  const rowBytes = w * 3 + 1; // 每行 1 字节 filter + RGB
  const raw = Buffer.alloc(rowBytes * h);
  for (let y = 0; y < h; y++) {
    const off = y * rowBytes;
    raw[off] = 0; // filter type 0 (None)
    const top = y < 4;
    for (let x = 0; x < w; x++) {
      const p = off + 1 + x * 3;
      raw[p] = top ? br : r;
      raw[p + 1] = top ? bg : g;
      raw[p + 2] = top ? bb : b;
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 按 seq 决定色相，保证相邻序号颜色差异明显 */
export function hueForSeq(seq) {
  return (seq * 47) % 360;
}
