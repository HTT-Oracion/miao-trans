import { defineConfig } from 'vitest/config';
import { WxtVitest } from 'wxt/testing/vitest-plugin';

/**
 * 单元测试配置。
 *
 * 覆盖策略（验收线见 docs/02-验收报告.md）：
 *   - `naming` / `boxServiceClient` 等纯逻辑模块在 node 环境下测（快、无 flake）
 *   - 涉及 DOM 的硬规则（回写校验、URL 变更、悬停层 pointer-events）在 jsdom 下测
 */
export default defineConfig({
  /**
   * 类型收敛说明：WXT 0.21 依赖 vite ^6.3.4 || ^7 || ^8（实际装到 8.3.2），
   * 而 vitest 2/3 的 vite 上限是 7 —> `node_modules` 里必然存在**两份 vite**，
   * 两份的 `PluginOption` 类型互不兼容。这里把插件收敛掉类型；运行时不受影响。
   */
  plugins: [WxtVitest() as unknown as never],
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environmentMatchGlobs: [
      ['tests/dom/**', 'jsdom'],
      ['tests/panel/**', 'jsdom'],
    ],
    globals: false,
    restoreMocks: true,
  },
});
