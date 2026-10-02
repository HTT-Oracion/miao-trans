/**
 * 漫画名规范化 + 编号 + 阅读顺序排序。
 *
 * 分工（《01》§8「两个关键模块」+《03》§6）：
 *   - 本模块**只做客户端预校验**，用于即时反馈与「落盘路径预览」
 *   - **服务端仍是唯一权威**；首次提交后，预览值一律改用响应里的 `normalizedComicName`
 *
 * 「同源」的含义：同样的输入应当得到同样的输出。因此这里逐条复刻《03》§6.1 的
 * 0–10 步管线，不省略、不换序 —— 顺序本身就是规范的一部分（例如保留名检查必须在
 * NFKC **之后**，否则全角 `ＣＯＮ` 会绕过）。
 */

import {
  COMIC_NAME_MAX_CHARS,
  SEQ_MAX,
  SEQ_MIN,
  SEQ_PAD,
  ROW_TOLERANCE,
  type ApiErrorCode,
} from '../types/contract';

// ─────────────────────────── 《03》§6.1 规范化管线 ───────────────────────────

/** 步骤 2：控制字符 */
const RE_CONTROL = /[\x00-\x1F\x7F]/g;
/** 步骤 3：路径分隔符与父目录语义 */
const RE_PATH_SEP = /[/\\:]/g;
/** 步骤 4：Windows 非法字符 */
const RE_WIN_ILLEGAL = /[<>"|?*]/g;
/** 步骤 5：连续空白 */
const RE_WHITESPACE = /\s+/gu;
/** 步骤 6：尾部所有 `.` 与空格 */
const RE_TRAILING = /[.\s]+$/u;

/**
 * 步骤 8：Windows 保留名。
 * 官清单为 CON / PRN / AUX / NUL / COM1–COM9 / LPT1–LPT9（《03》§6.1），
 * 另按文档要求连带拒绝 COM0 / LPT0。
 */
export const RESERVED_NAMES: ReadonlySet<string> = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM0', 'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT0', 'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9',
]);

export type ComicNameCheck =
  | { ok: true; normalized: string; changed: boolean }
  | { ok: false; code: Extract<ApiErrorCode, 'COMIC_NAME_REQUIRED' | 'INVALID_COMIC_NAME'>; message: string };

/**
 * 执行《03》§6.1 的 0–10 步。
 *
 * 与服务的**唯一差异**：客户端不抛异常，而是返回 discriminated result，供 UI 做内联提示。
 */
export function checkComicName(raw: string): ComicNameCheck {
  // 步骤 0：合法 UTF-8 且不含 \x00
  if (raw.includes('\x00')) {
    return { ok: false, code: 'INVALID_COMIC_NAME', message: '漫画名包含非法字符' };
  }

  let s = raw;

  // 步骤 1：Unicode NFKC（折叠更多变体：：→:、ＣＯＮ→CON、１２３→123）
  s = s.normalize('NFKC');

  // 步骤 2：剥离控制字符
  s = s.replace(RE_CONTROL, '');

  // 步骤 3：剥离 `/ \ :`（「第12话/学园祭」→「第12话学园祭」，比报错宽容）
  s = s.replace(RE_PATH_SEP, '');

  // 步骤 4：剥离 Windows 非法字符
  s = s.replace(RE_WIN_ILLEGAL, '');

  // 步骤 5：连续空白折叠为单个半角空格
  s = s.replace(RE_WHITESPACE, ' ');

  // 步骤 6：去首尾空白；去尾部所有 `.` 与空格（Windows 不允许目录名以 . 或空格结尾）
  s = s.trim().replace(RE_TRAILING, '');

  // 步骤 7：长度检查 —— **超长拒绝、不截断**（静默截断会造成「用户以为叫 A、落盘叫 A′」）
  if ([...s].length > COMIC_NAME_MAX_CHARS) {
    return {
      ok: false,
      code: 'INVALID_COMIC_NAME',
      message: `漫画名最长 ${COMIC_NAME_MAX_CHARS} 个字符，当前 ${[...s].length} 个`,
    };
  }

  // 步骤 8：保留名检查（不区分大小写，NFKC 之后匹配，忽略扩展名）
  const base = stripExtension(s).toUpperCase();
  if (RESERVED_NAMES.has(base)) {
    return {
      ok: false,
      code: 'INVALID_COMIC_NAME',
      message: `「${s}」是系统保留名，请换一个`,
    };
  }

  // 步骤 9：空名检查（如输入 `///`）
  if (s.length === 0) {
    return { ok: false, code: 'COMIC_NAME_REQUIRED', message: '请填写漫画名' };
  }

  // 步骤 10：输出
  return { ok: true, normalized: s, changed: s !== raw };
}

function stripExtension(name: string): string {
  const i = name.lastIndexOf('.');
  return i > 0 ? name.slice(0, i) : name;
}

/**
 * 落盘路径预览（《01》§6.5）。
 *
 * 首次提交**前**用本地同源算法拼接；提交**后**必须改用服务端返回的
 * `outputDir`，以保证预览与实际落盘一致（《03》§5.2）。
 */
export function previewOutputPath(
  rawComicName: string,
  rootDir = '~/Pictures/Box 漫画',
): string {
  const r = checkComicName(rawComicName);
  const name = r.ok ? r.normalized : rawComicName;
  return `${rootDir}/${name}/`;
}

// ─────────────────────────── 《03》§7.2 三位补零编号 ───────────────────────────

/** `1` → `001`；供 `filename` 与序号角标共用同一口径 */
export function padSeq(seq: number): string {
  return String(seq).padStart(SEQ_PAD, '0');
}

/** 序号是否越界（《03》§7.2：超 999 → SEQUENCE_OVERFLOW） */
export function seqInRange(seq: number): boolean {
  return Number.isInteger(seq) && seq >= SEQ_MIN && seq <= SEQ_MAX;
}

/** 续编号（《03》§7.4）：`nextSeq = max(目录内已有 NNN) + 1`，空目录 → 1 */
export function nextSeq(existingSeqs: readonly number[]): number {
  if (existingSeqs.length === 0) return SEQ_MIN;
  return Math.max(...existingSeqs) + 1;
}

/** 从落盘文件名解析序号：`001.png` / `001_translated.png` → 1 */
export function parseSeqFromFileName(fileName: string): number | null {
  const m = /^(\d{3})(?:_translated)?\.(png|jpg|jpeg|webp)$/i.exec(fileName);
  if (!m) return null;
  return Number.parseInt(m[1]!, 10);
}

/** 译文文件名（《03》§7.2：分隔符为下划线） */
export function translatedFileName(seq: number, ext: string): string {
  return `${padSeq(seq)}_translated.${ext}`;
}

/** 原图文件名 */
export function originalFileName(seq: number, ext: string): string {
  return `${padSeq(seq)}.${ext}`;
}

// ─────────────────────────── 《03》§7.3 阅读顺序排序 ───────────────────────────

export interface BoxPosition {
  top: number;
  left: number;
}

/**
 * 排序 key：`( rowBucket, left )`，`rowBucket = floor(top / 8)`。
 *
 * 必须是**阅读顺序**而非勾选顺序：勾选顺序随机无稳定语义，且跨批次时在第二批
 * 没有全局参照系（《03》§7.3）。
 */
export function sortKeyOf(pos: BoxPosition, tolerance: number = ROW_TOLERANCE): [number, number] {
  return [Math.floor(pos.top / tolerance), pos.left];
}

/** 阅读顺序比较器：先行后列（同为一行按 left 从左到右） */
export function compareReadingOrder(a: BoxPosition, b: BoxPosition, tolerance: number = ROW_TOLERANCE): number {
  const [ra, la] = sortKeyOf(a, tolerance);
  const [rb, lb] = sortKeyOf(b, tolerance);
  if (ra !== rb) return ra - rb;
  return la - lb;
}

/** 对任意带 `top/left` 的条目按阅读顺序排序（稳定排序，不改原数组） */
export function sortByReadingOrder<T extends BoxPosition>(items: readonly T[], tolerance: number = ROW_TOLERANCE): T[] {
  return items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => {
      const byOrder = compareReadingOrder(x.item, y.item, tolerance);
      // 同一位置时按原索引保序，避免排序结果在不同引擎下抖动
      return byOrder !== 0 ? byOrder : x.index - y.index;
    })
    .map((x) => x.item);
}

// ─────────────────────────── 《03》§3 分批切分 ───────────────────────────

/**
 * 把已选集切分为若干批次（每批 ≤ `BATCH_LIMIT`）。
 *
 * 语义（《01》§5.3「分批提交的精确行为」）：
 *   1. 已选集先按**阅读顺序**全局排序
 *   2. 前 20 张 → `POST /tasks`（第一批）
 *   3. 其余 → `POST /tasks/{taskId}/batches` 追加为**同一任务**的后续批次
 *   4. **不产生新任务** → 批次之间不可能被其他任务隔开，序号连续
 */
export function splitIntoBatches<T>(orderedItems: readonly T[], limit: number): T[][] {
  if (limit <= 0) throw new Error('limit 必须为正整数');
  const out: T[][] = [];
  for (let i = 0; i < orderedItems.length; i += limit) {
    out.push(orderedItems.slice(i, i + limit));
  }
  return out;
}

/** 批次序号区间文案，如 `1–20`（用于与响应 `seqFrom/seqTo` 对账） */
export function seqRangeText(seqFrom: number, seqTo: number): string {
  return `${seqFrom}–${seqTo}`;
}

// ─────────────────────────── 客户端禁令的显式护栏 ───────────────────────────

/**
 * 《03》§5.7 客户端禁令：
 * 「屏幕上出现的任何阿拉伯数字，其值必须来自服务端响应字段，**不得由客户端计算**。」
 *
 * 本函数**不实现任何估算**，只用于把「禁止本地估算」这条规则固化成可检索的符号。
 * 任何试图在客户端算 eta 的代码都应当改为读取 `TaskDto.eta` / `QueueDto.etaSeconds`。
 */
export const CLIENT_SIDE_ETA_ESTIMATION = {
  forbidden: true,
  reason:
    '客户端看不到前方任务张数与单张耗时；且 Box 窗口与插件同开时两处各自估算必然显示不同数字，属契约不一致。',
} as const;

/** 字节数格式化（仅用于回执副行「共 38.6 MB」这类**事实展示**，不涉及 eta 估算） */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = bytes;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}
