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
      /**
       * **`:host` 的定位与层级必须在这里补回。**
       *
       * WXT 会注入 Shadow Root Reset `:host { all: initial !important }`，
       * 它把 applyPosition 设置的 inline `position/z-index`（含我们后补的
       * inline !important，实测 Chrome 中仍被吃掉）全部重置为
       * position:static / z-index:auto —— z-index 对 static 元素无效，
       * 面板便只按 DOM 顺序参与 stacking，页面上任何带 z-index 的元素
       * （漫画站常见 sticky header）都能盖住面板，表现为「面板缺一块、点不到」。
       *
       * WXT 的样式注入顺序是 `reset → options.css → entryCss`：
       * 同权重（author !important、同 specificity）下后声明胜出，
       * 所以在 options.css 里重申一次即可稳定赢回。onMount 里的 inline
       * 补丁保留作双保险。
       */
      css: ':host{position:relative !important;z-index:2147483000 !important;}',
      anchor: 'body',
      append: 'last',
      /**
       * 键盘事件不冒泡出影子根 —— 这条很重要：漫画站普遍绑了 `←` `→` 翻页、
       * 空格滚动。用户在面板里输入漫画名时，按键不该同时触发站点翻页。
       */
      isolateEvents: ['keydown', 'keyup', 'keypress'],

      onMount(container, shadow, shadowHost) {
        /**
         * **host 的定位与 z-index 必须在这里用 `!important` 补一次。**
         *
         * 为什么 options.zIndex / applyPosition 的 inline 样式不够：
         * WXT 的 Shadow Root Reset 会注入 `:host { all: initial !important }`，
         * 样式表 `!important` 优先级高于普通 inline style —— 它把 host 的
         * `position` 和 `z-index` **全部**清掉了（实测 computed:
         * position=static, z-index=auto）。z-index 对 static 元素无效，
         * 于是面板参与 stacking 时只按 DOM 顺序排 —— 页面上任何带 z-index
         * 的元素（漫画站常见的 sticky header）都会绘制在面板之上，
         * 看起来就是「面板被盖住一块、按钮点不到」。
         * inline style 带 `!important` 在 cascade 中高于 author 样式表的
         * `!important`，position + z-index 成对补回才能生效。
         */
        shadowHost?.style.setProperty('position', 'relative', 'important');
        shadowHost?.style.setProperty('z-index', '2147483000', 'important');

        /**
         * **uiContainer（modal 模式下 fixed inset:0 全视口）必须放行指针。**
         *
         * WXT 的 applyPosition 给它铺满视口且不设 pointer-events —— 一旦 host
         * 真正参与 stacking（上面的 z-index 修复），整页点击都会被这个透明层
         * 拦截（实测 elementFromPoint 命中 host），漫画站什么都点不了。
         * 指针放行交给 .mt-root 内部的 auto 元素（悬浮球 / 面板锚点）：
         * pointer-events:none 的祖先下，显式 auto 的后代仍可正常接收指针。
         */
        container.style.setProperty('pointer-events', 'none', 'important');

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
