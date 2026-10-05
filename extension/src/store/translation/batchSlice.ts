/**
 * 全局批次状态机 —— 对应《01》§8 的 `batchSlice.ts`。
 *
 * 只存**可序列化**的批次级状态；单图状态在 `itemSlice`，不可序列化的对象在
 * `registry`。批次级状态里所有数字（queuePosition / eta / progress）**一律是
 * 服务端字段的透传**，本文件不做任何计算（《03》§5.7 客户端禁令）。
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type {
  BatchDto,
  EnginePreparingState,
  ItemDto,
  ProgressDto,
  TaskDto,
  TaskStatus,
} from '../../types/contract';
import { clientStateFromTaskStatus, type ClientState, type ServicePhase } from '../../domain/clientState';

export interface BatchErrorInfo {
  code: string;
  message: string;
  at: number;
}

export interface BatchState {
  /** 客户端 8 态（《03》§4.3） */
  state: ClientState;
  /** 服务未就绪是**渲染条件**，不是状态机的一个态（详见 domain/clientState.ts 头注释） */
  serviceReady: boolean;
  /**
   * 服务就绪阶段（ver2.0 起由布尔扩为三值）—— 浮层按它分流两态（《01》§4.4 判据）：
   * `absent` = 进程不在（给「启动 Box」）；`preparing` = 进程在但引擎未就绪（只给等待/重试）。
   * 与 `serviceReady` 并存的理由：`serviceReady` 表达的是「服务可达且已配对」（进程维度），
   * `preparing` 时进程仍在、`serviceReady` 保持 true，但引擎不可用 —— 两者不可互推。
   */
  servicePhase: ServicePhase;
  /**
   * 「准备中」的阶段（`details.sidecar.state`）—— 只用于浮层**副行**文案
   * （《01》§4.1：`prewarming`→「正在预热」，`starting`/`downloading`→「正在准备翻译模型」）。
   * `null` = 服务端没给 / 取值不在白名单 → **不猜阶段**，副行留空。
   */
  enginePreparingState: EnginePreparingState | null;
  servicePort: number | null;
  /** 已配对的令牌是否存在（缺失 → 引导配对） */
  hasToken: boolean;

  taskId: string | null;
  comicName: string;
  /** 服务端回传的规范化结果 —— 有值时，落盘路径预览一律用它（《03》§5.2） */
  normalizedComicName: string | null;
  outputDir: string | null;

  /** 服务端字段透传：排队位次（1 = 下一个执行） */
  queuePosition: number | null;
  /** 服务端字段透传：eta 文案；null = 服务端不确定 → UI 不显示任何数字 */
  etaText: string | null;
  progress: ProgressDto | null;
  batches: BatchDto[];
  /** 终态保留量（canceled 时有意义） */
  keptItems: number | null;

  /**
   * 追加批次失败时剩余待提交张数。
   * 依据《03》§5.3 边界：B2 最终失败时展示「本批已完成 20 张 · 剩余 11 张待提交」。
   */
  pendingRemaining: number;

  /** 本次任务的幂等键 —— 重试必须复用它，否则会产生重复批次 */
  idempotencyKey: string | null;
  /** 失败项的 seq 列表（partial_failed 时「重试失败项」只重试这些） */
  failedSeqs: number[];
  leftPageSeqs: number[];

  error: BatchErrorInfo | null;
  /** 事件流是否已连接（P0-3 的可观测指标） */
  eventsConnected: boolean;
  /** 最近一次收到的事件 id —— 断线重连时作为 Last-Event-ID（P0-3） */
  lastEventId: string | null;
}

const initialState: BatchState = {
  state: 'idle',
  serviceReady: false,
  servicePhase: 'absent',
  enginePreparingState: null,
  servicePort: null,
  hasToken: false,
  taskId: null,
  comicName: '',
  normalizedComicName: null,
  outputDir: null,
  queuePosition: null,
  etaText: null,
  progress: null,
  batches: [],
  keptItems: null,
  pendingRemaining: 0,
  idempotencyKey: null,
  failedSeqs: [],
  leftPageSeqs: [],
  error: null,
  eventsConnected: false,
  lastEventId: null,
};

/** 供测试与「刷新恢复」构造 preloadedState（不导出 reducer 内部结构） */
export const batchInitialState: BatchState = initialState;

const slice = createSlice({
  name: 'batch',
  initialState,
  reducers: {
    serviceDiscovered(
      s,
      a: PayloadAction<{ port: number; hasToken: boolean; ready: boolean }>,
    ) {
      s.servicePort = a.payload.port;
      s.hasToken = a.payload.hasToken;
      s.serviceReady = a.payload.ready;
      // 探测命中且已就绪（进程在 + 已配对）→ 清空浮层；否则沿 ver1.0 行为渲染
      // 「服务未就绪」浮层（未配对时另弹配对引导）。这里**不**推测「进程在但引擎未就绪」——
      // 插件按 §5.1 不读 sidecar 字段，「准备中」只由 503 ENGINE_NOT_READY 触发（§4.1）。
      s.servicePhase = a.payload.ready ? 'ready' : 'absent';
      s.enginePreparingState = null;
    },
    serviceLost(s) {
      s.serviceReady = false;
      // 端口探测全段未命中 = 进程不在（《01》§4.4 判据）→ 「服务未就绪」
      s.servicePhase = 'absent';
      s.enginePreparingState = null;
    },
    /**
     * 引擎在途未就绪（《03》§2.3 `ENGINE_NOT_READY`）。
     *
     * 「不排队、不缓存」（契约客户端处理列）→ **不建单**，因此任务状态回到可选图态
     * （「确定」再次可点），只把渲染阶段切到「准备中」。`serviceReady` 保持原值 ——
     * 进程仍在，这不是「服务未运行」。
     *
     * `state` 来自 `details.sidecar.state`（取不到为 null）—— 只影响副行，不影响切态。
     */
    enginePreparing(s, a: PayloadAction<{ state: EnginePreparingState | null }>) {
      s.servicePhase = 'preparing';
      s.enginePreparingState = a.payload.state;
      s.state = 'idle';
      s.error = null;
    },
    tokenSaved(s, a: PayloadAction<boolean>) {
      s.hasToken = a.payload;
    },

    comicNameChanged(s, a: PayloadAction<string>) {
      s.comicName = a.payload;
    },

    submitStarted(s, a: PayloadAction<{ idempotencyKey: string; comicName: string }>) {
      s.state = 'submitting';
      s.error = null;
      s.idempotencyKey = a.payload.idempotencyKey;
      s.comicName = a.payload.comicName;
      s.pendingRemaining = 0;
      s.failedSeqs = [];
      s.leftPageSeqs = [];
    },

    /**
     * 建单成功（201 或幂等的 200）。
     * 全部数字字段原样来自响应，不做任何派生计算。
     */
    taskCreated(s, a: PayloadAction<TaskDto>) {
      const t = a.payload;
      // 建单成功 = 引擎已接收任务（拿到了 taskId / 序号）→ 「准备中」浮层必须解除。
      // 否则用户在引擎转好后重试提交，浮层（inset:0 / z-index:30）会一直盖住运行中的面板。
      s.servicePhase = 'ready';
      s.enginePreparingState = null;
      s.taskId = t.taskId;
      s.normalizedComicName = t.normalizedComicName ?? null;
      s.outputDir = t.outputDir ?? null;
      s.queuePosition = t.queuePosition ?? null;
      s.etaText = t.eta?.text ?? null;
      s.batches = t.batches ?? [];
      s.progress = t.progress ?? null;
      s.state = clientStateFromTaskStatus(t.status);
    },

    /** 全量快照（`GET /tasks/{id}`）—— 用于刷新页面后的恢复（P0-3） */
    taskSnapshot(s, a: PayloadAction<TaskDto>) {
      const t = a.payload;
      s.state = clientStateFromTaskStatus(t.status);
      s.normalizedComicName = t.normalizedComicName ?? s.normalizedComicName;
      s.outputDir = t.outputDir ?? s.outputDir;
      if (t.queuePosition != null) s.queuePosition = t.queuePosition;
      if (t.eta !== undefined) s.etaText = t.eta?.text ?? null;
      if (t.batches) s.batches = t.batches;
      if (t.progress) s.progress = t.progress;
    },

    /** `task.status` 事件 */
    taskStatusEvent(
      s,
      a: PayloadAction<{ status: TaskStatus; queuePosition: number }>,
    ) {
      s.state = clientStateFromTaskStatus(a.payload.status);
      // queuePosition 为 0 表示已在执行（不再排队）—— 保留 0 而不清空，UI 据此不显示「第 0 位」
      s.queuePosition = a.payload.queuePosition;
    },

    /** `batch.status` 事件 */
    batchStatusEvent(s, a: PayloadAction<BatchDto>) {
      const idx = s.batches.findIndex((b) => b.batchIndex === a.payload.batchIndex);
      if (idx >= 0) s.batches[idx] = a.payload;
      else s.batches.push(a.payload);
    },

    /**
     * 从 items 里**筛出失败项**，供「重试失败项」精确定位。
     *
     * 刻意**不**在这里派生 `progress`：进度条上的 `18 / 20 · 2 张失败` 必须直接读
     * 服务端的 `progress` 字段（《03》§5.7 客户端禁令 —— 屏幕上出现的任何阿拉伯
     * 数字，其值必须来自服务端响应字段）。筛失败项是「选择」，不是「计算指标」。
     */
    failedSeqsFromItems(s, a: PayloadAction<ItemDto[]>) {
      s.failedSeqs = a.payload.filter((i) => i.status === 'failed').map((i) => i.seq);
    },

    /** 服务端 `progress` 透传 */
    progressSet(s, a: PayloadAction<ProgressDto>) {
      s.progress = a.payload;
    },

    /** 服务端 eta / 位次的刷新（来自 `GET /queue`，唯一来源） */
    queueSnapshot(
      s,
      a: PayloadAction<{ position: number | null; etaText: string | null }>,
    ) {
      s.queuePosition = a.payload.position;
      s.etaText = a.payload.etaText;
    },

    /** 追加批次失败后的剩余量（《03》§5.3 边界） */
    pendingRemainingSet(s, a: PayloadAction<number>) {
      s.pendingRemaining = a.payload;
    },

    submitFailed(s, a: PayloadAction<BatchErrorInfo>) {
      s.state = 'failed';
      s.error = a.payload;
    },

    /** 非致命错误（内联提示用，不切状态） */
    inlineError(s, a: PayloadAction<string | null>) {
      s.error = a.payload ? { code: 'INLINE', message: a.payload, at: Date.now() } : null;
    },

    cancelSucceeded(s, a: PayloadAction<{ keptItems: number; outputDir?: string }>) {
      s.state = 'canceled';
      s.keptItems = a.payload.keptItems;
      if (a.payload.outputDir) s.outputDir = a.payload.outputDir;
    },

    eventsConnectedSet(s, a: PayloadAction<boolean>) {
      s.eventsConnected = a.payload;
    },
    lastEventIdSet(s, a: PayloadAction<string | null>) {
      s.lastEventId = a.payload;
    },

    /** 标记某些张的「原图已离开当前页面」（P0-1 跳过回写时） */
    leftPageMarked(s, a: PayloadAction<number[]>) {
      const set = new Set(s.leftPageSeqs);
      for (const seq of a.payload) set.add(seq);
      s.leftPageSeqs = [...set].sort((x, y) => x - y);
    },

    /** 「继续翻一批」：复用同一漫画名续编号，其余回 idle */
    continueNextBatch(s) {
      s.state = 'idle';
      s.taskId = null;
      s.progress = null;
      s.batches = [];
      s.etaText = null;
      s.queuePosition = null;
      s.keptItems = null;
      s.pendingRemaining = 0;
      s.failedSeqs = [];
      s.idempotencyKey = null;
      s.error = null;
      // comicName 与 normalizedComicName 刻意保留 —— 「复用同一漫画名续编号」
    },

    /** 回到选图态（结果态后关闭 / 重新开始） */
    resetToIdle(s) {
      return {
        ...initialState,
        serviceReady: s.serviceReady,
        servicePhase: s.servicePhase,
        enginePreparingState: s.enginePreparingState,
        servicePort: s.servicePort,
        hasToken: s.hasToken,
      };
    },
  },
});

export const batchActions = slice.actions;
export const batchReducer = slice.reducer;
