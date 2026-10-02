/**
 * 路由变更监听 —— 覆盖《01》§6.4 的**三类** URL 变更。
 *
 * | 类型 | 特征 | 检测方式 |
 * |------|------|----------|
 * | ① MPA 真导航 | 整页重载 | content script 会整体重启，等价于新会话 |
 * | ② SPA pushState | URL 变、DOM 部分复用 | 包装 `history.pushState/replaceState` + `popstate` |
 * | ③ 无限滚动 | **URL 根本不变**，图片持续追加 | `MutationObserver` 观测新增 `<img>` |
 *
 * 类型 ③ 是原稿漏掉的那一类：它让「URL 变化才清空」这条规则**永不触发**，
 * 于是两话图片混进同一任务、序号跨话连续。因此这里必须独立检测，
 * 并由《01》§6.4 的 P0-2 判据（URL 变化 **或** >60% 已选图已离开 DOM）兜住。
 */

export type RouteChangeKind = 'spa' | 'infinite-scroll' | 'dom-shift';

export interface RouteChangeInfo {
  kind: RouteChangeKind;
  url: string;
  previousUrl: string;
  /** 本次变更中新增的 `<img>` 数 */
  addedImages: number;
  /** 本次变更中移除的 `<img>` 数 */
  removedImages: number;
  at: number;
}

export interface RouteWatcherOptions {
  /** 观察范围，默认 `document.body` */
  root?: HTMLElement;
  /** 变更聚合窗口，默认 400ms —— 无限滚动是一串连续的 DOM 操作，必须合并成一次事件 */
  debounceMs?: number;
  /** `location.href` 取值函数，便于测试注入 */
  getUrl?: () => string;
}

/**
 * 安装路由监听。返回卸载函数。
 *
 * 注意：这里**只上报变更事实**，不决定是否清空已选 —— 清空判据在
 * `selection/rules.ts` 的 `shouldClearSelection`（纯函数、可单测），
 * 避免把「检测」与「策略」糅在一起。
 */
export function installRouteWatcher(
  onChange: (info: RouteChangeInfo) => void,
  options: RouteWatcherOptions = {},
): () => void {
  const getUrl = options.getUrl ?? (() => location.href);
  const debounceMs = options.debounceMs ?? 400;
  const root = options.root ?? document.body;

  let currentUrl = getUrl();
  let pending: { added: number; removed: number; kind: RouteChangeKind } | null = null;
  let timer: number | null = null;
  const disposers: Array<() => void> = [];

  const flush = (): void => {
    timer = null;
    if (!pending) return;
    const p = pending;
    pending = null;
    const url = getUrl();
    const previousUrl = currentUrl;
    currentUrl = url;
    onChange({
      kind: p.kind,
      url,
      previousUrl,
      addedImages: p.added,
      removedImages: p.removed,
      at: Date.now(),
    });
  };

  const schedule = (kind: RouteChangeKind, added: number, removed: number): void => {
    // 无限滚动优先：它是最需要被 P0-2 兜住的一类，不能被后续的 dom-shift 覆盖
    const mergedKind: RouteChangeKind =
      pending?.kind === 'infinite-scroll' || kind === 'infinite-scroll' ? 'infinite-scroll' : kind;
    pending = {
      kind: mergedKind,
      added: (pending?.added ?? 0) + added,
      removed: (pending?.removed ?? 0) + removed,
    };
    if (timer != null) window.clearTimeout(timer);
    timer = window.setTimeout(flush, debounceMs);
  };

  // ② SPA：URL 变化立即上报，不等 debounce
  const onUrlMaybeChanged = (): void => {
    const url = getUrl();
    if (url === currentUrl) return;
    if (timer != null) {
      window.clearTimeout(timer);
      timer = null;
    }
    pending = null;
    const previousUrl = currentUrl;
    currentUrl = url;
    onChange({
      kind: 'spa',
      url,
      previousUrl,
      addedImages: 0,
      removedImages: 0,
      at: Date.now(),
    });
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method].bind(history);
    const patched = (...args: Parameters<History['pushState']>): void => {
      original(...args);
      onUrlMaybeChanged();
    };
    history[method] = patched as History['pushState'];
    disposers.push(() => {
      history[method] = original as History['pushState'];
    });
  }

  window.addEventListener('popstate', onUrlMaybeChanged);
  window.addEventListener('hashchange', onUrlMaybeChanged);
  disposers.push(() => window.removeEventListener('popstate', onUrlMaybeChanged));
  disposers.push(() => window.removeEventListener('hashchange', onUrlMaybeChanged));

  // ③ 无限滚动 + DOM 复用：只在 URL 未变时归入这一类
  const observer = new MutationObserver((mutations) => {
    let added = 0;
    let removed = 0;
    let touchedImg = false;
    for (const m of mutations) {
      if (m.type !== 'childList') continue;
      for (const n of m.addedNodes) {
        if (n instanceof HTMLImageElement) {
          added += 1;
          touchedImg = true;
        } else if (n instanceof HTMLElement) {
          added += n.querySelectorAll('img').length;
          touchedImg = true;
        }
      }
      for (const n of m.removedNodes) {
        if (n instanceof HTMLImageElement) {
          removed += 1;
          touchedImg = true;
        } else if (n instanceof HTMLElement) {
          removed += n.querySelectorAll('img').length;
          touchedImg = true;
        }
      }
    }
    if (!touchedImg) return;
    const urlChanged = getUrl() !== currentUrl;
    if (urlChanged) {
      onUrlMaybeChanged();
      return;
    }
    // URL 不变 + 图片增删 → 无限滚动（追加为主）或 DOM 复用（有增有减）
    schedule(added >= removed && added > 0 ? 'infinite-scroll' : 'dom-shift', added, removed);
  });
  observer.observe(root, { childList: true, subtree: true });
  disposers.push(() => observer.disconnect());

  return () => {
    if (timer != null) window.clearTimeout(timer);
    for (const d of disposers) d();
  };
}

/** 判断当前页面是否为「整页重载后的新会话」（内容脚本每次注入都成立，保留接口以便自检） */
export function isFreshMpaSession(): boolean {
  try {
    const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
    return nav ? nav.type === 'navigate' || nav.type === 'reload' : true;
  } catch {
    return true;
  }
}
