/**
 * 面板编排层 —— 把「契约 / 状态机 / DOM 侧硬规则」接起来。
 *
 * 这里集中承载三条 P0 规则的**触发侧**：
 *   - **P0-1** 回写前校验（每次回写都过 `canWriteBack`，失败即标记「原图已离开页面」）
 *   - **P0-2** 清空判据（路由变更 → `shouldClearSelection`，覆盖无限滚动）
 *   - **P0-3** 生命周期解绑（`taskId` 存在 storage，切页后按 `Last-Event-ID` 重连 SSE）
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';
import { browser } from 'wxt/browser';

import type { ItemDto, QueueDto, SseEnvelope, TaskCreatedDto, TaskDto } from '../types/contract';
import { BoxServiceError, SSE_STALE_MS, SSE_WATCHDOG_TICK_MS } from '../types/contract';
import type { BgPush, BgRequest, BgResponse } from '../types/messages';
import { isActive, type ClientState } from '../domain/clientState';
import { collectOrderedImages, type PageImage } from '../collectImages';
import { registry } from '../store/registry';
import { batchActions } from '../store/translation/batchSlice';
import { itemActions } from '../store/translation/itemSlice';
import { selectionActions } from '../store/translation/selectionSlice';
import { toQueuePatch } from '../store/translation/queue';
import { GRID } from '../theme/tokens';
import { checkComicName, sortByReadingOrder, splitIntoBatches } from '../naming';
import { decideSubmit, shouldClearSelection, countLeftDom, type OverLimitActionId } from '../selection/rules';
import { locateImage, writeBackImage } from '../content/writeback';
import { installRouteWatcher } from '../content/routeWatcher';
import { uuidV4 } from '../adapters/boxServiceClient';

// ─────────────────────────── 与 background 通信 ───────────────────────────

export async function sendBg<T = unknown>(req: BgRequest): Promise<T> {
  const res = (await browser.runtime.sendMessage(req)) as BgResponse<T> | undefined;
  if (!res) throw BoxServiceError.network('后台无响应（服务可能已重启）');
  if (!res.ok) throw new BoxServiceError(res.error.code, res.error.message, res.error.status);
  return res.data;
}

// ─────────────────────────── 面板控制器 ───────────────────────────

export interface PanelViewState {
  expanded: boolean;
  setExpanded: (v: boolean) => void;
  /** 放大预览中的图片 key */
  previewKey: string | null;
  setPreviewKey: (k: string | null) => void;
  /** 超限拦截弹层 */
  overLimitOpen: boolean;
  setOverLimitOpen: (v: boolean) => void;
  /** 取消确认弹层 */
  cancelOpen: boolean;
  setCancelOpen: (v: boolean) => void;
  /** 当前菜单打开的 cell key（单例：同一时刻只存在一个菜单） */
  menuKey: string | null;
  setMenuKey: (k: string | null) => void;
  page: number;
  setPage: (p: number) => void;
  /** 令牌缺失时的输入值 */
  tokenInput: string;
  setTokenInput: (v: string) => void;
  tokenDialogOpen: boolean;
  setTokenDialogOpen: (v: boolean) => void;
  busy: boolean;
  /** 全选/刷新等动作的最近一次提示 */
  notice: string | null;
  setNotice: (v: string | null) => void;
}

export interface PanelController extends PanelViewState {
  /** 全部抓取到的图片（按阅读顺序） */
  allImages: PageImage[];
  /** 当前页的 20 张 */
  pageImages: PageImage[];
  totalPages: number;
  onRescan: () => Promise<void>;
  onToggleSelect: (key: string) => void;
  onSelectAllPage: () => void;
  onClearSelection: () => void;
  onSubmit: () => Promise<void>;
  onOverLimitAction: (id: OverLimitActionId) => Promise<void>;
  onConfirmCancel: () => Promise<void>;
  onRevealDir: () => Promise<void>;
  onRetryFailed: () => Promise<void>;
  onContinueNextBatch: () => void;
  onSaveToken: () => Promise<void>;
  onRetryService: () => Promise<void>;
  onLocate: (key: string) => void;
}

/**
 * 面板控制器：全部副作用的唯一入口。
 *
 * `mirror` 由组件从 Redux 选择器传入（已选集合、失败项集合）—— 控制器不直接读
 * store，保证「什么算已选」只有一处定义（`selectionSlice` 的选择器）。
 */
export function usePanelController(
  dispatch: Dispatch<UnknownAction>,
  mirror: {
    selectedKeys: string[];
    failedSeqs: number[];
    /** 当前客户端状态 —— 看门狗据此判断「是否还需要盯事件流」 */
    clientState: ClientState;
    /** 服务端最后一次事件的 id —— P0-3 重连时作为 `Last-Event-ID` 上送 */
    lastEventId: string | null;
    /** 事件流当前是否连着（background 的 `onOpen`/`onError` 推送） */
    eventsConnected: boolean;
    /** 漫画名 —— 提交守卫的唯一数据源（与按钮 disabled 判断同源，见 comicNameRef 注释） */
    comicName: string;
  },
): PanelController {
  const [expanded, setExpanded] = useState(true);
  const [previewKey, setPreviewKey] = useState<string | null>(null);
  const [overLimitOpen, setOverLimitOpen] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const [menuKey, setMenuKey] = useState<string | null>(null);
  const [page, setPage] = useState(1);
  const [tokenInput, setTokenInput] = useState('');
  const [tokenDialogOpen, setTokenDialogOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);

  /** `mirror` 的最新值 —— 看门狗跑在 interval 里，不能捕获渲染时的旧值 */
  const mirrorRef = useRef(mirror);
  useEffect(() => {
    mirrorRef.current = mirror;
  });

  /** 当前任务上下文 —— 放 ref 里，避免闭包捕获旧值 */
  const ctx = useRef<{
    taskId: string | null;
    comicName: string;
    /** seq → { key, expectedUrl } —— 回写与定位都靠它 */
    plan: Map<number, { key: string; expectedUrl: string }>;
    /** 已提交但尚未追加的后续批次 */
    pendingBatches: Array<Array<{ seq: number; key: string }>>;
  }>({ taskId: null, comicName: '', plan: new Map(), pendingBatches: [] });

  const allImages = useMemo(() => registry.all(), [revision]);
  const pageImages = useMemo(
    () => allImages.slice((page - 1) * GRID.perPage, page * GRID.perPage),
    [allImages, page],
  );
  const totalPages = Math.max(1, Math.ceil(allImages.length / GRID.perPage));

  // ── 启动：探测服务 + 恢复进行中任务（P0-3） ──
  useEffect(() => {
    void (async () => {
      try {
        const data = await sendBg<{ ready: boolean; port: number | null; hasToken: boolean }>({
          type: 'SERVICE_DISCOVER',
        });
        dispatch(
          batchActions.serviceDiscovered({ port: data.port ?? 0, hasToken: data.hasToken, ready: data.ready && data.hasToken }),
        );
        if (!data.hasToken) setTokenDialogOpen(true);
      } catch {
        dispatch(batchActions.serviceLost());
      }

      // P0-3：taskId 与页面生命周期解绑 —— 刷新后依然能把任务接回来
      try {
        const rec = await sendBg<{ taskId: string; comicName: string } | null>({ type: 'ACTIVE_TASK_GET' });
        if (!rec) return;
        const task = await sendBg<TaskDto>({ type: 'TASK_REFRESH', taskId: rec.taskId });
        ctx.current.taskId = rec.taskId;
        ctx.current.comicName = task.normalizedComicName ?? rec.comicName;
        dispatch(batchActions.taskSnapshot(task));
        if (task.items) dispatch(itemActions.itemsReplaced(task.items));
        await sendBg({ type: 'TASK_WATCH_START', taskId: rec.taskId, lastEventId: null });
      } catch {
        // 服务不在或任务已失效 —— 清理引用，不打扰用户
        void sendBg({ type: 'ACTIVE_TASK_CLEAR' }).catch(() => undefined);
      }
    })();
  }, [dispatch]);

  /** 事件流活性 —— 最后一次收到任何推送（**含心跳**）的时刻 */
  const lastPushAtRef = useRef<number>(0);

  // ── 事件流推送 → store（含回写） ──
  useEffect(() => {
    const onMessage = (msg: unknown): undefined => {
      if (!msg || typeof msg !== 'object') return undefined;
      const push = msg as BgPush;
      // 连上了或者断了的推送都算「有活性」—— 断连推送本身说明 SW 还活着
      lastPushAtRef.current = Date.now();
      if (push.type === 'TASK_EVENT_STATE') {
        dispatch(batchActions.eventsConnectedSet(push.connected));
        return undefined;
      }
      if (push.type !== 'TASK_EVENT') return undefined;
      dispatch(batchActions.lastEventIdSet(push.envelope.id));
      void applyEnvelope(push.envelope);
      return undefined;
    };
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  async function applyEnvelope(envelope: SseEnvelope): Promise<void> {
    const data = envelope.data as Record<string, unknown> | null;
    if (!data) return;
    switch (envelope.event) {
      case 'task.status': {
        const status = data.status as TaskDto['status'];
        const queuePosition = Number(data.queuePosition ?? 0);
        dispatch(batchActions.taskStatusEvent({ status, queuePosition }));
        if (status === 'done' || status === 'partial_failed' || status === 'failed') {
          // 终态：拉一次全量，拿齐 items 与 progress（数字全部来自服务端）
          await refreshTask();
        }
        break;
      }
      case 'batch.status': {
        dispatch(
          batchActions.batchStatusEvent({
            batchIndex: Number(data.batchIndex),
            status: data.status as TaskDto['status'],
            seqFrom: Number(data.seqFrom),
            seqTo: Number(data.seqTo),
            count: Number(data.seqTo) - Number(data.seqFrom) + 1,
          }),
        );
        break;
      }
      case 'item.status': {
        const item: ItemDto = {
          seq: Number(data.seq),
          status: data.status as ItemDto['status'],
          saved: data.saved as boolean | undefined,
          outputFile: data.outputFile as string | undefined,
          durationMs: data.durationMs as number | undefined,
        };
        dispatch(itemActions.itemStatusEvent(item));
        if (item.status === 'success') void writeOne(item);
        break;
      }
      case 'heartbeat':
      default:
        break;
    }
  }

  /** 取任务全量（progress / items / eta 全部来自服务端） */
  const refreshTask = useCallback(async () => {
    const taskId = ctx.current.taskId;
    if (!taskId) return;
    try {
      const task = await sendBg<TaskDto>({ type: 'TASK_REFRESH', taskId });
      dispatch(batchActions.taskSnapshot(task));
      if (task.items) {
        dispatch(itemActions.itemsReplaced(task.items));
        dispatch(batchActions.failedSeqsFromItems(task.items));
      }
      if (task.progress) dispatch(batchActions.progressSet(task.progress));
      // 终态后刷新队列，位次与 eta 只认服务端
      const q = await sendBg<QueueDto>({ type: 'QUEUE_REFRESH', taskId });
      dispatch(batchActions.queueSnapshot(toQueuePatch(q, taskId)));
    } catch (err) {
      const e = err as BoxServiceError;
      dispatch(batchActions.inlineError(e.message));
    }
  }, [dispatch]);

  /**
   * **P0-3 事件流看门狗** —— 契约要求「`taskId` 与页面生命周期解绑，按 `Last-Event-ID` 重连」。
   *
   * 为什么必须有它：事件流的持有者是 background 的 **MV3 service worker**，
   * 而 `rt.streams` 是 SW 的内存态。SW 被回收（空闲约 30s、或 Chrome 的硬性上限）后
   * 流就没了，而且**不会再有任何 `onError`** —— 死掉的 SW 无法通知任何人。
   * 此时面板的唯一表征是「事件不再到达」，所以只能靠**静默超时**来判定。
   *
   * 为什么驱动器是面板而不是 SW：流的唯一消费者是面板（SW 只是 `pushToTab` 中转）。
   * content script 与页面同寿命、远长于 SW；由它检测并通过 `runtime.sendMessage`
   * 重新订阅，这个动作本身就会**唤醒 SW**。让 SW 自己重启订阅没有用户可感知的收益，
   * 反而要为「给可能已关闭的 tab 续流」付出复杂度。
   *
   * 为什么用 `lastEventId` 续而**不**从 0 重放：同一页面上已回写的图，其 DOM 里的
   * `src` 已被换成 `blob:`。若从 0 重放，旧的 `item.status: success` 会再次触发
   * 回写，而 P0-1 校验看到 `currentSrc !== expectedUrl` 会把它们误标成
   * 「原图已离开页面」。按 id 续传天然跳过这些已经处理过的事件。
   *
   * 反过来说，**页面刷新**必须从 0 重放（`lastEventId: null`，见启动 effect）：
   * 刷新后 DOM 回到原图，需要重新回写一遍。这也是这里刻意**不**把 `lastEventId`
   * 持久化进 storage 的原因 —— 持久化会让刷新后的重放被跳过，回写就丢了。
   */
  useEffect(() => {
    const timer = window.setInterval(() => {
      const taskId = ctx.current.taskId;
      if (!taskId) return;
      // 终态不再需要事件流；只在 queued / running 期间盯着
      if (!isActive(mirrorRef.current.clientState)) return;

      const staleMs = Date.now() - lastPushAtRef.current;
      // 已知断连（SW 明确报了 connected:false）→ 立刻重订阅，不等静默超时。
      // 这是 `eventsConnected` 唯一的消费点：否则它只是一个死信号。
      const knownDown = mirrorRef.current.eventsConnected === false;
      if (!knownDown && staleMs < SSE_STALE_MS) return;

      lastPushAtRef.current = Date.now(); // 重置，避免每一 tick 都重发
      void (async () => {
        try {
          await sendBg({
            type: 'TASK_WATCH_START',
            taskId,
            lastEventId: mirrorRef.current.lastEventId,
          });
          // 重连后拉一次全量对账：断连窗口里的终态/失败项不会被漏掉
          await refreshTask();
        } catch {
          // 服务不可达 —— 下一 tick 再试（保持 20s 节奏，不做激进重试）
        }
      })();
    }, SSE_WATCHDOG_TICK_MS);
    return () => window.clearInterval(timer);
  }, [refreshTask]);

  /**
   * 单张回写 —— **P0-1**。
   *
   * 三步：① 从注册表按 key 取元素；② 过 `canWriteBack`（`isConnected` 且
   * `currentSrc === expectedUrl`）；③ 不通过则只做标记，绝不「就近找个 img 写进去」。
   */
  const writeOne = useCallback(
    async (item: ItemDto) => {
      const plan = ctx.current.plan.get(item.seq);
      const comicName = ctx.current.comicName;
      if (!plan || !comicName) return;
      try {
        const { dataUrl } = await sendBg<{ dataUrl: string }>({
          type: 'IMAGE_LOAD_DATA_URL',
          comicName,
          seq: item.seq,
          variant: 'translated',
        });
        const blob = await (await fetch(dataUrl)).blob();
        const element = registry.elementOf(plan.key) ?? null;
        const res = writeBackImage(item.seq, element, plan.expectedUrl, blob);
        if (res.ok) {
          dispatch(itemActions.writtenBack(item.seq));
        } else {
          // P0-1：跳过并标记，不写错图
          dispatch(itemActions.markedLeftPage([item.seq]));
          dispatch(batchActions.leftPageMarked([item.seq]));
        }
      } catch (err) {
        const e = err as BoxServiceError;
        dispatch(batchActions.inlineError(`第 ${item.seq} 张回写失败：${e.message}`));
      }
    },
    [dispatch],
  );

  // ── 路由变更 → P0-2 清空判据 ──
  /** 永远指向最新值的镜像 —— 路由回调与异步回调都在闭包外，靠它取当前值 */
  const selectedKeysRef = useRef<string[]>(mirror.selectedKeys);
  selectedKeysRef.current = mirror.selectedKeys;
  const failedSeqsRef = useRef<number[]>(mirror.failedSeqs);
  failedSeqsRef.current = mirror.failedSeqs;
  /**
   * 漫画名的镜像。
   *
   * **缺陷修复记录**：此前 onSubmit 读的是 `ctx.current.comicName`，而该字段只在
   * doSubmit 成功路径里才被赋值 —— 用户填了名字也永远过不了提交守卫（首次提交
   * 必被「请填写漫画名」拦下）。根因是两个数据源不一致：按钮 disabled 判断读
   * Redux（有值 → 可点），提交守卫读 ctx（空 → 拦截）。现在统一走 mirror，
   * 与 selectedKeys 同一模式。
   */
  const comicNameRef = useRef<string>(mirror.comicName);
  comicNameRef.current = mirror.comicName;
  useEffect(() => {
    const dispose = installRouteWatcher((info) => {
      const selected = selectedKeysRef.current;
      const leftDom = countLeftDom(
        selected.map((k) => ({ isConnected: !!registry.elementOf(k)?.isConnected })),
      );
      /**
       * **P0-2 清空判据**：`URL 变化` **或** `>60% 已选图已离开 DOM`，两条件取**或**。
       *
       * 关键在于 `urlChanged` 只对 **SPA 真改 URL**（`info.kind === 'spa'`）为真：
       * 无限滚动（类型 ③）URL 根本不变，若把任何 DOM 变动都当成「URL 变了」，
       * 就退化成「一有新增就清空」，把用户刚勾好的选择误清掉。
       * 类型 ③ 的正确通道是第二条分支（>60% 离开 DOM）—— 那才是「这一话已经翻过去了」
       * 的真实信号。
       */
      const verdict = shouldClearSelection({
        urlChanged: info.kind === 'spa',
        selectedCount: selected.length,
        leftDomCount: leftDom,
      });
      if (!verdict.clear) return;
      // 裁定（《01》§6.4 口径冲突修正）：**不停当前任务**，只清空尚未提交的已选集
      dispatch(selectionActions.autoCleared({ reason: verdict.reason as 'url-changed' | 'left-dom' }));
      setNotice(`页面已变更（${info.kind === 'infinite-scroll' ? '内容续载' : 'URL 变更'}），已清空未提交的选择`);
      void onRescan();
    });
    return dispose;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  // ── 抓图 ──
  const onRescan = useCallback(async () => {
    const list = await collectOrderedImages(document);
    registry.replace(list, GRID.perPage);
    const pageMap: Record<string, number> = {};
    for (const img of list) pageMap[img.key] = registry.pageOfKey(img.key);
    dispatch(selectionActions.pageMapUpdated(pageMap));
    setRevision((r) => r + 1);
    setNotice(`已扫描到 ${list.length} 张图片`);
  }, [dispatch]);

  useEffect(() => {
    void onRescan();
  }, [onRescan]);

  // ── 选择 ──
  const onToggleSelect = useCallback(
    (key: string) => {
      dispatch(selectionActions.toggled({ key, page: registry.pageOfKey(key) }));
      setRevision((r) => r + 1);
    },
    [dispatch],
  );

  const onSelectAllPage = useCallback(() => {
    dispatch(
      selectionActions.selectedMany({
        items: pageImages.map((img) => ({ key: img.key, page: registry.pageOfKey(img.key) })),
      }),
    );
    setRevision((r) => r + 1);
  }, [dispatch, pageImages]);

  const onClearSelection = useCallback(() => {
    dispatch(selectionActions.cleared());
    setRevision((r) => r + 1);
  }, [dispatch]);

  // ── 提交 ──
  const onSubmit = useCallback(async () => {
    const keys = selectedKeysRef.current;
    const comicName = comicNameRef.current;
    const check = checkComicName(comicName);
    const decision = decideSubmit({ selectedCount: keys.length, comicNameOk: check.ok });
    if (decision.kind === 'block') {
      // 超限 → 拦截且**不发网络请求**，给出两个动作（《01》§5.1）
      if (decision.reason === 'over-limit') setOverLimitOpen(true);
      else setNotice(decision.message);
      return;
    }
    await doSubmit(keys, comicName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatch]);

  /** 真正的提交：抓字节 → 按阅读顺序切批 → 第一批 POST /tasks → 其余 append 到**同一任务** */
  const doSubmit = useCallback(
    async (keys: string[], comicName: string) => {
      if (!checkComicName(comicName).ok) {
        setNotice('请填写漫画名');
        return;
      }
      setBusy(true);
      setNotice(null);
      const idempotencyKey = uuidV4();
      dispatch(batchActions.submitStarted({ idempotencyKey, comicName }));
      try {
        // ① 阅读顺序全局排序（不是勾选顺序 —— 《03》§7.3）
        const ordered = sortByReadingOrder(
          keys
            .map((k) => registry.get(k))
            .filter((x): x is PageImage => !!x)
            .map((img) => ({ img, top: img.position.top, left: img.position.left })),
        ).map((x) => x.img);

        // ② 分配 seq 并登记回写计划（P0-1 的 expectedUrl 在此固化）
        ctx.current.plan = new Map();
        ctx.current.comicName = comicName;
        const withSeq = ordered.map((img, i) => {
          const seq = i + 1;
          ctx.current.plan.set(seq, { key: img.key, expectedUrl: img.expectedUrl });
          return { seq, key: img.key, url: img.fetchUrl, contentType: 'image/png' };
        });
        dispatch(itemActions.reset());
        dispatch(itemActions.itemsSeed(withSeq.map((x) => x.seq)));

        // ③ 抓字节（跨域抓图只能在 background 做）
        const fetched = await sendBg<{ ready: number[]; failed: Array<{ seq: number; reason: string }> }>({
          type: 'IMAGES_FETCH',
          items: withSeq,
        });
        if (fetched.failed.length > 0) {
          dispatch(
            batchActions.inlineError(
              `${fetched.failed.length} 张原图抓取失败（可能受防盗链限制）：第 ${fetched.failed
                .map((f) => f.seq)
                .join('、')} 张`,
            ),
          );
        }
        const usable = withSeq.filter((x) => fetched.ready.includes(x.seq));
        if (usable.length === 0) throw BoxServiceError.network('没有可提交的图片');

        // ④ 分批切分：前 20 → POST /tasks；其余 → 追加到**同一任务**
        const batches = splitIntoBatches(usable, 20);
        const first = batches[0]!;
        const created = await sendBg<TaskCreatedDto>({
          type: 'TASK_SUBMIT',
          comicName,
          idempotencyKey,
          clientTaskRef: `ext-${idempotencyKey.slice(0, 8)}`,
          items: first.map((x) => ({ seq: x.seq, key: x.key })),
        });
        ctx.current.taskId = created.taskId;
        dispatch(batchActions.taskCreated(created));

        for (let i = 1; i < batches.length; i += 1) {
          const b = batches[i]!;
          try {
            const task = await sendBg<TaskDto>({
              type: 'TASK_APPEND_BATCH',
              taskId: created.taskId,
              // 每批独立幂等键：批次是不同请求，共用一个键会让服务端把第 2 批判成重放
              idempotencyKey: uuidV4(),
              items: b.map((x) => ({ seq: x.seq, key: x.key })),
            });
            dispatch(batchActions.taskSnapshot(task));
          } catch (err) {
            // 《03》§5.3 边界：追加失败时给出「剩余 N 张待提交」而不是整体报错
            const e = err as BoxServiceError;
            const remaining = batches.slice(i).reduce((n, x) => n + x.length, 0);
            dispatch(batchActions.pendingRemainingSet(remaining));
            dispatch(batchActions.inlineError(`后续批次提交失败：${e.message}`));
            break;
          }
        }

        await sendBg({ type: 'TASK_WATCH_START', taskId: created.taskId, lastEventId: null });
      } catch (err) {
        const e = err instanceof BoxServiceError ? err : BoxServiceError.network(String(err));
        dispatch(batchActions.submitFailed({ code: e.code, message: e.message, at: Date.now() }));
      } finally {
        setBusy(false);
      }
    },
    [dispatch],
  );

  const onOverLimitAction = useCallback(
    async (id: OverLimitActionId) => {
      setOverLimitOpen(false);
      const keys = selectedKeysRef.current;
      if (id === 'trim') {
        dispatch(selectionActions.keptFirst(20));
        setRevision((r) => r + 1);
        setNotice('已保留阅读顺序最靠前的 20 张');
        return;
      }
      await doSubmit(keys, ctx.current.comicName);
    },
    [dispatch, doSubmit],
  );

  // ── 取消 ──
  const onConfirmCancel = useCallback(async () => {
    setCancelOpen(false);
    const taskId = ctx.current.taskId;
    if (!taskId) return;
    try {
      const res = await sendBg<{ keptItems: number; outputDir?: string }>({ type: 'TASK_CANCEL', taskId });
      dispatch(batchActions.cancelSucceeded(res));
      await sendBg({ type: 'TASK_WATCH_STOP', taskId }).catch(() => undefined);
    } catch (err) {
      const e = err as BoxServiceError;
      dispatch(batchActions.inlineError(e.message));
    }
  }, [dispatch]);

  // ── 打开目录 / 重试失败项 / 继续翻一批 ──
  const onRevealDir = useCallback(async () => {
    const comicName = ctx.current.comicName;
    if (!comicName) return;
    try {
      await sendBg({ type: 'LIBRARY_REVEAL', comicName });
    } catch (err) {
      dispatch(batchActions.inlineError((err as BoxServiceError).message));
    }
  }, [dispatch]);

  /**
   * 「重试失败项」—— **只重试失败项**（《01》§7 的 partial_failed 行）。
   *
   * 契约里没有「重试单个 item」的端点（《03》§5 的 10 个端点中不存在），因此
   * 实现为：把失败项取出，作为**新任务**提交（comicName 复用 → 服务端续编号）。
   * 这与《01》§7「failed 的重试 = 新建任务」同源；对 partial_failed 则是
   * 「只把失败的那几张作为新任务」。
   */
  const onRetryFailed = useCallback(async () => {
    const plan = ctx.current.plan;
    const failedKeys: string[] = [];
    for (const [seq, entry] of plan) {
      if (failedSeqsRef.current.includes(seq)) failedKeys.push(entry.key);
    }
    if (failedKeys.length === 0) {
      setNotice('没有可重试的失败项');
      return;
    }
    await doSubmit(failedKeys, ctx.current.comicName);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doSubmit]);

  const onContinueNextBatch = useCallback(() => {
    dispatch(batchActions.continueNextBatch());
    dispatch(selectionActions.cleared());
    dispatch(itemActions.reset());
    void onRescan();
  }, [dispatch, onRescan]);

  // ── 令牌 ──
  const onSaveToken = useCallback(async () => {
    if (tokenInput.trim().length === 0) return;
    await sendBg({ type: 'TOKEN_SAVE', token: tokenInput.trim() });
    setTokenDialogOpen(false);
    await onRetryService();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tokenInput]);

  const onRetryService = useCallback(async () => {
    try {
      const data = await sendBg<{ ready: boolean; port: number | null; hasToken: boolean }>({
        type: 'SERVICE_DISCOVER',
      });
      dispatch(
        batchActions.serviceDiscovered({
          port: data.port ?? 0,
          hasToken: data.hasToken,
          ready: data.ready && data.hasToken,
        }),
      );
    } catch {
      dispatch(batchActions.serviceLost());
    }
  }, [dispatch]);

  // ── 定位图片 ──
  const onLocate = useCallback((key: string) => {
    const el = registry.elementOf(key);
    if (!el || !el.isConnected) {
      // 判据同 P0-1 的 img.isConnected（《01》§6.3）
      setNotice('原图已离开当前页面');
      return;
    }
    locateImage(el);
  }, []);

  return {
    expanded,
    setExpanded,
    previewKey,
    setPreviewKey,
    overLimitOpen,
    setOverLimitOpen,
    cancelOpen,
    setCancelOpen,
    menuKey,
    setMenuKey,
    page,
    setPage,
    tokenInput,
    setTokenInput,
    tokenDialogOpen,
    setTokenDialogOpen,
    busy,
    notice,
    setNotice,
    allImages,
    pageImages,
    totalPages,
    onRescan,
    onToggleSelect,
    onSelectAllPage,
    onClearSelection,
    onSubmit,
    onOverLimitAction,
    onConfirmCancel,
    onRevealDir,
    onRetryFailed,
    onContinueNextBatch,
    onSaveToken,
    onRetryService,
    onLocate,
  };
}
