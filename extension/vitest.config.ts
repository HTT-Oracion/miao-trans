import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

/**
 * 单元测试配置。
 *
 * 覆盖策略：
 *   - `naming` / `selection` / `domain` / `adapters` 等纯逻辑模块在 node 环境下测（快、无 flake）
 *   - 涉及 DOM 的硬规则（回写校验、URL 变更、悬停层 pointer-events）在 jsdom 下测
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 【为什么这里刻意不挂 `WxtVitest()`】
 *
 * 排障结论（已复现、已定位到源码行）：
 *   挂上 `WxtVitest()` 后，**每一个**测试文件都会被转换成 `export default {};`
 *   —— 模块体被整段擦除，于是 vitest 报 `No test suite found in file`（0 test）。
 *
 * 证据链：
 *   1. 两行探针 `import {describe,it,expect} from 'vitest'; describe(...)` 同样 0 test
 *   2. 移除 `WxtVitest()` 后同一文件立即收集到用例（28 tests）
 *   3. 加 `enforce:'post'` 的 dump 插件打印产物 → 恒为 `export default {};`
 *   4. 该字符串唯一来源：`wxt/dist/core/builders/vite/plugins/resolveAppConfig.mjs:26`
 *      （`WxtVitest()` 内部会 push 这个插件，本意只是给 `virtual:app-config` 兜底）
 *
 * 为什么可以安全去掉：`WxtVitest()` 的全部价值是（a）WXT 自动导入、
 * （b）`virtual:app-config`、（c）`import.meta.env.WXT_*`、（d）`browser` API mock。
 * 而本套单测覆盖的 8 个模块**全部零 WXT 运行时引用**（纯 TS + DOM + fetch），
 * 去掉后这四项一个都用不上；`@` 别名与 `chrome` 兜底另行显式补齐（见下）。
 *
 * 若将来要测 `entrypoints/background.ts` 这类真正依赖 WXT 运行时的模块，
 * 请**单独建一份 config**（例如 `vitest.wxt.config.ts`）来隔离这个副作用，
 * 不要把它加回本文件、否则上述 5 个测试文件会一起失效。
 * ─────────────────────────────────────────────────────────────────────────────
 */
export default defineConfig({
  resolve: {
    alias: {
      // 对齐 wxt.config.ts 的 `srcDir: '.'` → WXT 默认把 `@/` 指到项目根
      '@': fileURLToPath(new URL('./', import.meta.url)),
    },
  },
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts', 'tests/**/*.test.tsx'],
    environmentMatchGlobs: [
      ['tests/dom/**', 'jsdom'],
      ['tests/panel/**', 'jsdom'],
    ],
    setupFiles: ['./tests/setup.ts'],
    globals: false,
    restoreMocks: true,
  },
});
