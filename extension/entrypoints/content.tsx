/**
 * content script —— 注入入口。
 *
 * 三件事：
 *   1. **Shadow DOM 隔离**（《01》§3 选型）：避免漫画站的样式污染面板，也避免面板的
 *      样式污染站点。WXT 的 `createShadowRootUi` 负责建立 shadow host 与 uiContainer。
 *   2. **深色模式**（《01》§11 #4「跟随系统 + 手动覆盖」）：跟随时监听媒体查询，
 *      手动覆盖优先。实现方式与设计稿一致 —— **只换颜色变量，不换结构**。
 *   3. **卸载清理**：blob URL 必须显式 revoke，否则页面停留久了会积累几十 MB 内存。
 */

import { createRoot, type Root } from 'react-dom/client';
import { defineContentScript } from 'wxt/utils/define-content-script';
import { createShadowRootUi } from 'wxt/utils/content-script-ui/shadow-root';
import { browser } from 'wxt/browser';

import './../src/panel/panel.css';
import { PanelRoot } from '../src/panel/PanelRoot';
import { releaseAllWriteBacks } from '../src/content/writeback';

const THEME_KEY = 'themeMode';
type ThemeMode = 'auto' | 'light' | 'dark';

export default defineContentScript({
  /**
   * 抓图范围（《03》§8.3 的权限收敛）：`http://*​/*` + `https://*​/*`。
   * 不用 `<all_urls>` —— 那会连 `file://` 一起要进来。
   */
  matches: ['http://*/*', 'https://*/*'],
  /** UI 模式下 WXT 会把 CSS 注入到 shadow root 而不是页面 head */
  cssInjectionMode: 'ui',
  runAt: 'document_idle',

  async main(ctx) {
    const ui = await createShadowRootUi(ctx, {
      name: 'miao-trans-panel',
      position: 'modal',
      zIndex: 2_147_483_000,
      anchor: 'body',
      append: 'last',
      /**
       * 键盘事件不冒泡出影子根 —— 这条很重要：漫画站普遍绑了 `←` `→` 翻页、
       * 空格滚动。用户在面板里输入漫画名时，按键不该同时触发站点翻页。
       */
      isolateEvents: ['keydown', 'keyup', 'keypress'],

      onMount(container, shadow) {
        const root = createRoot(container);
        const current = resolveThemeSync();
        root.render(<PanelRoot shadowRoot={shadow} theme={current} />);

        // 主题变化 → 重新挂载（变量在根节点上，重挂是最省心的同步方式）
        void attachThemeSync(root, shadow);
        return root;
      },

      onRemove(root: Root | undefined) {
        root?.unmount();
        // 显式释放 blob URL：译文替换的是 blob:，不 revoke 会一直占内存
        releaseAllWriteBacks();
      },
    });

    ui.mount();
  },
});

/** 同步读一次当前主题（优先手动覆盖，其次系统） */
function resolveThemeSync(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

async function readManualTheme(): Promise<ThemeMode> {
  try {
    const got = await browser.storage.local.get(THEME_KEY);
    const v = got[THEME_KEY] as ThemeMode | undefined;
    return v === 'light' || v === 'dark' || v === 'auto' ? v : 'auto';
  } catch {
    return 'auto';
  }
}

async function attachThemeSync(root: Root, shadow: ShadowRoot): Promise<void> {
  const manual = await readManualTheme();
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  const apply = (): void => {
    const effective = manual === 'auto' ? (media.matches ? 'dark' : 'light') : manual;
    root.render(<PanelRoot shadowRoot={shadow} theme={effective} />);
  };
  apply();
  if (manual === 'auto') {
    media.addEventListener('change', apply);
  }
}
