// 漫画名规范化（契约 §6.1）—— 服务端唯一执行，客户端只做预校验。

export const MAX_NAME_CHARS = 64;

// 保留名清单：含 COM0 / LPT0（以免混淆），比对不区分大小写
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

function fail(code, message, details) {
  return { ok: false, code, message, details: details || {} };
}

/**
 * 按 §6.1 的 0–10 步管线处理。
 * @returns {{ok:true,name:string}|{ok:false,code:string,message:string,details:object}}
 */
export function normalizeComicName(raw) {
  // 缺失 / 非字符串
  if (raw === undefined || raw === null) {
    return fail('COMIC_NAME_REQUIRED', 'comicName 缺失', { field: 'comicName' });
  }
  if (typeof raw !== 'string') {
    return fail('INVALID_COMIC_NAME', 'comicName 必须是字符串', { type: typeof raw });
  }

  // 步 0：拒绝 U+0000
  if (raw.includes('\u0000')) {
    return fail('INVALID_COMIC_NAME', '漫画名包含非法控制字符 U+0000', { char: 'U+0000' });
  }

  // 步 1：NFKC
  let s = raw.normalize('NFKC');
  // 步 2：剥离控制字符
  s = s.replace(/[\u0000-\u001f\u007f]/g, '');
  // 步 3：剥离路径分隔符与父目录语义
  s = s.replace(/[/\\:]/g, '');
  // 步 4：剥离 Windows 非法字符
  s = s.replace(/[<>"|?*]/g, '');
  // 步 5：折叠连续空白为单个半角空格
  s = s.replace(/\s+/g, ' ');
  // 步 6：去首尾空白 + 去尾部所有 `.` 与空格
  s = s.replace(/^ +/, '').replace(/[. ]+$/, '');

  const charCount = [...s].length;
  // 步 7：长度检查（Unicode 字符数，非字节）
  if (charCount > MAX_NAME_CHARS) {
    return fail('INVALID_COMIC_NAME',
      `漫画名超过 ${MAX_NAME_CHARS} 个字符（当前 ${charCount}）`,
      { limit: MAX_NAME_CHARS, length: charCount });
  }
  // 步 8：保留名检查（忽略扩展名，不区分大小写）
  const base = (s.split('.')[0] || '').toUpperCase();
  if (RESERVED.has(base)) {
    return fail('INVALID_COMIC_NAME', `「${s}」是系统保留名，不能用作漫画名`, { reserved: base });
  }
  // 步 9：空名检查
  if (s.length === 0) {
    return fail('COMIC_NAME_REQUIRED', '漫画名规范化后为空', { input: raw });
  }
  // 步 10
  return { ok: true, name: s };
}

/**
 * 二次断言：规范化结果不得含「路径成分」（契约 §8.2 校验点 2）。
 *
 * 语义是**防路径穿越**，所以按**路径成分**判定而不是子串匹配：
 * 只有「存在恰好等于 `.` 或 `..` 的成分」/「含 `/` `\`」/「含 NUL」/「为空」才是危险。
 * `a..b` 没有分隔符、无法穿越，是合法漫画名，必须放行。
 * （契约 §6.1 第 3 步已把 `/ \ :` 剥离，归一化之后真实穿越已不可达；此处是 backstop。）
 */
export function isSafeDirName(name) {
  if (typeof name !== 'string' || name.length === 0) return false;
  if (name.includes('\u0000')) return false;
  if (name.includes('/') || name.includes('\\')) return false;
  const components = name.split(/[/\\]/);
  if (components.some((c) => c === '.' || c === '..')) return false;
  return true;
}
