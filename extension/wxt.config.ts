import { defineConfig } from 'wxt';

/**
 * 构建配置 —— 严格对齐《01-插件-技术方案-ver1.0.md》§3 / §3.1 / §8 / §9。
 *
 * 权限口径（§3.1 ver1.0 变更，逐条落地）：
 *   1. 删除 `http://127.0.0.1:5003/*`（5003 对插件永久不可见，见《03》§1 铁律）
 *   2. 翻译入口收窄为 `http://127.0.0.1/*`（不含端口 → 一条覆盖 5180–5190 全段，
 *      因为 MV3 match pattern 不支持端口通配）
 *   3. 抓图范围由 all_urls 收窄为 http + https 两条（去掉 file:// 等，见下方 host_permissions）
 */
export default defineConfig({
  modules: ['@wxt-dev/module-react'],
  manifestVersion: 3,
  srcDir: '.',
  outDir: '.output',

  manifest: {
    name: '喵译 MiaoTrans · 漫画就地翻译器',
    description:
      '在漫画网页上就地翻译：悬浮球唤起面板 → 选图 → 提交本地翻译服务 → 译文直接替换网页原图。',
    version: '1.0.0',
    // §9：品牌标识沿用既有稿「吉祥物 · 猫耳对话框」，四档尺寸（工具栏 16/32、扩展管理页 48、商店 128）
    icons: {
      16: 'icon/plugin-logo-16.png',
      32: 'icon/plugin-logo-32.png',
      48: 'icon/plugin-logo-48.png',
      128: 'icon/plugin-logo-128.png',
    },
    // §3.1 权限声明 —— 逐字对齐，不做增删
    permissions: ['storage', 'downloads', 'scripting', 'activeTab'],
    host_permissions: ['http://127.0.0.1/*', 'http://*/*', 'https://*/*'],
    // content script 在页面上下文里引用扩展内资源（悬浮球 / 面板的 brand logo）
    // 必须显式放行，否则 Chrome 会以 ERR_FAILED 拒载（e2e 探针实测发现）。
    // 仅暴露自己的 icon 目录，不放宽其他资源。
    web_accessible_resources: [
      {
        resources: ['icon/*'],
        matches: ['http://*/*', 'https://*/*'],
      },
    ],
    action: {
      default_title: '喵译 MiaoTrans',
      default_icon: {
        16: 'icon/plugin-logo-16.png',
        32: 'icon/plugin-logo-32.png',
      },
    },
  },
});
