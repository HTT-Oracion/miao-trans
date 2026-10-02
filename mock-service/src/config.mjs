// 运行期配置与安全路径工具
// 仅使用 node:* 内置模块，零第三方依赖。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SERVICE_NAME = 'box-service';
export const SERVICE_VERSION = '1.2.0';
export const API_VERSION = 'v1';
export const BASE_PATH = '/api/v1';

// 默认令牌：固定的合法 hex64（32 字节 hex），仅用于本地联调。
export const DEFAULT_TOKEN =
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

export const PORT_RANGE_START = 5180;
export const PORT_RANGE_END = 5190;

export const PAGE_PORT = 5199;

// 单次提交上限（契约 §3）
export const BATCH_LIMIT = 20;
// 序号上限（契约 §7.2）
export const MAX_SEQ = 999;
// eta 采样窗口：近 N 张已完成 item 的耗时
export const ETA_SAMPLE_WINDOW = 20;

const SRC_DIR = import.meta.dirname; // .../mock-service/src
export const PKG_DIR = path.resolve(SRC_DIR, '..'); // .../mock-service

function envInt(name, def) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : def;
}

function envBool(name, def = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return def;
  return !['0', 'false', 'no', 'off'].includes(String(raw).toLowerCase());
}

/** 解析 MOCK_FAIL_SEQ=3,5 形式的 seq 列表 */
export function parseSeqList(raw) {
  const out = new Set();
  if (!raw) return out;
  for (const piece of String(raw).split(',')) {
    const n = Number.parseInt(piece.trim(), 10);
    if (Number.isFinite(n) && n > 0) out.add(n);
  }
  return out;
}

export const config = {
  token: process.env.MOCK_TOKEN || DEFAULT_TOKEN,
  // 显式指定端口时不再探测（被占则启动失败）
  explicitPort: process.env.MOCK_PORT ? envInt('MOCK_PORT', PORT_RANGE_START) : null,
  portStart: PORT_RANGE_START,
  portEnd: PORT_RANGE_END,
  itemMs: envInt('MOCK_ITEM_MS', 400),
  etaNull: envBool('MOCK_ETA_NULL'),
  failSeqs: parseSeqList(process.env.MOCK_FAIL_SEQ),
  itemFailRate: Math.max(0, Math.min(1, Number(process.env.MOCK_ITEM_FAIL_RATE || 0) || 0)),
  // 幂等续做是**标准语义**（§4.2 / §7.4），不是可选开关 → 默认开启。
  // 只有显式 MOCK_SKIP_EXISTING=0/false/no/off 才关闭（关掉后保留旧的 EEXIST 行为，用于反向演练）。
  skipExisting: envBool('MOCK_SKIP_EXISTING', true),
  sidecarDown: envBool('MOCK_SIDECAR_DOWN'),
  // 可选：强制落盘失败，用于验证 saved:false / DISK_FULL 路径
  diskFull: envBool('MOCK_DISK_FULL'),
  sidecarPort: 5003,
};

// 运行期目录：mock-service/.runtime/{Box 漫画, state/tasks}
export const RUNTIME_DIR = path.resolve(PKG_DIR, '.runtime');
export const DEFAULT_ROOT = path.join(RUNTIME_DIR, 'Box 漫画');
export const ROOT_DIR = path.resolve(process.env.MOCK_ROOT || DEFAULT_ROOT);
// 任务清单目录：默认 mock-service/.runtime/state；多实例联调可用 MOCK_STATE_DIR 隔离
export const STATE_DIR = path.resolve(process.env.MOCK_STATE_DIR || path.join(RUNTIME_DIR, 'state'));
export const TASKS_STATE_DIR = path.join(STATE_DIR, 'tasks');
export const IDEMPOTENCY_FILE = path.join(STATE_DIR, 'idempotency.json');

/**
 * 规范化路径：解析已存在部分的符号链接，未存在的部分原样拼接。
 * 用于契约 §8.2 的第 3 次校验（拼接后前缀比对）。
 */
export function canonicalize(p) {
  const abs = path.resolve(p);
  let cur = abs;
  const tail = [];
  for (;;) {
    try {
      const real = fs.realpathSync(cur);
      return tail.length ? path.join(real, ...tail.reverse()) : real;
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return abs;
      tail.push(path.basename(cur));
      cur = parent;
    }
  }
}

// 黑名单条目分两种匹配语义（契约 §8.2 校验点 1）：
//  · EXACT  —— 只拒「目录本身」。这些是**容器目录**：其下仍可能是合法落盘位置
//              （如 /Users 下的 ~/Pictures/Box 漫画，见 §7.1；/private/var 下的
//              macOS TMPDIR /private/var/folders/…）。若按前缀拒绝会把合法路径一并挡掉。
//  · PREFIX —— 连子路径一并拒绝。这些是真正的系统目录。
const BLACKLIST_EXACT = () => {
  const home = os.homedir();
  return [
    path.parse(path.resolve('/')).root, // '/'（Windows 下为 'C:\\'）
    '/Users',                           // home 的父目录：本身不可作落盘根
    home,                               // 用户主目录本身（§8.2「用户主目录本身」）
    '/private',                         // TMPDIR 的真实父目录，本身不可作落盘根
    '/private/var',
    '/var',                             // → /private/var
  ];
};

const BLACKLIST_PREFIX = () => {
  const home = os.homedir();
  return [
    '/tmp',                 // → /private/tmp
    '/private/tmp',
    '/private/var/tmp',
    '/private/etc',
    '/etc',
    '/usr',
    '/System',
    '/Library',
    '/Applications',
    '/Volumes',
    '/cores',
    '/opt',
    path.join(home, 'Library'), // 修复原先「home/Library 精确相等」被 ~/Library/Caches/xxx 绕过
  ];
};

function blacklistHit(canonicalAbs) {
  for (const raw of BLACKLIST_EXACT()) {
    if (!raw) continue;
    if (canonicalAbs === canonicalize(raw)) return raw;
  }
  for (const raw of BLACKLIST_PREFIX()) {
    if (!raw) continue;
    const cb = canonicalize(raw);
    if (!cb) continue;
    // 根路径（'/'）的 `cb + sep` 为 '//'，天然不会前缀命中任何路径 → 根只做精确匹配
    if (canonicalAbs === cb || canonicalAbs.startsWith(cb + path.sep)) return raw;
  }
  return null;
}

/** 启动时校验一次（契约 §8.2 校验点 1） */
export function validateRoot(rootDir) {
  if (typeof rootDir !== 'string' || !path.isAbsolute(rootDir)) {
    throw new Error(`落盘根目录必须是绝对路径：${rootDir}`);
  }
  const abs = path.resolve(rootDir);
  const canonicalAbs = canonicalize(abs);
  const hit = blacklistHit(canonicalAbs);
  if (hit) {
    throw new Error(`落盘根目录不合法（命中黑名单 ${hit}）：${abs}`);
  }
  // 已存在的目录**不**强制 chmod（否则会抹掉「只读根目录 → 507 DISK_FULL」这类可注入条件）；
  // 新建的目录用 0700；可写性由请求期的 assertRootWritable() 校验（见 server.mjs / F-3）。
  fs.mkdirSync(abs, { recursive: true, mode: 0o700 });
  return canonicalize(abs);
}

/**
 * 拼接后前缀校验（契约 §8.2 校验点 3）。
 * target 指向「文件」时，其 parent 即漫画目录，必须位于 root 之内。
 */
export function assertInsideRoot(rootCanonical, target) {
  const parentCanonical = canonicalize(path.dirname(target));
  const ok = parentCanonical === rootCanonical
    ? false
    : parentCanonical.startsWith(rootCanonical + path.sep);
  if (!ok) throw new PathEscapeError(target);
  return true;
}

export class PathEscapeError extends Error {
  constructor(target) {
    super(`路径越界：${target}`);
    this.name = 'PathEscapeError';
  }
}

/** 文件名由服务端生成，正则固定（契约 §8.2 校验点 2） */
export const FILE_NAME_RE = /^\d{3}(_translated)?\.(png|jpg|jpeg|webp)$/;
/** 目录内用于续编号扫描的正则（契约 §7.4） */
export const ORIGINAL_SCAN_RE = /^(\d{3})\.(png|jpg|jpeg|webp)$/;
export const TRANSLATED_SCAN_RE = /^(\d{3})_translated\.(png|jpg|jpeg|webp)$/;

export function seq3(seq) {
  return String(seq).padStart(3, '0');
}
