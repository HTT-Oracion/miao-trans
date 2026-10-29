/**
 * 服务端契约类型 —— 唯一依据《03-翻译服务接口契约》。
 *
 * ver1.0 的字段 / 枚举 / 常量逐条映射；ver2.0 只增量补入《03》§2.3 的 2 个新错误码
 * （`ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`），其余沿 ver1.0 不变
 * （《03》§2.2「13 条不变」+ §3/§4「数据结构与状态机不变」）。
 *
 * 本文件是插件侧对契约的**逐条映射**：字段名、枚举值、常量与错误码一字不改。
 * 契约变更时先改这里，再改实现（《03》§10 契约变更纪律）。
 */

// ─────────────────────────── 常量（带出处） ───────────────────────────

/** 《03》§1：box-service 默认端口与自动探测段 */
export const PORT_RANGE = { from: 5180, to: 5190 } as const;

/** 《03》§2.1：Base URL 路径前缀（端口由探测决定） */
export const API_PREFIX = '/api/v1';

/**
 * 《03》§1：健康检查应答里的服务标识 —— 端口探测的命中条件。
 *
 * 🔴 2026-10-30：宿主（miao-dock）F5 起服务由 Rust `mangasvc` 实现，
 * `/health.service` 报的是 **`manga-service`**（`mangasvc.rs::SERVICE_NAME`），
 * 不再是旧 Node 实现的 `box-service`。只认旧名 ⇒ **永远探不到**，
 * 面板一律显示「本地翻译服务未运行」，与令牌对错无关。
 *
 * 两个名字都收：旧名留着兼容仍在跑 Node 服务的机器。
 */
export const SERVICE_NAME = 'manga-service';
export const LEGACY_SERVICE_NAMES = ['box-service'] as const;

/** 端口探测的命中判据（新名 + 兼容旧名） */
export function isServiceName(v: unknown): boolean {
  return v === SERVICE_NAME || (LEGACY_SERVICE_NAMES as readonly unknown[]).includes(v);
}

/** 《03》§3：单次 API 请求携带的图片数上限。
 *  ⚠️ 它**不是**用户能选几张（那是 `SELECT_LIMIT`），也**不是**任务总量上限。 */
export const BATCH_LIMIT = 20;

/**
 * 用户在一个页面里**最多能勾选几张**（客户端选择规则，非契约常量）。
 *
 * 与 `BATCH_LIMIT` 是**两个数**。《01》§5.1 已拍板：选择上限 50、单批上限 20，
 * 提交时按阅读顺序自动切成 20 / 20 / 10 三批、追加到**同一任务** ——
 * 切批是内部行为，界面上不再出现"分批"字样，用户点一次就够。
 *
 * ⚠️ 50 **不是** 20 的整数倍：末批只有 10 张。这不是笔误，是要求的一部分 ——
 * 服务端与 `splitIntoBatches` 都必须能吃下"不满批"。
 */
export const SELECT_LIMIT = 50;

/** 《03》§7.2：NNN 恰好三位十进制补零，超 999 → SEQUENCE_OVERFLOW */
export const SEQ_MIN = 1;
export const SEQ_MAX = 999;
export const SEQ_PAD = 3;

/** 《03》§7.3：top 差值 < 8px 视为同一行 */
export const ROW_TOLERANCE = 8;

/** 《03》§6.1 步 7：漫画名长度上限（Unicode 字符，非字节） */
export const COMIC_NAME_MAX_CHARS = 64;

/** 《03》§5.5：SSE 心跳间隔 15s */
export const SSE_HEARTBEAT_MS = 15_000;

/**
 * 事件流「静默」阈值（《01》§6.4 **P0-3** 的落地参数）。
 *
 * 必须**大于**心跳间隔：服务端每 15s 一条心跳，健康但在空转的流（例如任务还在排队）
 * 期间只会有心跳。若阈值 ≤ 15s，看门狗会把「健康但安静」误判为断连，形成重连风暴。
 * 取 20s：容两次心跳的抖动余量。
 */
export const SSE_STALE_MS = 20_000;

/** 看门狗轮询间隔（够密以便及时恢复，又不至于让面板常态化做无用功） */
export const SSE_WATCHDOG_TICK_MS = 5_000;

/** 《03》§6.3：重名策略 —— 追加到已有 / 新建副本，**永不覆盖** */
export const DUPLICATE_STRATEGY = ['append', 'duplicate'] as const;
export type DuplicateStrategy = (typeof DUPLICATE_STRATEGY)[number];

/** 《03》§7.1：落盘根目录（macOS）；Windows 为 %USERPROFILE%\Pictures\Box 漫画 */
export const DEFAULT_ROOT_DIR_MAC = '~/Pictures/Box 漫画';
export const DEFAULT_ROOT_DIR_WIN = '%USERPROFILE%\\Pictures\\Box 漫画';

/** 《03》§7.2：允许的扩展名（**取自服务端对字节的嗅探结果**，不信任客户端 filename） */
export const IMAGE_EXTS = ['png', 'jpg', 'jpeg', 'webp'] as const;
export type ImageExt = (typeof IMAGE_EXTS)[number];

// ─────────────────────────── 数据模型（《03》§3） ───────────────────────────

export type TaskStatus =
  | 'queued'
  | 'running'
  | 'done'
  | 'partial_failed'
  | 'failed'
  | 'canceled';

export type ItemStatus = 'pending' | 'translating' | 'success' | 'failed' | 'skipped';

export type Variant = 'original' | 'translated';

export interface BatchDto {
  batchIndex: number;
  count: number;
  seqFrom: number;
  seqTo: number;
  status: TaskStatus;
}

export interface ItemDto {
  seq: number;
  status: ItemStatus;
  /** §4.2：`saved: false` 时 item 仍为 `success`（落盘失败不阻断主路径） */
  saved?: boolean;
  outputFile?: string;
  originalFile?: string;
  durationMs?: number;
  retryCount?: number;
  /** `skipped` 的原因：`canceled` / `already_exists`；`failed` 的原因由服务端给出 */
  reason?: string;
  ext?: ImageExt;
  sha256?: string;
}

export interface ProgressDto {
  total: number;
  done: number;
  failed: number;
  current: number;
}

export interface EtaDto {
  minSeconds: number;
  maxSeconds: number;
  /** 服务端直接给的人类可读区间，如「预计 2–4 分钟」——客户端不得自行拼接数字 */
  text: string;
}

/** 《03》§5.7：eta 可为 null（服务端不确定）→ UI 显示不定态，不显示任何数字 */
export type NullableEtaDto = EtaDto | null;

export interface TaskDto {
  taskId: string;
  comicName: string;
  /** §5.2：必须回传 —— 客户端用它渲染落盘路径预览，保证预览与实际落盘一致 */
  normalizedComicName?: string;
  outputDir?: string;
  status: TaskStatus;
  /** §5.2：从 1 起，1 = 下一个执行；**0 表示已在执行或未排队** */
  queuePosition?: number;
  batches?: BatchDto[];
  items?: ItemDto[];
  progress?: ProgressDto;
  eta?: NullableEtaDto;
  createdAt?: string;
}

/**
 * `POST /tasks` 的响应。
 *
 * `idempotentReplay` 不在《03》原文中：《03》§2.2 把 `IDEMPOTENT_REPLAY` 列为错误码
 * 但 HTTP 是 200 且注明「不报错、复用已有 taskId」。本项目裁决为「HTTP 200 + 完整
 * Task 对象 + 该可观测标记」，详见 docs/04-契约歧义处置.md A-1。
 */
export interface TaskCreatedDto extends TaskDto {
  idempotentReplay?: boolean;
}

export interface SidecarDto {
  state: 'running' | 'starting' | 'error' | 'stopped';
  port: number;
}

/** 《03》§5.1 */
export interface HealthDto {
  status: 'ok' | 'degraded' | 'starting';
  service: string;
  version: string;
  apiVersion: string;
  sidecar: SidecarDto;
  startedAt: string;
}

/** 《03》§5.7 —— **排队位次与 eta 的唯一来源** */
export interface QueueDto {
  running: {
    taskId: string;
    comicName: string;
    progress: { done: number; total: number };
  } | null;
  queued: Array<{
    taskId: string;
    comicName: string;
    /** 从 1 起，1 = 下一个执行 */
    position: number;
    imageCount: number;
    etaSeconds: { min: number; max: number } | null;
  }>;
  updatedAt: string;
}

/** 《03》§5.8：目录即索引，不维护第二份索引 */
export interface LibraryComicDto {
  comicName: string;
  dirName: string;
  path: string;
  originalCount: number;
  translatedCount: number;
  bytes?: number;
  updatedAt?: string;
}

export interface LibraryDto {
  root: string;
  comics: LibraryComicDto[];
}

export interface RevealDto {
  ok: boolean;
  path: string;
}

export interface CancelDto {
  taskId: string;
  status: 'canceled';
  /** §5.6：已落盘保留数量；`queued` 阶段取消恒为 0 */
  keptItems: number;
  outputDir?: string;
}

// ─────────────────────────── 请求体（《03》§5.2） ───────────────────────────

export interface CreateTaskPayload {
  comicName: string;
  lang?: { from: string; to: string };
  translator?: string;
  clientTaskRef?: string;
  /** 客户端生成 UUIDv4；服务端 24h 内去重 */
  idempotencyKey: string;
}

/** 待上传的单张图片（插件侧持有字节与元数据） */
export interface UploadImage {
  /** 三位补零序号，按阅读顺序生成（§5.2 的 `filename`） */
  seq: number;
  blob: Blob;
  /** 客户端认知的 MIME；服务端仍以字节嗅探为准 */
  contentType: string;
  /** 原始 `<img>` 的 currentSrc —— 回写校验 P0-1 的 expectedUrl */
  sourceUrl: string;
}

// ─────────────────────────── 错误码（《03》§2.2 + §2.3） ───────────────────────────

/**
 * ver1.0 的 13 条（《03》§2.2）**逐字保留**，另加 ver2.0 新增的 2 条（《03》§2.3：
 * `ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`）。顺序按契约原文排列。
 */
export const API_ERROR_CODES = [
  'BATCH_LIMIT_EXCEEDED',
  'COMIC_NAME_REQUIRED',
  'INVALID_COMIC_NAME',
  'INVALID_IMAGE',
  'IDEMPOTENT_REPLAY',
  'TASK_NOT_FOUND',
  'TASK_NOT_APPENDABLE',
  'TASK_NOT_CANCELABLE',
  'SEQUENCE_OVERFLOW',
  'DISK_FULL',
  'PERMISSION_DENIED',
  'UNAVAILABLE',
  'INTERNAL',
  // —— ver2.0 新增（《03》§2.3）——
  'ENGINE_NOT_READY',
  'MODEL_DOWNLOAD_FAILED',
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/**
 * 《03》§2.3 `ENGINE_NOT_READY` 响应体里 `details.sidecar.state` 的取值。
 *
 * 与 box-service `assertSidecarReady` 的抛错逐字对齐：
 * `throw new ApiError('ENGINE_NOT_READY', msg, { sidecar: { state: sc.state, port: sc.port } })`，
 * 其中这三个共同点是「**用户只需等待**，不需要做任何操作」。
 */
export const ENGINE_PREPARING_STATES = ['starting', 'prewarming', 'downloading'] as const;
export type EnginePreparingState = (typeof ENGINE_PREPARING_STATES)[number];

/**
 * 从错误详情里取「准备中」阶段。
 *
 * **只认白名单内的值**：取不到 / 形状不对 / 未知取值一律返回 `null`，
 * 由 UI 走通用兜底 —— 契约面不允许客户端**推测**一个阶段（《03》§5.7 客户端禁令精神：
 * 屏幕上出现的阶段词必须有事实来源）。
 */
export function enginePreparingStateOf(details: Record<string, unknown>): EnginePreparingState | null {
  const sidecar = details.sidecar;
  if (typeof sidecar !== 'object' || sidecar === null) return null;
  const state = (sidecar as { state?: unknown }).state;
  if (typeof state !== 'string') return null;
  return (ENGINE_PREPARING_STATES as readonly string[]).includes(state)
    ? (state as EnginePreparingState)
    : null;
}

/** 《03》§2.2 / §2.3 的 HTTP 状态映射（客户端据此判断是否需要重新配对 / 切换未就绪态） */
export const API_ERROR_HTTP: Record<ApiErrorCode, number> = {
  BATCH_LIMIT_EXCEEDED: 400,
  COMIC_NAME_REQUIRED: 400,
  INVALID_COMIC_NAME: 400,
  INVALID_IMAGE: 400,
  IDEMPOTENT_REPLAY: 200,
  TASK_NOT_FOUND: 404,
  TASK_NOT_APPENDABLE: 409,
  TASK_NOT_CANCELABLE: 409,
  SEQUENCE_OVERFLOW: 409,
  DISK_FULL: 507,
  PERMISSION_DENIED: 403,
  UNAVAILABLE: 503,
  INTERNAL: 500,
  // —— ver2.0 新增（《03》§2.3）——
  ENGINE_NOT_READY: 503,
  MODEL_DOWNLOAD_FAILED: 503,
};

/** 《03》§2.2：统一错误信封，**不为任何端点保留平铺结构** */
export interface ApiErrorEnvelope {
  error: {
    code: ApiErrorCode | string;
    message: string;
    details?: Record<string, unknown>;
  };
}

export function isApiErrorEnvelope(x: unknown): x is ApiErrorEnvelope {
  if (typeof x !== 'object' || x === null) return false;
  const e = (x as { error?: unknown }).error;
  if (typeof e !== 'object' || e === null) return false;
  const code = (e as { code?: unknown }).code;
  return typeof code === 'string';
}

/**
 * 客户端侧的统一错误类型。所有 `BoxServiceClient` 的失败都以它抛出，
 * 便于 UI 层按 `code` 做文案分流（《03》§2.2「客户端处理」列）。
 */
export class BoxServiceError extends Error {
  readonly code: ApiErrorCode | string;
  readonly status: number;
  readonly details: Record<string, unknown>;

  constructor(
    code: ApiErrorCode | string,
    message: string,
    status = 0,
    details: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'BoxServiceError';
    this.code = code;
    this.status = status;
    this.details = details;
  }

  /** 网络层失败（服务根本没应答）—— 与「服务应答了但报错」必须区分开 */
  static network(message: string): BoxServiceError {
    return new BoxServiceError('NETWORK', message, 0);
  }

  static timeout(message: string): BoxServiceError {
    return new BoxServiceError('TIMEOUT', message, 0);
  }

  /**
   * 该错误是否应当让面板切到「服务未就绪」态（《03》§2.2 + 《01》§7）。
   *
   * **边界（《03》§2.3 逐字）**：`UNAVAILABLE` 是**进程不在**（用户需启动 Box）；
   * `ENGINE_NOT_READY` 是**进程在但未就绪**（用户只需等待）。两者文案不同，
   * 不可混用 —— 因此 `ENGINE_NOT_READY` **刻意不在此列**，见 `meansEnginePreparing`。
   */
  get meansServiceNotReady(): boolean {
    return (
      this.code === 'UNAVAILABLE' ||
      this.code === 'NETWORK' ||
      this.code === 'TIMEOUT' ||
      this.status === 0
    );
  }

  /**
   * 该错误是否应切「引擎准备中」态（《03》§2.3 `ENGINE_NOT_READY`）。
   *
   * 触发条件逐字取自契约：「引擎处于 `starting` / `prewarming` / `downloading` 时
   * 收到任务」→ 503。处置（《03》§2.3 客户端处理列）：「面板切『准备中』+ 进度；
   * **不排队、不缓存**」；《01》§4.1 补一句交互：「确定」回到可点态、提示
   * 「准备完成后请重新提交」。
   *
   * 与 `meansServiceNotReady` 的区别**必须**保持**互斥**：前者是进程不在（给「启动 Box」），
   * 本项是进程在但未就绪（只给等待 / 重试，不给「启动 Box」）。
   */
  get meansEnginePreparing(): boolean {
    return this.code === 'ENGINE_NOT_READY';
  }

  /**
   * 模型缺失或 SHA256 校验失败（《03》§2.3 `MODEL_DOWNLOAD_FAILED`，503）。
   * 处置：「引导『重新下载模型』+ 日志入口」（《01》§4.3 主动作「打开 Box 重新下载模型」+「重试」）。
   */
  get meansModelDownloadFailed(): boolean {
    return this.code === 'MODEL_DOWNLOAD_FAILED';
  }

  /** 该错误是否应当引导用户重新配对（《03》§2.2 PERMISSION_DENIED 的处置） */
  get meansRepairToken(): boolean {
    return this.code === 'PERMISSION_DENIED';
  }
}

// ─────────────────────────── SSE 事件（《03》§5.5） ───────────────────────────

export interface TaskStatusEvent {
  taskId: string;
  status: TaskStatus;
  queuePosition: number;
}

export interface BatchStatusEvent {
  taskId: string;
  batchIndex: number;
  status: TaskStatus;
  seqFrom: number;
  seqTo: number;
}

export interface ItemStatusEvent {
  taskId: string;
  batchIndex: number;
  seq: number;
  status: ItemStatus;
  saved?: boolean;
  outputFile?: string;
  durationMs?: number;
}

export interface HeartbeatEvent {
  ts: string;
}

export type SseEventName = 'task.status' | 'batch.status' | 'item.status' | 'heartbeat';

export interface SseEnvelope {
  /** SSE 的 `id:` 字段，断线重连时作为 `Last-Event-ID` 回传 */
  id: string | null;
  event: SseEventName;
  data: unknown;
}
