/**
 * background service worker。
 *
 * 职责（《01》§3 / §4）：
 *   - 端口探测与令牌持有（`chrome.storage.local`，**只存轻量配置**）
 *   - 跨域抓原图 → 内存态 blob（**不写 storage、不落文件**）
 *   - 调 box-service（唯一翻译入口）
 *   - 消费 SSE 并推送给面板；持有 `Last-Event-ID` 以支持 P0-3 的切页重连
 */

import { defineBackground } from 'wxt/utils/define-background';
import { browser } from 'wxt/browser';

import { BoxServiceError, type SseEnvelope, type TaskCreatedDto, type TaskDto } from '../src/types/contract';
import {
  BoxServiceClient,
  discoverService,
  probePorts,
  subscribeTaskEvents,
  type DiscoveredService,
} from '../src/adapters/boxServiceClient';
import {
  STORAGE_KEYS,
  type ActiveTaskRecord,
  type BgRequest,
  type BgResponse,
  type BgPush,
} from '../src/types/messages';
import { type UploadImage } from '../src/types/contract';
import { buildZipBlob, type ZipEntry } from '../src/zip/storeZip';
import { originalFileName, translatedFileName } from '../src/naming';

// ─────────────────────────── 运行态（SW 可被回收，持久项一律落 storage） ───────────────────────────

interface RuntimeState {
  service: DiscoveredService | null;
  /** 上次命中的端口；下次探测优先试它，避免每次都从 5180 扫起 */
  cachedPort: number | null;
  token: string | null;
  /** 已抓取的原图字节，key → { seq, blob, contentType } */
  blobs: Map<string, { seq: number; blob: Blob; contentType: string }>;
  /** 每个 tab 上正在消费的事件流 */
  streams: Map<number, { taskId: string; close: () => void }>;
}

const rt: RuntimeState = {
  service: null,
  cachedPort: null,
  token: null,
  blobs: new Map(),
  streams: new Map(),
};

const CLIENT_ID = 'extension/1.0.0';

async function loadPersisted(): Promise<void> {
  const got = await browser.storage.local.get([STORAGE_KEYS.token, STORAGE_KEYS.port]);
  const token = got[STORAGE_KEYS.token];
  rt.token = typeof token === 'string' && token.length > 0 ? token : null;
  const port = got[STORAGE_KEYS.port];
  rt.cachedPort = typeof port === 'number' ? port : null;
}

function client(): BoxServiceClient {
  if (!rt.service) throw BoxServiceError.network('尚未发现本地服务');
  if (!rt.token) throw new BoxServiceError('PERMISSION_DENIED', '尚未配对令牌', 403);
  return new BoxServiceClient({ baseUrl: rt.service.baseUrl, token: rt.token, clientId: CLIENT_ID });
}

/**
 * 端口探测（《03》§8.3 / 《01》§3.2）。
 *
 * 已有命中端口时优先重试该端口，再退化为整段扫描 —— 避免每次消息都从 5180 扫到 5190。
 * `force` 用于用户显式点「重试」的场景。
 */
async function ensureService(force = false): Promise<DiscoveredService | null> {
  if (rt.service && !force) return rt.service;
  const full = probePorts();
  const ports =
    rt.cachedPort != null
      ? [rt.cachedPort, ...full.filter((p) => p !== rt.cachedPort)]
      : full;
  const found = await discoverService({ ports });
  if (!found.ok) {
    rt.service = null;
    return null;
  }
  rt.service = found.service;
  rt.cachedPort = found.service.port;
  await browser.storage.local.set({ [STORAGE_KEYS.port]: found.service.port });
  return rt.service;
}

// ─────────────────────────── 抓图 ───────────────────────────

/**
 * 抓取单张原图字节。
 *
 * 说明：这里用扩展 origin 发起请求（background 拥有 `host_permissions`），
 * 因此不受漫画站自身 CORS 策略影响。
 * 已知限制：部分 CDN 有**防盗链**（校验 `Referer`），扩展发起的请求不带页面
 * Referer，这类图会抓取失败 —— 失败会如实回报给面板逐张标红，不静默吞掉。
 */
async function fetchImageBlob(url: string): Promise<{ blob: Blob; contentType: string }> {
  const res = await fetch(url, { cache: 'default', credentials: 'omit' });
  if (!res.ok) throw BoxServiceError.network(`原图下载失败（HTTP ${res.status}）`);
  const blob = await res.blob();
  if (blob.size === 0) throw new BoxServiceError('INVALID_IMAGE', '原图为空', 400);
  return { blob, contentType: blob.type || 'image/png' };
}

// ─────────────────────────── 字节 → data URL ───────────────────────────

/**
 * Blob → data URL。
 *
 * 为什么不是直接传 Blob：Chrome 扩展的消息传递对字节类型支持有限，
 * 跨上下文传 Blob 不可靠。data URL 是纯字符串，一定能过。
 * 代价是 base64 有约 33% 膨胀 —— 因此**逐张按需下发**，不一次性传整批。
 *
 * 注意：ServiceWorkerGlobalScope **没有 `FileReader`**，所以用
 * `arrayBuffer()` + 分块 `btoa`。
 */
export async function blobToDataUrl(blob: Blob): Promise<string> {
  const buf = new Uint8Array(await blob.arrayBuffer());
  const CHUNK = 0x8000;
  let binary = '';
  for (let i = 0; i < buf.length; i += CHUNK) {
    binary += String.fromCharCode(...buf.subarray(i, i + CHUNK));
  }
  const b64 = btoa(binary);
  const type = blob.type || 'image/png';
  return `data:${type};base64,${b64}`;
}

/**
 * MIME → 落盘扩展名（与《03》§7.2 的 `png|jpg|jpeg|webp` 对齐）。
 *
 * 服务端以字节嗅探为准，这里的 Content-Type 只用于**拼文件名**；
 * 认不出来一律回落 `png`，与服务端落盘缺省一致。
 */
function extOf(mime: string): string {
  const m = (mime || '').toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return 'jpg';
  if (m.includes('webp')) return 'webp';
  return 'png';
}

// ─────────────────────────── 消息处理 ───────────────────────────

function pushToTab(tabId: number, message: BgPush): void {
  void browser.tabs.sendMessage(tabId, message).catch(() => {
    // 面板可能已关闭（tab 切走 / 导航中）—— 静默，不打断事件流
  });
}

function startWatch(tabId: number, taskId: string, lastEventId?: string | null): void {
  const existing = rt.streams.get(tabId);
  if (existing && existing.taskId === taskId) return;
  existing?.close();
  if (!rt.service || !rt.token) return;

  const handle = subscribeTaskEvents(
    { baseUrl: rt.service.baseUrl, token: rt.token, clientId: CLIENT_ID },
    taskId,
    {
      lastEventId: lastEventId ?? null,
      onOpen: () => pushToTab(tabId, { type: 'TASK_EVENT_STATE', taskId, connected: true }),
      onEvent: (envelope: SseEnvelope) =>
        pushToTab(tabId, { type: 'TASK_EVENT', taskId, envelope }),
      onError: () => pushToTab(tabId, { type: 'TASK_EVENT_STATE', taskId, connected: false }),
    },
  );
  rt.streams.set(tabId, { taskId, close: handle.close });
}

function stopWatch(tabId: number): void {
  const s = rt.streams.get(tabId);
  if (!s) return;
  s.close();
  rt.streams.delete(tabId);
}

function ok<T>(data: T): BgResponse<T> {
  return { ok: true, data };
}

function fail(err: unknown): BgResponse {
  if (err instanceof BoxServiceError) {
    // details 必须一起回传：`ENGINE_NOT_READY` 的阶段副行取 `details.sidecar.state`
    // （《01》§4.1 / 《03》§2.3）。在这里截断，面板侧就永远拿不到阶段。
    return {
      ok: false,
      error: { code: err.code, message: err.message, status: err.status, details: err.details },
    };
  }
  const e = err as { message?: string };
  return { ok: false, error: { code: 'INTERNAL', message: e?.message ?? '未知错误', status: 0 } };
}

/** 把已抓取的 key 集合转成待上传图片 */
function toUploadImages(items: Array<{ seq: number; key: string }>): UploadImage[] {
  const out: UploadImage[] = [];
  for (const it of items) {
    const held = rt.blobs.get(it.key);
    if (!held) {
      throw new BoxServiceError('INVALID_IMAGE', `第 ${it.seq} 张的原图字节尚未抓取完成`, 400, {
        seq: it.seq,
      });
    }
    out.push({
      seq: it.seq,
      blob: held.blob,
      contentType: held.contentType,
      sourceUrl: it.key,
    });
  }
  return out;
}

async function handle(req: BgRequest, tabId: number): Promise<BgResponse> {
  switch (req.type) {
    case 'SERVICE_DISCOVER': {
      const svc = await ensureService(true);
      return ok({
        ready: !!svc,
        port: svc?.port ?? null,
        hasToken: !!rt.token,
        health: svc?.health ?? null,
      });
    }

    case 'TOKEN_STATUS':
      return ok({ hasToken: !!rt.token, port: rt.service?.port ?? null });

    case 'TOKEN_SAVE': {
      rt.token = req.token;
      await browser.storage.local.set({ [STORAGE_KEYS.token]: req.token });
      return ok({ hasToken: true });
    }

    case 'IMAGES_FETCH': {
      const ready: number[] = [];
      const failed: Array<{ seq: number; key: string; reason: string }> = [];
      await Promise.all(
        req.items.map(async (it) => {
          try {
            const { blob, contentType } = await fetchImageBlob(it.url);
            rt.blobs.set(it.key, { seq: it.seq, blob, contentType });
            ready.push(it.seq);
          } catch (err) {
            const e = err as Error;
            failed.push({ seq: it.seq, key: it.key, reason: e.message });
          }
        }),
      );
      ready.sort((a, b) => a - b);
      failed.sort((a, b) => a.seq - b.seq);
      return ok({ ready, failed });
    }

    case 'IMAGES_CLEAR':
      rt.blobs.clear();
      return ok({ cleared: true });

    case 'TASK_SUBMIT': {
      const svc = await ensureService();
      if (!svc) throw BoxServiceError.network('未发现本地翻译服务');
      const images = toUploadImages(req.items);
      const created: TaskCreatedDto = await client().createTask(
        {
          comicName: req.comicName,
          // ver2.1：方向随建单下发（`payload.lang`）；未选时 undefined ⇒ 服务端落默认方向
          ...(req.lang ? { lang: req.lang } : {}),
          clientTaskRef: req.clientTaskRef,
          idempotencyKey: req.idempotencyKey,
        },
        images,
      );
      await persistActiveTask({
        taskId: created.taskId,
        comicName: created.normalizedComicName ?? created.comicName,
        startedAt: Date.now(),
      });
      startWatch(tabId, created.taskId, null);
      return ok(created);
    }

    case 'TASK_APPEND_BATCH': {
      const images = toUploadImages(req.items);
      const res = await client().appendBatchWithRetry(req.taskId, images, req.idempotencyKey);
      if (!res.ok) return fail(res.error);
      return ok(res.task);
    }

    case 'TASK_CANCEL': {
      const cancelled = await client().cancelTask(req.taskId);
      await browser.storage.local.remove(STORAGE_KEYS.activeTask);
      return ok(cancelled);
    }

    case 'TASK_REFRESH': {
      const task: TaskDto = await client().getTask(req.taskId, {
        itemsFrom: req.itemsFrom,
        itemsTo: req.itemsTo,
      });
      return ok(task);
    }

    case 'QUEUE_REFRESH': {
      const q = await client().getQueue();
      return ok(q);
    }

    case 'TASK_WATCH_START': {
      startWatch(tabId, req.taskId, req.lastEventId ?? null);
      return ok({ watching: true });
    }

    case 'TASK_WATCH_STOP':
      stopWatch(tabId);
      return ok({ watching: false });

    case 'IMAGE_LOAD_DATA_URL': {
      const blob = await client().fetchLibraryFile(req.comicName, req.seq, req.variant);
      // 小尺寸原图也走这条：回写只用译文，但保留原图能力给「对照」类扩展
      return ok({ dataUrl: await blobToDataUrl(blob), bytes: blob.size });
    }

    case 'LIBRARY_REVEAL':
      return ok(await client().reveal(req.comicName));

    case 'ACTIVE_TASK_GET': {
      const got = await browser.storage.local.get(STORAGE_KEYS.activeTask);
      const rec = got[STORAGE_KEYS.activeTask] as ActiveTaskRecord | undefined;
      return ok(rec ?? null);
    }

    case 'ACTIVE_TASK_CLEAR':
      await browser.storage.local.remove(STORAGE_KEYS.activeTask);
      return ok({ cleared: true });

    /**
     * 导出 zip —— 「取字节 → 打包 → 下载」三步全部收在 background 内。
     *
     * 两个刻意的设计：
     *   1. **串行取字节**：并发会同时持有多张原图 + 译文的完整内存（单张可达数 MB），
     *      service worker 内存配额有限，OOM 会让整个 SW 被回收。
     *   2. **译文缺失不算失败**：只有部分页翻译成功是常态（取消 / 部分失败），
     *      此时仍应导出已成功的部分，把缺失的 seq 回报给面板去提示。
     */
    case 'TASK_EXPORT_ZIP': {
      const c = client();
      const entries: ZipEntry[] = [];
      const missingTranslated: number[] = [];
      const failed: number[] = [];

      for (const seq of req.seqs) {
        // 原图：取不到就整张跳过，并记进 failed
        try {
          const original = await c.fetchLibraryFile(req.comicName, seq, 'original');
          entries.push({
            name: `${req.comicName}/${originalFileName(seq, extOf(original.type))}`,
            data: new Uint8Array(await original.arrayBuffer()),
          });
        } catch {
          failed.push(seq);
          continue;
        }

        // 译文：可能尚未产出，缺失是正常的，只回报不中断
        try {
          const translated = await c.fetchLibraryFile(req.comicName, seq, 'translated');
          entries.push({
            name: `${req.comicName}/${translatedFileName(seq, extOf(translated.type))}`,
            data: new Uint8Array(await translated.arrayBuffer()),
          });
        } catch {
          missingTranslated.push(seq);
        }
      }

      if (entries.length === 0) {
        throw new BoxServiceError('INTERNAL', '没有可导出的图片（服务端未找到已落盘的字节）', 0);
      }

      const blob = buildZipBlob(entries);
      const url = URL.createObjectURL(blob);
      try {
        await browser.downloads.download({ url, filename: req.fileName, saveAs: false });
      } finally {
        // 下载是异步的，给足时间再释放；过早 revoke 会拿到 0 字节文件
        setTimeout(() => URL.revokeObjectURL(url), 60_000);
      }

      return ok({
        files: entries.length,
        missingTranslated,
        failed,
        bytes: blob.size,
      });
    }

    default: {
      const never: never = req;
      return fail(new BoxServiceError('INTERNAL', `未知消息：${JSON.stringify(never)}`));
    }
  }
}

async function persistActiveTask(rec: ActiveTaskRecord): Promise<void> {
  await browser.storage.local.set({ [STORAGE_KEYS.activeTask]: rec });
}

export default defineBackground(() => {
  void loadPersisted();

  browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
    // 推送类消息由 background 发出，不该被这里收到；收到即忽略
    if (!message || typeof message !== 'object') return false;
    const type = (message as { type?: string }).type;
    if (type === 'SERVICE_STATE' || type === 'TASK_EVENT' || type === 'TASK_EVENT_STATE') {
      return false;
    }
    const tabId = sender.tab?.id;
    if (tabId == null) {
      sendResponse(fail(BoxServiceError.network('消息缺少来源标签页')));
      return false;
    }
    void handle(message as BgRequest, tabId).then(sendResponse, (e) => sendResponse(fail(e)));
    // 异步应答
    return true;
  });

  // 标签页关闭 / 主框架导航时断流，避免累积孤儿连接
  browser.tabs.onRemoved.addListener((tabId) => stopWatch(tabId));
  browser.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') stopWatch(tabId);
  });

  // 启动即尝试探测一次，让面板首屏就知道服务在不在
  void ensureService(false);
});
