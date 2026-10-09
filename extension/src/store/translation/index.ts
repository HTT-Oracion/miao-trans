/**
 * 翻译 store —— 出口与选择器。
 *
 * 选择器全部是**纯派生**：给定同一份 state 必得同一份结果，因此 UI 层不需要
 * 再判一次「现在能不能点」这类逻辑 —— 能力表与文案都在 domain / selection 层
 * 定死，UI 只负责摆位置。这样「可做 / 不可做」这类跨屏一致性要求才不会在
 * 十几个组件里各写一遍。
 */

import { configureStore } from '@reduxjs/toolkit';
import type { DirectionCode } from '../../domain/direction';
import { batchActions, batchInitialState, batchReducer, type BatchState } from './batchSlice';
import { itemReducer, thumbStatusOfSeq, type ItemState } from './itemSlice';
import {
  pageCountOf,
  selectedCountOf,
  selectionReducer,
  type SelectionState,
} from './selectionSlice';
import {
  capabilitiesOf,
  hintRowFor,
  receiptFor,
  type ClientState,
  type HintRow,
  type Receipt,
  type StateCapabilities,
} from '../../domain/clientState';
import {
  computeSelectionCounter,
  decideSubmit,
  inlineOverLimitHint,
  type SelectionCounter,
  type SubmitDecision,
} from '../../selection/rules';
import { checkComicName } from '../../naming';
import { previewOutputPath } from '../../naming';

export function makeStore(preloaded?: {
  batch?: Partial<BatchState>;
  item?: Partial<ItemState>;
  selection?: Partial<SelectionState>;
}) {
  return configureStore({
    reducer: {
      batch: batchReducer,
      item: itemReducer,
      selection: selectionReducer,
    },
    preloadedState: preloaded
      ? {
          // 只用于测试与「刷新后恢复」两条路径
          batch: { ...batchInitialState, ...(preloaded.batch ?? {}) },
          item: { bySeq: {}, writtenBackSeqs: [], ...(preloaded.item ?? {}) },
          selection: { selectedKeys: [], pageOfKey: {}, revision: 0, ...(preloaded.selection ?? {}) },
        }
      : undefined,
  });
}

export const store = makeStore();

export type RootState = ReturnType<typeof store.getState>;
export type AppStore = ReturnType<typeof makeStore>;
export type AppDispatch = AppStore['dispatch'];

export { batchActions };
export { thumbStatusOfSeq };

// ─────────────────────────── 选择器 ───────────────────────────

export const selectBatch = (s: RootState): BatchState => s.batch;
export const selectItems = (s: RootState): ItemState => s.item;
export const selectSelection = (s: RootState): SelectionState => s.selection;

export const selectClientState = (s: RootState): ClientState => s.batch.state;
export const selectCapabilities = (s: RootState): StateCapabilities => capabilitiesOf(s.batch.state);

/** 计数三态（《01》§5.2） */
export const selectCounter = (s: RootState): SelectionCounter =>
  computeSelectionCounter(selectedCountOf(s.selection), pageCountOf(s.selection));

/** 超限内联提示（仅 >20 时非 null） */
export const selectInlineHint = (s: RootState): string | null =>
  inlineOverLimitHint(selectedCountOf(s.selection));

/** 提交决策（分层拦截的「提交阶段硬拦」） */
export const selectSubmitDecision = (s: RootState): SubmitDecision =>
  decideSubmit({
    selectedCount: selectedCountOf(s.selection),
    comicNameOk: checkComicName(s.batch.comicName).ok,
  });

/** 提示行（48 高，含 24px 小魔法阵判定） */
export const selectHintRow = (s: RootState): HintRow =>
  hintRowFor({
    state: s.batch.state,
    done: s.batch.progress?.done,
    total: s.batch.progress?.total,
    queueText:
      s.batch.queuePosition != null && s.batch.queuePosition > 0
        ? `排队 · 第 ${s.batch.queuePosition} 位`
        : '排队中',
    etaText: s.batch.etaText,
  });

/** 回执条（完成 / 部分失败 / 取消 / 失败） */
export const selectReceipt = (s: RootState): Receipt | null =>
  receiptFor({
    state: s.batch.state,
    comicName: s.batch.normalizedComicName ?? s.batch.comicName,
    done: s.batch.progress?.done,
    total: s.batch.progress?.total,
    failed: s.batch.progress?.failed,
    keptItems: s.batch.keptItems ?? 0,
    subtitle: subtitleOf(s.batch),
  });

/** 回执副行：`20 张原图 · 20 张译文 · 共 38.6 MB`（全部为事实展示） */
function subtitleOf(b: BatchState): string | undefined {
  const p = b.progress;
  if (!p) return undefined;
  return `${p.total} 张原图 · ${p.done} 张译文`;
}

/** 落盘路径预览：**提交前**用本地同源算法；**提交后**一律用服务端 `outputDir`（《03》§5.2） */
export function selectOutputPathPreview(s: RootState): string {
  if (s.batch.outputDir) return `${s.batch.outputDir}/`;
  return previewOutputPath(s.batch.comicName);
}

/** 漫画名内联校验结果 */
export function selectComicNameCheck(s: RootState) {
  return checkComicName(s.batch.comicName);
}

/** 当前翻译方向（ver2.1）—— 分段控件的选中态与提交时的 `payload.lang` 同源 */
export const selectDirection = (s: RootState): DirectionCode => s.batch.direction;
