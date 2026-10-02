// 图片字节嗅探与尺寸解析（绝不信任客户端 filename，契约 §7.2）

/**
 * 嗅探图片类型：只看字节头。
 * @returns {'png'|'jpg'|'webp'|null}
 */
export function sniffImageType(buf) {
  if (!Buffer.isBuffer(buf) || buf.length === 0) return null;
  if (buf.length >= 8 &&
      buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
      buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a) {
    return 'png';
  }
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return 'jpg';
  }
  if (buf.length >= 12 &&
      buf.toString('latin1', 0, 4) === 'RIFF' &&
      buf.toString('latin1', 8, 12) === 'WEBP') {
    return 'webp';
  }
  return null;
}

/** 解析尺寸，失败返回 null */
export function readImageSize(buf, type) {
  try {
    if (type === 'png') return readPngSize(buf);
    if (type === 'jpg') return readJpegSize(buf);
    if (type === 'webp') return readWebpSize(buf);
  } catch {
    return null;
  }
  return null;
}

function readPngSize(buf) {
  if (buf.length < 24) return null;
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  if (!width || !height) return null;
  return { width, height };
}

function readJpegSize(buf) {
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) { i++; continue; }
    const marker = buf[i + 1];
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      i += 2;
      continue;
    }
    const len = buf.readUInt16BE(i + 2);
    const isSof = (marker >= 0xc0 && marker <= 0xc3) ||
                  (marker >= 0xc5 && marker <= 0xc7) ||
                  (marker >= 0xc9 && marker <= 0xcb) ||
                  (marker >= 0xcd && marker <= 0xcf);
    if (isSof) {
      const height = buf.readUInt16BE(i + 5);
      const width = buf.readUInt16BE(i + 7);
      if (!width || !height) return null;
      return { width, height };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function readWebpSize(buf) {
  const fourcc = buf.toString('latin1', 12, 16);
  if (fourcc === 'VP8X' && buf.length >= 30) {
    const width = 1 + (buf[24] | (buf[25] << 8) | (buf[26] << 16));
    const height = 1 + (buf[27] | (buf[28] << 8) | (buf[29] << 16));
    return { width, height };
  }
  if (fourcc === 'VP8 ' && buf.length >= 30) {
    const width = buf.readUInt16LE(26) & 0x3fff;
    const height = buf.readUInt16LE(28) & 0x3fff;
    if (!width || !height) return null;
    return { width, height };
  }
  if (fourcc === 'VP8L' && buf.length >= 25) {
    const bits = buf.readUInt32LE(21);
    const width = (bits & 0x3fff) + 1;
    const height = ((bits >> 14) & 0x3fff) + 1;
    return { width, height };
  }
  return null;
}
