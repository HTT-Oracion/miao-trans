/**
 * 单图 item 状态 —— 对应《01》§8 的 `itemSlice.ts`。
 *
 * 数据来源有两处，且**服务端始终是权威**：
 *   1. `GET /tasks/{id}` 的 `items[]`（刷新恢复时全量拉取）
 *   2. SSE 的 `item.status` 事件（增量更新）
 *
 * 本地只额外记录两类**浏览器侧事实**（服务端不可能知道）：
 *   - `leftPage`：回写时发现原图已离开 DOM（P0-1 跳过）
 *   - `writtenBack`：译文已成功替换到页面
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';
import type { ItemDto, ItemStatus } from '../../types/contract';
import { thumbStatusOf, type ThumbStatus } from '../../selection/rules';

export interface ItemView extends ItemDto {
  /** 浏览器侧事实：原图已离开当前页面（P0-1 判定） */
  leftPage?: boolean;
  /** 浏览器侧事实：译文已回写到页面 */
  writtenBack?: boolean;
}

export interface ItemState {
  /** seq → item */
  bySeq: Record<number, ItemView>;
  /** 已回写完成的 seq，按 seq 升序 —— 决定「导出」可用性 */
  writtenBackSeqs: number[];
}

const initialState: ItemState = { bySeq: {}, writtenBackSeqs: [] };

const slice = createSlice({
  name: 'item',
  initialState,
  reducers: {
    /** 全量替换（`GET /tasks/{id}` 或首轮提交后的预期集合） */
    itemsReplaced(s, a: PayloadAction<ItemDto[]>) {
      const next: Record<number, ItemView> = {};
      for (const it of a.payload) {
        const prev = s.bySeq[it.seq];
        next[it.seq] = {
          ...it,
          // 保留浏览器侧事实：服务端刷新不应抹掉「已回写」这个本地观测
          leftPage: prev?.leftPage,
          writtenBack: prev?.writtenBack,
        };
      }
      s.bySeq = next;
    },

    /** 先用已选集合铺一层 `pending`，让网格在拿到服务端 items 之前就有确定形态 */
    itemsSeed(s, a: PayloadAction<number[]>) {
      for (const seq of a.payload) {
        if (!s.bySeq[seq]) s.bySeq[seq] = { seq, status: 'pending' };
      }
    },

    itemStatusEvent(s, a: PayloadAction<ItemDto>) {
      const incoming = a.payload;
      const prev = s.bySeq[incoming.seq];
      s.bySeq[incoming.seq] = { ...prev, ...incoming, leftPage: prev?.leftPage, writtenBack: prev?.writtenBack };
    },

    batchItemsStatus(s, a: PayloadAction<{ seqFrom: number; seqTo: number; status: ItemStatus }>) {
      for (let seq = a.payload.seqFrom; seq <= a.payload.seqTo; seq += 1) {
        const prev = s.bySeq[seq];
        if (prev) prev.status = a.payload.status;
      }
    },

    writtenBack(s, a: PayloadAction<number>) {
      const it = s.bySeq[a.payload];
      if (it) it.writtenBack = true;
      if (!s.writtenBackSeqs.includes(a.payload)) {
        s.writtenBackSeqs.push(a.payload);
        s.writtenBackSeqs.sort((x, y) => x - y);
      }
    },

    /** P0-1 跳过回写 → 标记「原图已离开页面」 */
    markedLeftPage(s, a: PayloadAction<number[]>) {
      for (const seq of a.payload) {
        const it = s.bySeq[seq];
        if (it) it.leftPage = true;
      }
    },

    reset(s) {
      s.bySeq = {};
      s.writtenBackSeqs = [];
    },
  },
});

export const itemActions = slice.actions;
export const itemReducer = slice.reducer;

/** L4 状态点（供缩略图渲染；映射规则见 selection/rules.ts 的 thumbStatusOf） */
export function thumbStatusOfSeq(items: Record<number, ItemView>, seq: number): ThumbStatus {
  const it = items[seq];
  if (it?.leftPage) return 'warning';
  return thumbStatusOf(it);
}
