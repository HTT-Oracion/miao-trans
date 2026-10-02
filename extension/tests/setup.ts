/**
 * 单测全局前置。
 *
 * 这里手写一份最小 `chrome` 兜底，用来**顶替** `WxtVitest()` 里那个
 * `extensionApiMock` 插件（因为该插件随 `WxtVitest()` 一起被移除了，原因见
 * `vitest.config.ts` 顶部注释）。
 *
 * 设计原则：
 *   - 只补被测模块**真的会走到**的 API，不做一个「看起来像浏览器」的假实现
 *   - 没实现的成员一律不挂，让它在调用点抛 `TypeError` —— 静默返回 undefined
 *     会让「其实依赖了扩展运行时」这件事被藏起来
 *   - `getURL` 返回一个稳定可断言的前缀，便于测试里比对扩展内资源地址
 */

const EXTENSION_ID = 'miao-trans-test';

const stub = {
  runtime: {
    id: EXTENSION_ID,
    getURL: (path: string): string =>
      `chrome-extension://${EXTENSION_ID}/${path.replace(/^\//, '')}`,
  },
} as unknown as typeof chrome;

if (typeof globalThis.chrome === 'undefined') {
  Object.defineProperty(globalThis, 'chrome', {
    value: stub,
    writable: true,
    configurable: true,
  });
}

/**
 * Firefox 风格的 `browser` 别名。WXT 源码里两种写法都有，
 * 测试里出现 `browser.*` 时不应该因为「跑的是 node」就炸掉。
 */
if (typeof (globalThis as { browser?: unknown }).browser === 'undefined') {
  Object.defineProperty(globalThis, 'browser', {
    value: stub,
    writable: true,
    configurable: true,
  });
}
