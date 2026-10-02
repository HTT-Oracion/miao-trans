/**
 * box-service 客户端 —— **唯一的翻译入口**（《01》§8）。
 *
 * 设计要点与两处必须记录的工程裁定：
 *
 * **① 端口探测**（《03》§8.3 / 《01》§3.2）：依次请求 `5180 → 5190`，
 *    命中条件是 `GET /health` 返回 `service === "box-service"`。只看 `service`
 *    是为了与「恰好占用该端口的其他程序」区分 —— 只看 200 会把任何本地服务
 *    误判成 box-service。
 *
 * **② SSE 不能用 `EventSource`**：`GET /tasks/{id}/events` 不是免鉴权端点
 *    （《03》§2.1 只有 `/health` 免鉴权），而 `EventSource` **无法设置自定义请求头**，
 *    令牌传不上去。因此这里用 `fetch` + `ReadableStream` 手动消费 SSE，
 *    这样既能带 `X-Box-Token`，也能带 `Last-Event-ID`（《03》§5.5 + P0-3）。
 *    代价是重连要自己实现 —— 见 `subscribeTaskEvents` 的退避逻辑。
 */

import {
  API_PREFIX,
  PORT_RANGE,
  SERVICE_NAME,
  BATCH_LIMIT,
  isApiErrorEnvelope,
  BoxServiceError,
  type CancelDto,
  type CreateTaskPayload,
  type HealthDto,
  type LibraryDto,
  type QueueDto,
  type RevealDto,
  type SseEnvelope,
  type SseEventName,
  type TaskCreatedDto,
  type TaskDto,
  type UploadImage,
  type Variant,
} from '../types/contract';
import { padSeq } from '../naming';

/** 普通请求超时 */
const TIMEOUT_MS = 20_000;
/** 上传请求超时（20 张原图可能数十 MB） */
const UPLOAD_TIMEOUT_MS = 120_000;
/** 单端口探测超时 —— 必须短，否则全段 11 个端口要等很久 */
const PROBE_TIMEOUT_MS = 1_200;

export interface RequestContext {
  fetchImpl?: typeof fetch;
}

function resolveFetch(ctx?: RequestContext): typeof fetch {
  return ctx?.fetchImpl ?? globalThis.fetch.bind(globalThis);
}

// ─────────────────────────── 端口探测 ───────────────────────────

export interface DiscoveredService {
  /** 例如 `http://127.0.0.1:5180` */
  baseUrl: string;
  port: number;
  health: HealthDto;
}

/** 探测结果：命中 / 全段未命中 */
export type DiscoverResult =
  | { ok: true; service: DiscoveredService }
  | { ok: false; triedPorts: number[] };

/**
 * 生成待探测端口序列。默认 `5180–5190`（含两端）。
 * `MOCK_PORT` 之类的自定义端口不属于规格，但探测段由参数开放，便于本地联调。
 */
export function probePorts(range = PORT_RANGE): number[] {
  const out: number[] = [];
  for (let p = range.from; p <= range.to; p += 1) out.push(p);
  return out;
}

/**
 * 端口探测握手（《03》§8.3）。
 *
 * 命中条件严格为 `service === "box-service"`，因此响应体不是该串时**不算命中**，
 * 继续探测下一个端口。
 */
export async function discoverService(
  options: { ports?: number[]; ctx?: RequestContext } = {},
): Promise<DiscoverResult> {
  const ports = options.ports ?? probePorts();
  const f = resolveFetch(options.ctx);
  for (const port of ports) {
    const baseUrl = `http://127.0.0.1:${port}`;
    try {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), PROBE_TIMEOUT_MS);
      const res = await f(`${baseUrl}${API_PREFIX}/health`, {
        method: 'GET',
        signal: ac.signal,
        cache: 'no-store',
      });
      clearTimeout(timer);
      if (!res.ok) continue;
      const body = (await res.json()) as HealthDto;
      if (body?.service === SERVICE_NAME) {
        return { ok: true, service: { baseUrl, port, health: body } };
      }
    } catch {
      // 未命中是常态（端口无人监听 / 不是 box-service），静默继续
    }
  }
  return { ok: false, triedPorts: ports };
}

// ─────────────────────────── 客户端 ───────────────────────────

export interface ClientOptions {
  /** 形如 `http://127.0.0.1:5180`，不含 `/api/v1` */
  baseUrl: string;
  /** 32 字节 CSPRNG 的 hex（64 字符） */
  token: string;
  /** 可选归因头：`X-Box-Client: extension/2.3.0` */
  clientId?: string;
  ctx?: RequestContext;
}

export class BoxServiceClient {
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions) {
    this.opts = opts;
  }

  get baseUrl(): string {
    return `${this.opts.baseUrl}${API_PREFIX}`;
  }

  private headers(extra: Record<string, string> = {}): Record<string, string> {
    const h: Record<string, string> = { 'X-Box-Token': this.opts.token };
    if (this.opts.clientId) h['X-Box-Client'] = this.opts.clientId;
    return { ...h, ...extra };
  }

  /** 统一响应处理：非 2xx → 解析错误信封 → 抛 `BoxServiceError` */
  private async handle<T>(res: Response, label: string): Promise<T> {
    const text = await res.text();
    let body: unknown = null;
    if (text.length > 0) {
      try {
        body = JSON.parse(text);
      } catch {
        body = null;
      }
    }
    if (!res.ok) {
      if (isApiErrorEnvelope(body)) {
        throw new BoxServiceError(
          body.error.code,
          body.error.message,
          res.status,
          body.error.details ?? {},
        );
      }
      throw new BoxServiceError('INTERNAL', `${label} 失败（HTTP ${res.status}）`, res.status);
    }
    return body as T;
  }

  private async withTimeout<T>(
    label: string,
    timeoutMs: number,
    run: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      return await run(ac.signal);
    } catch (err) {
      if (err instanceof BoxServiceError) throw err;
      const e = err as { name?: string; message?: string };
      if (e?.name === 'AbortError') throw BoxServiceError.timeout(`${label} 超时`);
      throw BoxServiceError.network(`${label} 无法连接本地服务`);
    } finally {
      clearTimeout(timer);
    }
  }

  // ── 读接口 ──

  /** `GET /health` —— 唯一免鉴权端点 */
  async health(signal?: AbortSignal): Promise<HealthDto> {
    const f = resolveFetch(this.opts.ctx);
    const res = await f(`${this.baseUrl}/health`, { signal, cache: 'no-store' });
    return this.handle<HealthDto>(res, '健康检查');
  }

  /** `GET /tasks/{taskId}` —— 任务详情（含 items，支持分页） */
  async getTask(
    taskId: string,
    range?: { itemsFrom?: number; itemsTo?: number },
  ): Promise<TaskDto> {
    const qs = new URLSearchParams();
    if (range?.itemsFrom != null) qs.set('itemsFrom', String(range.itemsFrom));
    if (range?.itemsTo != null) qs.set('itemsTo', String(range.itemsTo));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return this.withTimeout('查询任务', TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const res = await f(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}${suffix}`, {
        headers: this.headers(),
        signal,
        cache: 'no-store',
      });
      return this.handle<TaskDto>(res, '查询任务');
    });
  }

  /** `GET /queue` —— **排队位次与 eta 的唯一来源**，客户端不做任何本地估算 */
  async getQueue(): Promise<QueueDto> {
    return this.withTimeout('查询队列', TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const res = await f(`${this.baseUrl}/queue`, {
        headers: this.headers(),
        signal,
        cache: 'no-store',
      });
      return this.handle<QueueDto>(res, '查询队列');
    });
  }

  /** `GET /library` */
  async getLibrary(): Promise<LibraryDto> {
    return this.withTimeout('查询漫画库', TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const res = await f(`${this.baseUrl}/library`, {
        headers: this.headers(),
        signal,
        cache: 'no-store',
      });
      return this.handle<LibraryDto>(res, '查询漫画库');
    });
  }

  /** `GET /library/{comicName}/files/{seq}?variant=` —— 导出用文件流 */
  async fetchLibraryFile(
    comicName: string,
    seq: number,
    variant: Variant,
  ): Promise<Blob> {
    return this.withTimeout('读取文件', TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const url = `${this.baseUrl}/library/${encodeURIComponent(comicName)}/files/${seq}?variant=${variant}`;
      const res = await f(url, { headers: this.headers(), signal, cache: 'no-store' });
      if (!res.ok) {
        const text = await res.text();
        let body: unknown = null;
        try {
          body = JSON.parse(text);
        } catch {
          body = null;
        }
        if (isApiErrorEnvelope(body)) {
          throw new BoxServiceError(body.error.code, body.error.message, res.status);
        }
        throw new BoxServiceError('INTERNAL', `读取文件失败（HTTP ${res.status}）`, res.status);
      }
      return res.blob();
    });
  }

  // ── 写接口 ──

  /**
   * `POST /tasks` —— 创建任务（首个批次 ≤ 20 张）。
   *
   * `IDEMPOTENT_REPLAY` 在契约里是「HTTP 200 + 复用已有 taskId，不报错」，
   * 因此这里把它当**成功**处理，并把 `idempotentReplay` 带出去供上层观测。
   */
  async createTask(
    payload: CreateTaskPayload,
    images: readonly UploadImage[],
  ): Promise<TaskCreatedDto> {
    if (images.length > BATCH_LIMIT) {
      // 面板内正常路径不可达（《01》§5.1 提交阶段已硬拦）；这里是纵深防御
      throw new BoxServiceError(
        'BATCH_LIMIT_EXCEEDED',
        `单次最多提交 ${BATCH_LIMIT} 张，当前 ${images.length} 张`,
        400,
        { limit: BATCH_LIMIT, submitted: images.length },
      );
    }
    return this.withTimeout('创建任务', UPLOAD_TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const body = buildTaskFormData(payload, images);
      const res = await f(`${this.baseUrl}/tasks`, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal,
      });
      return this.handle<TaskCreatedDto>(res, '创建任务');
    });
  }

  /**
   * `POST /tasks/{taskId}/batches` —— 向**同一任务**追加批次。
   *
   * 这是「分批提交」的唯一实现路径（《03》§5.3）：第二及以后的批次追加到同一任务，
   * 而非新建任务，因此批次之间不可能被其他任务隔开、序号连续。
   */
  async appendBatch(
    taskId: string,
    images: readonly UploadImage[],
    idempotencyKey: string,
    imageOrder?: number[],
  ): Promise<TaskDto> {
    if (images.length > BATCH_LIMIT) {
      throw new BoxServiceError(
        'BATCH_LIMIT_EXCEEDED',
        `单次最多提交 ${BATCH_LIMIT} 张，当前 ${images.length} 张`,
        400,
        { limit: BATCH_LIMIT, submitted: images.length },
      );
    }
    const payload: CreateTaskPayload = { comicName: '', idempotencyKey };
    return this.withTimeout('追加批次', UPLOAD_TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const body = buildBatchFormData(payload, images, imageOrder);
      const res = await f(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/batches`, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal,
      });
      return this.handle<TaskDto>(res, '追加批次');
    });
  }

  /**
   * 带重试的批次追加。
   *
   * 《03》§5.3 边界：「第 2 批因网络失败 → 客户端重试 + `idempotencyKey` 去重；
   * 若最终失败，任务仍会在 B1 完成后 `done`，客户端展示
   * 『本批已完成 20 张 · 剩余 11 张待提交』+『继续提交剩余』」。
   * 因此重试必须**复用同一个 idempotencyKey**，否则会产生重复批次。
   */
  async appendBatchWithRetry(
    taskId: string,
    images: readonly UploadImage[],
    idempotencyKey: string,
    attempts = 3,
  ): Promise<{ ok: true; task: TaskDto } | { ok: false; error: BoxServiceError }> {
    let last: BoxServiceError | null = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const task = await this.appendBatch(taskId, images, idempotencyKey);
        return { ok: true, task };
      } catch (err) {
        const e =
          err instanceof BoxServiceError ? err : BoxServiceError.network('追加批次失败');
        last = e;
        // 只有「服务不可达」类错误值得重试；4xx 是确定性拒绝，重试无意义
        if (!e.meansServiceNotReady) break;
        await sleep(300 * 2 ** i);
      }
    }
    return { ok: false, error: last ?? BoxServiceError.network('追加批次失败') };
  }

  /** `POST /tasks/{taskId}/cancel` */
  async cancelTask(taskId: string): Promise<CancelDto> {
    return this.withTimeout('取消任务', TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const res = await f(`${this.baseUrl}/tasks/${encodeURIComponent(taskId)}/cancel`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: '{}',
        signal,
      });
      return this.handle<CancelDto>(res, '取消任务');
    });
  }

  /** `POST /library/{comicName}/reveal` —— 由本地端打开系统文件管理器 */
  async reveal(comicName: string): Promise<RevealDto> {
    return this.withTimeout('打开目录', TIMEOUT_MS, async (signal) => {
      const f = resolveFetch(this.opts.ctx);
      const res = await f(`${this.baseUrl}/library/${encodeURIComponent(comicName)}/reveal`, {
        method: 'POST',
        headers: this.headers({ 'Content-Type': 'application/json' }),
        body: '{}',
        signal,
      });
      return this.handle<RevealDto>(res, '打开目录');
    });
  }
}

// ─────────────────────────── multipart 构造 ───────────────────────────

function extFromMime(mime: string): string {
  const m = mime.toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  return 'png';
}

/**
 * `POST /tasks` 的 multipart 体（《03》§5.2）。
 *
 * `filename` 为**三位补零序号**（`001.png`），按阅读顺序生成。
 * 注意服务端**不信任该 filename** —— 扩展名一律以字节嗅探为准。
 * 这里仍然把它写对，一是契约要求，二是让服务端日志可读。
 */
export function buildTaskFormData(
  payload: CreateTaskPayload,
  images: readonly UploadImage[],
): FormData {
  const fd = new FormData();
  fd.append('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  for (const img of images) {
    const ext = extFromMime(img.contentType);
    fd.append('images[]', img.blob, `${padSeq(img.seq)}.${ext}`);
  }
  if (images.length > 0) {
    fd.append('imageOrder[]', new Blob([images.map((i) => String(i.seq)).join(',')], { type: 'text/plain' }));
  }
  return fd;
}

/** `POST /tasks/{id}/batches` 的 multipart 体 —— 省略 comicName / lang / translator（自任务继承） */
export function buildBatchFormData(
  payload: CreateTaskPayload,
  images: readonly UploadImage[],
  imageOrder?: number[],
): FormData {
  const fd = new FormData();
  fd.append('payload', new Blob([JSON.stringify(payload)], { type: 'application/json' }));
  for (const img of images) {
    const ext = extFromMime(img.contentType);
    fd.append('images[]', img.blob, `${padSeq(img.seq)}.${ext}`);
  }
  fd.append(
    'imageOrder[]',
    new Blob([(imageOrder ?? images.map((i) => i.seq)).join(',')], { type: 'text/plain' }),
  );
  return fd;
}

// ─────────────────────────── SSE 消费 ───────────────────────────

/** 单一 SSE 事件块的解析结果 */
export interface SseDispatch {
  id: string | null;
  event: string;
  data: string;
}

/**
 * SSE 增量解析器。
 *
 * 之所以自己写而不依赖 `EventSource`：需要在请求头里带 `X-Box-Token`（见文件头注释②）。
 * 解析规则按 SSE 规范：`data:` 可多次出现并拼接 `\n`，冒号开头的行是注释（服务端
 * 用 `: connected` 做链路确认），空行触发派发。
 */
export class SseParser {
  private buffer = '';
  private id: string | null = null;
  private event = '';
  private dataLines: string[] = [];

  push(chunk: string): SseDispatch[] {
    this.buffer += chunk;
    const out: SseDispatch[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const rawLine = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;

      if (line === '') {
        const d = this.dispatch();
        if (d) out.push(d);
        continue;
      }
      if (line.startsWith(':')) continue; // 注释 / 心跳注释
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);

      if (field === 'id') this.id = value;
      else if (field === 'event') this.event = value;
      else if (field === 'data') this.dataLines.push(value);
    }
    return out;
  }

  private dispatch(): SseDispatch | null {
    if (this.dataLines.length === 0 && this.event === '') {
      // 空块（例如只有注释后跟空行），重置事件名但不派发
      this.event = '';
      return null;
    }
    const d: SseDispatch = {
      id: this.id,
      event: this.event || 'message',
      data: this.dataLines.join('\n'),
    };
    this.event = '';
    this.dataLines = [];
    return d;
  }
}

export interface TaskEventStreamOptions {
  /** 上次收到的事件 id，重连时作为 `Last-Event-ID` 回传（P0-3：切页后靠它恢复进度） */
  lastEventId?: string | null;
  onEvent: (e: SseEnvelope) => void;
  onOpen?: () => void;
  onError?: (err: BoxServiceError) => void;
  /** 关闭信号：页面卸载 / 面板关闭时 abort */
  signal?: AbortSignal;
  /** 重连退避基数与上限 */
  backoffBaseMs?: number;
  backoffMaxMs?: number;
  ctx?: RequestContext;
}

/**
 * 订阅任务事件流，自动重连并在重连时带上 `Last-Event-ID`。
 *
 * 《03》§5.5：「客户端断线重连，可选 `Last-Event-ID`」；
 * 《01》§6.4 P0-3：「`taskId` 不与页面生命周期绑定；切页后用 `Last-Event-ID`
 * 重连 SSE 恢复进度」—— 否则「排队第 N 位」在切页后消失，用户会以为任务丢了而**重复提交**。
 */
export function subscribeTaskEvents(
  opts: ClientOptions,
  taskId: string,
  stream: TaskEventStreamOptions,
): { close: () => void; getLastEventId: () => string | null } {
  const f = resolveFetch(opts.ctx);
  const base = `${opts.baseUrl}${API_PREFIX}/tasks/${encodeURIComponent(taskId)}/events`;
  const backoffBase = stream.backoffBaseMs ?? 500;
  const backoffMax = stream.backoffMaxMs ?? 15_000;

  let lastEventId: string | null = stream.lastEventId ?? null;
  let attempt = 0;
  let closed = false;
  const ac = new AbortController();
  if (stream.signal) {
    if (stream.signal.aborted) ac.abort();
    else stream.signal.addEventListener('abort', () => ac.abort(), { once: true });
  }

  const loop = async (): Promise<void> => {
    while (!closed) {
      try {
        const headers: Record<string, string> = { 'X-Box-Token': opts.token, Accept: 'text/event-stream' };
        if (opts.clientId) headers['X-Box-Client'] = opts.clientId;
        if (lastEventId) headers['Last-Event-ID'] = lastEventId;

        const res = await f(base, { headers, signal: ac.signal, cache: 'no-store' });
        if (!res.ok) {
          const text = await res.text();
          let body: unknown = null;
          try {
            body = JSON.parse(text);
          } catch {
            body = null;
          }
          if (isApiErrorEnvelope(body)) {
            throw new BoxServiceError(body.error.code, body.error.message, res.status);
          }
          throw new BoxServiceError('INTERNAL', `事件流连接失败（HTTP ${res.status}）`, res.status);
        }
        if (!res.body) throw BoxServiceError.network('事件流没有响应体');

        attempt = 0;
        stream.onOpen?.();

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        const parser = new SseParser();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          for (const d of parser.push(decoder.decode(value, { stream: true }))) {
            if (d.id) lastEventId = d.id;
            stream.onEvent({
              id: d.id,
              event: d.event as SseEventName,
              data: safeJson(d.data),
            });
          }
        }
        // 服务端正常关闭 → 退避后重连（任务可能还在跑）
        if (closed) return;
        await sleep(backoffBase);
      } catch (err) {
        if (closed || ac.signal.aborted) return;
        const e =
          err instanceof BoxServiceError ? err : BoxServiceError.network('事件流中断');
        stream.onError?.(e);
        attempt += 1;
        const delay = Math.min(backoffMax, backoffBase * 2 ** (attempt - 1));
        await sleep(delay);
      }
    }
  };

  void loop();

  return {
    close: () => {
      closed = true;
      ac.abort();
    },
    getLastEventId: () => lastEventId,
  };
}

function safeJson(text: string): unknown {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** 生成 UUIDv4（`idempotencyKey` 与 `clientTaskRef` 用） */
export function uuidV4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
