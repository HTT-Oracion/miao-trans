/**
 * content script（面板）↔ background service worker 的消息协议。
 *
 * 为什么要分层：浏览器侧有几件事**只能**在 background 做 ——
 *   1. **跨域抓原图**（《01》§4 步骤③）：content script 的 fetch 带着**页面的 origin**，
 *      漫画站的 CDN 会给它 CORS 拒；background 的 fetch 带扩展 origin，
 *      且享有 `host_permissions` 授予的跨域能力
 *   2. **调 box-service**（带 `X-Box-Token`，且需要 `chrome-extension://` origin 才过 Origin 校验）
 *   3. **消费 SSE**：`EventSource` 不能设置请求头，令牌传不上去（见 boxServiceClient 头注释②），
 *      必须用 `fetch` + `ReadableStream` —— 放在 background 才能保证 SW 存活期间不断流
 *   4. **令牌与 taskId 的持久化**（`chrome.storage.local`，《01》§3）
 *
 * 分层的代价是字节不能随手传：Chrome 扩展消息传递走序列化，**Blob 不能直传**。
 * 因此译文以 **data URL**（base64 字符串）下发 —— 见 `blobToDataUrl`。
 */

import type { SseEnvelope } from './contract';

/** 面板 → background 的请求 */
export type BgRequest =
  /** 端口探测握手（5180–5190，命中条件 service === "box-service"） */
  | { type: 'SERVICE_DISCOVER' }
  | { type: 'TOKEN_STATUS' }
  | { type: 'TOKEN_SAVE'; token: string }
  /** 批量抓原图字节，结果留在 background */
  | { type: 'IMAGES_FETCH'; items: Array<{ seq: number; key: string; url: string; contentType: string }> }
  | { type: 'IMAGES_CLEAR' }
  | {
      type: 'TASK_SUBMIT';
      comicName: string;
      idempotencyKey: string;
      clientTaskRef: string;
      /**
       * 翻译方向（ver2.1）—— 随建单下发到 `payload.lang`。缺省时不带该字段，
       * 服务端落默认方向（日译中），旧客户端行为不变。
       */
      lang?: { from: string; to: string };
      items: Array<{ seq: number; key: string }>;
    }
  | {
      type: 'TASK_APPEND_BATCH';
      taskId: string;
      idempotencyKey: string;
      items: Array<{ seq: number; key: string }>;
    }
  | { type: 'TASK_CANCEL'; taskId: string }
  | { type: 'TASK_REFRESH'; taskId: string; itemsFrom?: number; itemsTo?: number }
  | { type: 'QUEUE_REFRESH'; taskId: string }
  /** 开始/停止消费事件流；`lastEventId` 用于 P0-3 的重连恢复 */
  | { type: 'TASK_WATCH_START'; taskId: string; lastEventId?: string | null }
  | { type: 'TASK_WATCH_STOP'; taskId: string }
  /** 取译文 / 原图字节，以 data URL 形式回传（回写用） */
  | { type: 'IMAGE_LOAD_DATA_URL'; comicName: string; seq: number; variant: 'original' | 'translated' }
  | { type: 'LIBRARY_REVEAL'; comicName: string }
  /** 刷新后恢复进行中任务（P0-3） */
  | { type: 'ACTIVE_TASK_GET' }
  | { type: 'ACTIVE_TASK_CLEAR' }
  /**
   * 导出为 zip：按 seq 批量取「原图 + 译文（若有）」字节，在 background 里打包后下载。
   *
   * 为什么**必须**在 background 做：字节要带 `X-Box-Token`、要跨源，且 service worker
   * 里才有稳定的 baseUrl/token；而 Blob 不能跨消息传回面板（见本文件开头裁定），
   * 所以「取字节 → 打包 → 触发下载」三步都得收在 background 内。
   */
  | { type: 'TASK_EXPORT_ZIP'; comicName: string; seqs: number[]; fileName: string };

/**
 * background → 面板的应答。
 *
 * `error.details` 必须原样透传（不能只留 code/message/status）：ver2.0 的
 * `ENGINE_NOT_READY` 靠 `details.sidecar.state` 决定准备中浮层的**阶段副行**
 * （《01》§4.1）；丢掉 details 会让该功能「写完了但永远显示兜底文案」。
 */
export type BgResponse<T = unknown> =
  | { ok: true; data: T }
  | {
      ok: false;
      error: { code: string; message: string; status: number; details?: Record<string, unknown> };
    };

/** background → 面板的主动推送（不请自来） */
export type BgPush =
  | { type: 'SERVICE_STATE'; ready: boolean; port: number | null; hasToken: boolean }
  | { type: 'TASK_EVENT'; taskId: string; envelope: SseEnvelope }
  | { type: 'TASK_EVENT_STATE'; taskId: string; connected: boolean };

/** 进行中任务的持久化记录（《01》§3：storage 只存轻量配置） */
export interface ActiveTaskRecord {
  taskId: string;
  comicName: string;
  startedAt: number;
}

/** storage 键（集中声明，避免各处硬编码） */
export const STORAGE_KEYS = {
  token: 'boxToken',
  port: 'boxServicePort',
  activeTask: 'activeTask',
  comicNameLast: 'lastComicName',
} as const;

export function isBgRequest(x: unknown): x is BgRequest {
  return typeof x === 'object' && x !== null && typeof (x as { type?: unknown }).type === 'string';
}

export function isBgPush(x: unknown): x is BgPush {
  return isBgRequest(x) && ['SERVICE_STATE', 'TASK_EVENT', 'TASK_EVENT_STATE'].includes((x as BgRequest).type);
}
