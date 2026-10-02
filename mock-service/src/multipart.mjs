// multipart/form-data 解析（Node 内置实现，零依赖）
// 只做本项目需要的部分：字段 name / filename / contentType / 原始字节。

function parseHeaders(block) {
  const headers = {};
  for (const line of block.split('\r\n')) {
    const idx = line.indexOf(':');
    if (idx < 0) continue;
    headers[line.slice(0, idx).trim().toLowerCase()] = line.slice(idx + 1).trim();
  }
  return headers;
}

function parseDisposition(value) {
  const out = { name: null, filename: null };
  if (!value) return out;
  const parts = value.split(';');
  for (const piece of parts.slice(1)) {
    const eq = piece.indexOf('=');
    if (eq < 0) continue;
    const key = piece.slice(0, eq).trim().toLowerCase();
    let val = piece.slice(eq + 1).trim();
    if (val.startsWith('"') && val.endsWith('"')) {
      val = val.slice(1, -1).replace(/\\"/g, '"');
    }
    if (key === 'name') out.name = val;
    else if (key === 'filename') out.filename = val;
  }
  return out;
}

export function getBoundary(contentType) {
  if (!contentType) return null;
  const m = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType);
  if (!m) return null;
  const b = (m[1] || m[2] || '').trim();
  return b || null;
}

/**
 * @returns {Array<{name:string, filename:string|null, contentType:string|null, data:Buffer}>}
 */
export function parseMultipart(body, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) return null;

  const open = Buffer.from(`--${boundary}\r\n`, 'latin1');
  const sep = Buffer.from(`\r\n--${boundary}`, 'latin1');

  let start = body.indexOf(open);
  if (start < 0) return [];
  start += open.length;

  const parts = [];
  while (start <= body.length) {
    let end = body.indexOf(sep, start);
    let last = false;
    if (end < 0) {
      end = body.length;
      last = true;
    }
    const chunk = body.subarray(start, end);
    const headerEnd = chunk.indexOf('\r\n\r\n');
    if (headerEnd >= 0) {
      const headers = parseHeaders(chunk.subarray(0, headerEnd).toString('utf8'));
      const disp = parseDisposition(headers['content-disposition']);
      parts.push({
        name: disp.name,
        filename: disp.filename,
        contentType: headers['content-type'] || null,
        data: Buffer.from(chunk.subarray(headerEnd + 4)),
      });
    }
    if (last) break;
    start = end + sep.length;
    // 结束边界 `--`
    if (body[start] === 0x2d && body[start + 1] === 0x2d) break;
    // 下一个 part 的 CRLF
    if (body[start] === 0x0d && body[start + 1] === 0x0a) start += 2;
  }
  return parts;
}

/** 名称归一：`images[]` 与 `images` 视为同一字段 */
function normalizeFieldName(name) {
  if (!name) return name;
  return name.endsWith('[]') ? name.slice(0, -2) : name;
}

/**
 * 整理成 { fields: Map<string, Buffer[]>, files: Map<string, Array<{filename,contentType,data}>> }
 */
export function groupParts(parts) {
  const fields = new Map();
  const files = new Map();
  for (const part of parts) {
    const key = normalizeFieldName(part.name);
    if (!key) continue;
    if (part.filename !== null && part.filename !== undefined) {
      if (!files.has(key)) files.set(key, []);
      files.get(key).push(part);
    } else {
      if (!fields.has(key)) fields.set(key, []);
      fields.get(key).push(part.data);
    }
  }
  return { fields, files };
}

export function firstField(fields, key) {
  const arr = fields.get(key);
  if (!arr || arr.length === 0) return null;
  return arr[0].toString('utf8');
}

export function allFieldStrings(fields, key) {
  const arr = fields.get(key);
  if (!arr) return [];
  return arr.map((b) => b.toString('utf8'));
}
