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

const CRLF = Buffer.from('\r\n', 'latin1');
const DOUBLE_CRLF = Buffer.from('\r\n\r\n', 'latin1');

/**
 * 严格边界：分隔符 = `CRLF "--" boundary`，且**紧跟** `CRLF`（普通分片）或 `--`（结束分片）。
 * 只做「子串命中」会把图片字节里恰好出现的 `\r\n--<boundary>X` 误判成边界 →
 * 分片错位 / 串图 / 张数错（甚至绕过 20 张上限计数）。RFC 2046 要求校验后缀。
 *
 * @returns {{start:number, after:number}|null} after = 紧随 boundary 之后的位置
 */
function findNextDelimiter(body, dashBoundary, from) {
  const needle = Buffer.concat([CRLF, dashBoundary]);
  let at = body.indexOf(needle, from);
  while (at >= 0) {
    const after = at + needle.length;
    const a = body[after];
    const b = body[after + 1];
    const isNormal = a === 0x0d && b === 0x0a; // 后跟 CRLF → 普通分片
    const isClose = a === 0x2d && b === 0x2d;  // 后跟 '--' → 结束分片
    if (isNormal || isClose) return { start: at, after };
    at = body.indexOf(needle, at + 1); // 伪边界，继续找下一个
  }
  return null;
}

/**
 * @returns {{parts: Array<{name:string, filename:string|null, contentType:string|null, data:Buffer}>, complete: boolean}|null}
 *   complete=false 表示请求体未以结束分隔符 `--boundary--` 收尾（被截断）→ 调用方应拒绝。
 */
export function parseMultipartEx(body, contentType) {
  const boundary = getBoundary(contentType);
  if (!boundary) return null;

  const dashBoundary = Buffer.from(`--${boundary}`, 'latin1');

  // 首个 delimiter 允许出现在 body 开头（其后必须紧跟 CRLF 或 --）
  let afterFirst;
  if (body.length >= dashBoundary.length && body.subarray(0, dashBoundary.length).equals(dashBoundary)) {
    afterFirst = dashBoundary.length;
  } else {
    const at = body.indexOf(Buffer.concat([CRLF, dashBoundary]));
    if (at < 0) return { parts: [], complete: false };
    afterFirst = at + CRLF.length + dashBoundary.length;
  }

  const parts = [];
  let cursor = afterFirst;
  let complete = false;
  for (;;) {
    // cursor 指向 delimiter 之后：'--' → 结束；CRLF → 下一个分片
    if (body[cursor] === 0x2d && body[cursor + 1] === 0x2d) { complete = true; break; } // 结束边界
    if (body[cursor] !== 0x0d || body[cursor + 1] !== 0x0a) break; // 非法/截断，停止
    const partStart = cursor + 2;

    const delim = findNextDelimiter(body, dashBoundary, partStart);
    if (!delim) break; // 无闭合边界（请求被截断）：不再产出分片

    const chunk = body.subarray(partStart, delim.start);
    const headerEnd = chunk.indexOf(DOUBLE_CRLF);
    if (headerEnd >= 0) {
      const headers = parseHeaders(chunk.subarray(0, headerEnd).toString('utf8'));
      const disp = parseDisposition(headers['content-disposition']);
      parts.push({
        name: disp.name,
        filename: disp.filename,
        contentType: headers['content-type'] || null,
        data: Buffer.from(chunk.subarray(headerEnd + DOUBLE_CRLF.length)),
      });
    }
    cursor = delim.after;
  }
  return { parts, complete };
}

/**
 * @returns {Array<{name:string, filename:string|null, contentType:string|null, data:Buffer}>}
 */
export function parseMultipart(body, contentType) {
  const res = parseMultipartEx(body, contentType);
  return res === null ? null : res.parts;
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
