/**
 * 扩展内静态资源的 URL。
 *
 * 单独成文件的原因：`browser.runtime.getURL` 在 WXT 下是**路径字面量**类型的
 * （`PublicPath`），而这里需要按尺寸动态拼接。用 `chrome.runtime.getURL`
 * 可以接受任意字符串，同时保留「不在扩展上下文时不要让整个组件崩掉」的兜底 ——
 * 单测里跑 jsdom 时没有扩展运行时，这时退化为相对路径即可。
 */
export function extensionAssetUrl(path: string): string {
  try {
    const api = (globalThis as { chrome?: { runtime?: { getURL?: (p: string) => string } } }).chrome;
    if (api?.runtime?.getURL) return api.runtime.getURL(path);
  } catch {
    /* 不在扩展上下文（测试 / 预览）—— 走相对路径 */
  }
  return path;
}

/** 品牌 Logo —— 固定尺寸档位，避免非整数缩放导致的模糊（《01》§9） */
export function logoUrl(size: 16 | 20 | 28 | 32 | 48 | 64 | 128): string {
  return extensionAssetUrl(`/icon/plugin-logo-${size}.png`);
}
