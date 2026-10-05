/**
 * 客户端（插件）状态机 —— 8 态，严格对应《03》§4.3 与《01》§7。
 *
 * ```
 * idle → submitting → queued → running → done / partial_failed / canceled / failed
 * ```
 *
 * 注意：「服务未就绪」**不是**这 8 态之一（它在《03》§4.3 表里没有）。
 * 《01》§7 把它列在同一张表里，属于**渲染条件**而非状态机的态 ——
 * 因此这里独立建模为 `servicePhase`（ver2.0 起由 ver1.0 的布尔 `serviceReady`
 * 扩为 `ready/absent/preparing` 三值，仍**不进**转移图），避免把它混进转移图、
 * 造成「服务未就绪 → 提交」这类不存在的转移被写出来。
 * 《03》§4.5 同旨：「引擎的『准备/卸载/降档』都**不新增客户端状态机节点**」。
 */

import type { ApiErrorCode, TaskStatus } from '../types/contract';

/** 《03》§4.3：8 态 */
export const CLIENT_STATES = [
  'idle',
  'submitting',
  'queued',
  'running',
  'done',
  'partial_failed',
  'canceled',
  'failed',
] as const;

export type ClientState = (typeof CLIENT_STATES)[number];

/**
 * 服务端 Task 状态 → 客户端状态。
 *
 * `queued` 的判定需要额外信息：`POST /tasks` 返回 `status:"running"` 时说明任务
 * 已被立即调度（队首），此时客户端不进 `queued` 而直接进 `running`。
 * 这里以服务端 `status` 为准，`queuePosition > 0` 只用于渲染位次文案。
 */
export function clientStateFromTaskStatus(status: TaskStatus): ClientState {
  switch (status) {
    case 'queued':
      return 'queued';
    case 'running':
      return 'running';
    case 'done':
      return 'done';
    case 'partial_failed':
      return 'partial_failed';
    case 'failed':
      return 'failed';
    case 'canceled':
      return 'canceled';
    default:
      return 'idle';
  }
}

/** 是否为终态（终态下写操作一律被服务端拒绝，客户端应提前禁用） */
export function isTerminal(state: ClientState): boolean {
  return (
    state === 'done' ||
    state === 'partial_failed' ||
    state === 'canceled' ||
    state === 'failed'
  );
}

/** 任务是否仍在服务端队列/执行中 */
export function isActive(state: ClientState): boolean {
  return state === 'queued' || state === 'running';
}

export interface StateCapabilities {
  /** 能否改选（勾选/取消勾选） */
  select: boolean;
  /** 能否改漫画名 */
  comicName: boolean;
  /** 能否翻页浏览网格 */
  browse: boolean;
  /** 能否 hover 预览缩略图（《01》§7：running 期间「可滚动、可 hover 预览」） */
  hoverPreview: boolean;
  /** 取消动作形态：null = 不可取消 */
  cancelConfirm: 'once' | 'twice' | null;
  /** 「打开目录」是否可用（`queued` 置灰 —— 目录惰性创建，此时不存在） */
  openDir: boolean;
  /** 能否重试失败项 */
  retryFailed: boolean;
  /** 能否「继续翻一批」（复用同一漫画名续编号） */
  continueNextBatch: boolean;
  /** 能否导出 */
  export: boolean;
  /** 能否单图「定位图片」—— 《03》§4.4：任何面板状态都可点 */
  locateImage: boolean;
}

/**
 * 逐态能力表。值直接来自《03》§4.3 / §4.4 与《01》§7 的「可做 / 不可做」列。
 */
export const CAPABILITIES: Record<ClientState, StateCapabilities> = {
  idle: {
    select: true,
    comicName: true,
    browse: true,
    hoverPreview: true,
    cancelConfirm: null,
    openDir: false,
    retryFailed: false,
    continueNextBatch: false,
    export: false,
    locateImage: true,
  },
  submitting: {
    // 覆盖「上传与建单」两个子阶段，期间不允许重复确定，也不允许改内容
    select: false,
    comicName: false,
    browse: true,
    hoverPreview: true,
    cancelConfirm: null,
    openDir: false,
    retryFailed: false,
    continueNextBatch: false,
    export: false,
    locateImage: true,
  },
  queued: {
    // §4.4：可继续勾选更多图，但**不进入当前任务**，只是「下一批」候选集
    select: true,
    comicName: false,
    browse: true,
    hoverPreview: true,
    // §4.4「取消的确认规则」：queued 一次确认
    cancelConfirm: 'once',
    // §4.4：目录尚未创建（惰性创建）→ 置灰
    openDir: false,
    retryFailed: false,
    continueNextBatch: false,
    export: false,
    locateImage: true,
  },
  running: {
    // §4.4：不可改选、不可改漫画名；可滚动、可 hover 预览
    select: false,
    comicName: false,
    browse: true,
    hoverPreview: true,
    // §4.4：running 二次确认，文案必须包含「已翻译的 N 张会保留」
    cancelConfirm: 'twice',
    openDir: true,
    retryFailed: false,
    continueNextBatch: false,
    // §6.6：完成态工具条「去掉全选与清除」；导出在运行中不可用（落盘未完成）
    export: false,
    locateImage: true,
  },
  done: {
    select: false,
    comicName: false,
    browse: true,
    hoverPreview: true,
    cancelConfirm: null,
    openDir: true,
    retryFailed: false,
    continueNextBatch: true,
    export: true,
    locateImage: true,
  },
  partial_failed: {
    select: false,
    comicName: false,
    browse: true,
    hoverPreview: true,
    cancelConfirm: null,
    openDir: true,
    retryFailed: true,
    continueNextBatch: true,
    export: true,
    locateImage: true,
  },
  canceled: {
    select: false,
    comicName: false,
    browse: true,
    hoverPreview: true,
    cancelConfirm: null,
    // §5.6：已落盘内容保留 → 目录可能存在
    openDir: true,
    retryFailed: false,
    continueNextBatch: true,
    export: true,
    locateImage: true,
  },
  failed: {
    select: false,
    comicName: false,
    browse: true,
    hoverPreview: true,
    cancelConfirm: null,
    openDir: true,
    // §7：failed 的「重试 = 新建任务」，不是「重试失败项」
    retryFailed: false,
    continueNextBatch: true,
    export: false,
    locateImage: true,
  },
};

export function capabilitiesOf(state: ClientState): StateCapabilities {
  return CAPABILITIES[state];
}

// ─────────────────────── 文案（《01》§7 / §7.1 / §7.2 / §6.7） ───────────────────────

/**
 * 「N / M」型计数的结构化形态。
 *
 * 《01》§7.1：必须**拆两个文本节点** —— 数字 Inter Medium、中文 Noto Sans SC，
 * 避免 Inter 无中文字形导致的 fallback 与字重跳变。这里把结构定死在数据层，
 * 让 UI 不可能把它渲染成一个文本节点。
 */
export interface SplitCount {
  numeric: string;
  unit: string;
}

export function splitCount(n: number, total: number): SplitCount {
  return { numeric: `${n} / ${total}`, unit: ' 张' };
}

export interface HintRow {
  /** 提示行左侧是否显示 24×24 小魔法阵（《01》§6.2：`queued` / `running` 专用） */
  magicCircle: boolean;
  /** 魔法阵是否旋转（running 转圈） */
  spin: boolean;
  /** 结构化计数，供 UI 拆节点；无计数时为 null */
  count: SplitCount | null;
  /** 状态文字 —— 一律 `$3:4` ink，色相由状态点/图标承载（《01》§7.1） */
  text: string;
  /** 右侧动作 */
  action: 'cancel-queue' | 'cancel-task' | null;
}

/**
 * 提示行内容（《01》§6.2 提示行 48 高 + §7 各状态文案）。
 *
 * `queueText` / `etaText` **必须**是服务端给的字符串（《03》§5.7 客户端禁令），
 * 本函数不做任何拼接或估算，只做透传与占位。
 */
export function hintRowFor(input: {
  state: ClientState;
  done?: number;
  total?: number;
  queueText?: string | null;
  etaText?: string | null;
}): HintRow {
  switch (input.state) {
    case 'queued': {
      const bits = [input.queueText, input.etaText].filter(
        (x): x is string => typeof x === 'string' && x.length > 0,
      );
      return {
        magicCircle: true,
        spin: false,
        count: null,
        text: bits.length > 0 ? bits.join(' · ') : '排队中',
        action: 'cancel-queue',
      };
    }
    case 'running': {
      const done = input.done ?? 0;
      const total = input.total ?? 0;
      return {
        magicCircle: true,
        spin: true,
        count: splitCount(done, total),
        text: '翻译中',
        action: 'cancel-task',
      };
    }
    default:
      return { magicCircle: false, spin: false, count: null, text: '', action: null };
  }
}

/** 回执条种类（《01》§7.2） */
export type ReceiptKind = 'success' | 'warning' | 'error' | 'muted';

export interface Receipt {
  kind: ReceiptKind;
  /** 主行；`comicName` 由 UI 以强调样式插入到「已保存到 漫画库 / X /」中间 */
  title: string;
  comicName?: string;
  /** 副行 */
  subtitle?: string;
  action?: { id: 'open-dir' | 'retry-failed' | 'copy-log'; label: string };
}

/** 完成 / 部分失败 / 取消 / 失败 的回执条（《01》§7.2） */
export function receiptFor(input: {
  state: ClientState;
  comicName?: string;
  done?: number;
  total?: number;
  failed?: number;
  keptItems?: number;
  subtitle?: string;
}): Receipt | null {
  switch (input.state) {
    case 'done':
      return {
        kind: 'success',
        title: '已保存到 漫画库 /',
        comicName: input.comicName,
        subtitle: input.subtitle,
        action: { id: 'open-dir', label: '打开目录' },
      };
    case 'partial_failed':
      return {
        kind: 'warning',
        // 《01》§7：回执条转 warning + 「18 / 20 · 2 张失败」
        title: `${input.done ?? 0} / ${input.total ?? 0} · ${input.failed ?? 0} 张失败`,
        subtitle: input.subtitle,
        // 「重试失败项」**只重试失败项**
        action: { id: 'retry-failed', label: '重试失败项' },
      };
    case 'canceled':
      return {
        kind: 'muted',
        // §5.6：已落盘保留
        title: `已取消 · 保留 ${input.keptItems ?? 0} 张已翻译`,
        subtitle: input.subtitle,
      };
    case 'failed':
      return {
        kind: 'error',
        title: '翻译失败',
        subtitle: input.subtitle,
        action: { id: 'copy-log', label: '复制日志' },
      };
    default:
      return null;
  }
}

/**
 * 取消确认文案。
 *
 * 《03》§4.4「取消的确认规则」：`queued` 一次确认；`running` 二次确认，
 * **文案必须包含「已翻译的 N 张会保留」**。
 */
export function cancelConfirmCopy(state: ClientState, doneCount: number): {
  times: 1 | 2;
  title: string;
  description: string;
  confirmText: string;
} | null {
  if (state === 'queued') {
    return {
      times: 1,
      title: '取消排队？',
      description: '任务尚未开始，取消后不会产生任何文件与目录。',
      confirmText: '取消排队',
    };
  }
  if (state === 'running') {
    return {
      times: 2,
      title: '确认取消翻译？',
      description: `当前正在执行。取消后将**等当前这张跑完**，已翻译的 ${doneCount} 张会保留。`,
      confirmText: '仍要取消',
    };
  }
  return null;
}

/** 错误码 → 面板内文案（《03》§2.2 / §2.3「客户端处理」列） */
export const ERROR_COPY: Record<ApiErrorCode, string> = {
  BATCH_LIMIT_EXCEEDED: '单次最多提交 20 张',
  COMIC_NAME_REQUIRED: '请填写漫画名',
  INVALID_COMIC_NAME: '漫画名含非法字符或为系统保留名',
  INVALID_IMAGE: '有图片无法解码，请刷新页面后重试',
  IDEMPOTENT_REPLAY: '',
  TASK_NOT_FOUND: '任务已不存在，已清理本地引用',
  TASK_NOT_APPENDABLE: '任务已结束，请新建任务',
  TASK_NOT_CANCELABLE: '任务已结束，无需取消',
  SEQUENCE_OVERFLOW: '该漫画名页数已达上限，请另存为新目录',
  DISK_FULL: '磁盘空间不足，本张未落盘',
  PERMISSION_DENIED: '令牌无效，请到 Box 设置里重新配对',
  UNAVAILABLE: '本地翻译服务未就绪',
  INTERNAL: '服务内部错误',
  // —— ver2.0 新增（《03》§2.3，《01》§4.3）——
  /** §4.3：提示行「正在准备翻译引擎…」（见 §4.1），主动作「重试」 */
  ENGINE_NOT_READY: '正在准备翻译引擎…',
  /** §4.3：错误条「翻译模型下载失败或校验不通过」+ 日志入口；主动作「打开 Box 重新下载模型」 */
  MODEL_DOWNLOAD_FAILED: '翻译模型下载失败或校验不通过',
};

/**
 * 服务就绪阶段 —— **渲染条件**，不是状态机的节点（沿用本文件头注释的建模口径）。
 *
 * - `ready`    进程在、已配对、引擎可用 → 不渲染任何浮层
 * - `absent`   进程**不在** → 「服务未就绪」（《01》§4.4 左列）
 * - `preparing` 进程**在**但引擎未就绪 → 「准备中」（《01》§4.4 中列 / 《03》§2.3）
 *
 * 触发路径：`absent` 来自端口探测失败（`serviceLost`）；`preparing` 来自
 * `POST /tasks` 返回 `503 ENGINE_NOT_READY`（《01》§4.1「触发」行）。
 */
export type ServicePhase = 'ready' | 'absent' | 'preparing';

/**
 * 「服务未就绪」态的文案（《01》§7 末行 / §4.4 左列）。
 *
 * = 引擎进程**不在**（用户没启动 Box，或 Box 已退出）。
 */
export const SERVICE_NOT_READY = {
  phase: 'absent',
  title: '本地翻译服务未运行',
  /** 《01》§4.4 左列的主按钮名 */
  primary: '启动 Box',
  /**
   * 面板**实际渲染**的按钮名。
   *
   * 规格内部矛盾（已记录，待拍板）：P2-03 / 《01》§待确认 6 明确「首版不做 `box://`
   * 协议唤起」，界面却把按钮命名为「启动 Box」—— 按钮名是一个承诺，首版兑现不了。
   * 用户已指示本轮先搁置该议题，因此这里按规格原样实现 `primary`，仅把渲染名退化为
   * 「重试连接」（点击仍是重新探测服务），并在文档中标注风险。
   */
  actionLabel: '重试连接',
  secondary: '重试',
  specConflict:
    '首版不实现 box:// 协议唤起（P2-03），该按钮当前仅能给出手把手引导；建议后续改为「如何启动 Box」或补 box:// 支持。',
} as const;

/**
 * 「引擎准备中」态的文案（《01》§4.1 / §4.4 中列；《03》§2.3）。
 *
 * = 引擎进程**在**但处于 `starting` / `downloading` / `prewarming`（首次使用、
 * 或长时间闲置后被卸载再唤醒）。
 *
 * **不得**与 `SERVICE_NOT_READY` 混用（《03》§2.3 边界 / 《01》§4.4 判据）；
 * 因此这里**没有**「启动 Box」按钮，只给「重试」+ 等待语义。
 */
export const ENGINE_PREPARING = {
  phase: 'preparing',
  /** 《01》§4.1 提示行文案（逐字，不得改写） */
  title: '正在准备翻译引擎…',
  /** 主动作：只给「重试」（§4.4 中列：**无「启动 Box」**） */
  primary: '重试',
  actionLabel: '重试',
  /** §4.1 交互：提示「准备完成后请重新提交」（不排队、不缓存） */
  secondary: '准备完成后请重新提交',
  /** 《01》§4.2 / §4.3 文案（逐字，不得改写）：预期行为，不得做成错误 / 警告样式 */
  slowFirst: '首张稍慢，后续加快',
} as const;

/** 两态的并集（`serviceOverlayFor` 的返回类型） */
export type ServiceStateCopy = typeof SERVICE_NOT_READY | typeof ENGINE_PREPARING;

/**
 * 阶段 → 浮层文案。`ready` 返回 null（无可渲染的浮层）。
 *
 * 这是「两态不得混用」的**唯一**分流点（《01》§4.4 判据）。
 */
export function serviceOverlayFor(phase: ServicePhase): ServiceStateCopy | null {
  if (phase === 'absent') return SERVICE_NOT_READY;
  if (phase === 'preparing') return ENGINE_PREPARING;
  return null;
}
