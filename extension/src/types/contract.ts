/**
 * 服务端契约类型 —— 唯一依据《03-翻译服务接口契约-ver1.0.md》。
 *
 * 本文件是插件侧对契约的**逐条映射**：字段名、枚举值、常量与错误码一字不改。
 * 契约变更时先改这里，再改实现（《03》§10 契约变更纪律）。
 */

// ─────────────────────────── 常量（带出处） ───────────────────────────

/** 《03》§1：box-service 默认端口与自动探测段 */
export const PORT_RANGE = { from: 5180, to: 5190 } as const;

/** 《03》§2.1：Base URL 路径前缀（端口由探测决定） */
export const API_PREFIX = '/api/v1';

/** 《03》§1：健康检查应答里的服务标识 —— 端口探测的唯一命中条件 */
export const SERVICE_NAME = 'box-service';

/** 《03》§3：单次 API 请求携带的图片数上限（不是任务总量上限） */
export const BATCH_LIMIT = 20;

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

// ─────────────────────────── 错误码（《03》§2.2） ───────────────────────────

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
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

/** 《03》§2.2 的 HTTP 状态映射（客户端据此判断是否需要重新配对 / 切换未就绪态） */
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

  /** 该错误是否应当让面板切到「服务未就绪」态（《03》§2.2 + 《01》§7） */
  get meansServiceNotReady(): boolean {
    return (
      this.code === 'UNAVAILABLE' ||
      this.code === 'NETWORK' ||
      this.code === 'TIMEOUT' ||
      this.status === 0
    );
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
