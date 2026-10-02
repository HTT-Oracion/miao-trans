/**
 * 已选集 —— 跨页累积的选择状态。
 *
 * key 的设计：`img-<documentIndex>`（文档顺序）。
 *   - 无限滚动场景下新图**追加在尾部**，已有图片的文档序号不变 → key 稳定
 *   - SPA 替换 DOM 时序号会错位，但这种情形已被 P0-2 清空判据兜住
 *   - 提交时仍会用 `expectedUrl` 二次解析元素（见 content/writeback.ts 的
 *     `findImageByExpectedUrl`），所以 key 错位最多导致「该张被跳过并标记」，
 *     不会造成译文串图
 *
 * 「分布于 M 页」的 M 是**面板页码**数（面板每页 20 张），不是网页数 ——
 * 依据《01》§6.4：分页器每个页码右上加 8×8 粉点标识该页有已选项。
 */

import { createSlice, type PayloadAction } from '@reduxjs/toolkit';

export interface SelectionState {
  /** 已选 key，有序（按加入顺序；提交前会按阅读顺序重排） */
  selectedKeys: string[];
  /** key → 面板页码（1 起） */
  pageOfKey: Record<string, number>;
  /** 已选集合的版本号 —— 每次变更 +1，供异步流程判断「选择是否已被清空」 */
  revision: number;
}

const initialState: SelectionState = { selectedKeys: [], pageOfKey: {}, revision: 0 };

const slice = createSlice({
  name: 'selection',
  initialState,
  reducers: {
    toggled(s, a: PayloadAction<{ key: string; page: number }>) {
      const i = s.selectedKeys.indexOf(a.payload.key);
      if (i >= 0) s.selectedKeys.splice(i, 1);
      else s.selectedKeys.push(a.payload.key);
      s.pageOfKey[a.payload.key] = a.payload.page;
      s.revision += 1;
    },

    /** 显式勾选（用于「全选本页」） */
    selectedMany(s, a: PayloadAction<{ items: Array<{ key: string; page: number }> }>) {
      for (const it of a.payload.items) {
        if (!s.selectedKeys.includes(it.key)) s.selectedKeys.push(it.key);
        s.pageOfKey[it.key] = it.page;
      }
      s.revision += 1;
    },

    /** 「清除」—— 工具条动作 */
    cleared(s) {
      s.selectedKeys = [];
      s.pageOfKey = {};
      s.revision += 1;
    },

    /** 「取消勾选（回到 20 张内）」—— 超限拦截的主动作 */
    keptFirst(s, a: PayloadAction<number>) {
      s.selectedKeys = s.selectedKeys.slice(0, a.payload);
      for (const k of Object.keys(s.pageOfKey)) {
        if (!s.selectedKeys.includes(k)) delete s.pageOfKey[k];
      }
      s.revision += 1;
    },

    /**
     * 清空判据命中（P0-2）后调用。
     * 刻意与 `cleared` 分开，便于在日志/自检里区分「用户主动清除」与「路由变更自动清空」。
     */
    autoCleared(s, a: PayloadAction<{ reason: 'url-changed' | 'left-dom' }>) {
      s.selectedKeys = [];
      s.pageOfKey = {};
      s.revision += 1;
      void a.payload.reason;
    },

    /** 重新扫描后刷新页码映射（列表长度变化会改变分页） */
    pageMapUpdated(s, a: PayloadAction<Record<string, number>>) {
      s.pageOfKey = { ...s.pageOfKey, ...a.payload };
    },

    /** 丢弃已不在页面上的 key（抓取结果刷新时） */
    pruned(s, a: PayloadAction<string[]>) {
      const alive = new Set(a.payload);
      const next = s.selectedKeys.filter((k) => alive.has(k));
      if (next.length !== s.selectedKeys.length) {
        s.selectedKeys = next;
        for (const k of Object.keys(s.pageOfKey)) {
          if (!alive.has(k)) delete s.pageOfKey[k];
        }
        s.revision += 1;
      }
    },
  },
});

export const selectionActions = slice.actions;
export const selectionReducer = slice.reducer;

/** 已选张数 */
export function selectedCountOf(s: SelectionState): number {
  return s.selectedKeys.length;
}

/** 「分布于 M 页」—— M 为**面板页码**的distinct 数 */
export function pageCountOf(s: SelectionState): number {
  const pages = new Set<number>();
  for (const k of s.selectedKeys) {
    const p = s.pageOfKey[k];
    if (p != null) pages.add(p);
  }
  return pages.size;
}

/** 分页器要打点的页码集合（《01》§6.4：每个页码右上加 8×8 粉点） */
export function pagesWithSelection(s: SelectionState): Set<number> {
  const pages = new Set<number>();
  for (const k of s.selectedKeys) {
    const p = s.pageOfKey[k];
    if (p != null) pages.add(p);
  }
  return pages;
}
