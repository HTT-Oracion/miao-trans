# 喵译 MiaoTrans · 漫画就地翻译器（插件端 ver1.0）

浏览器扩展端实现：在漫画网页上就地翻译 —— 悬浮球唤起面板 → 选图 → 提交本地翻译服务 → 译文直接替换网页原图。

严格依据《插件与 box ver1.0》方案文档开发（`01-插件-技术方案` / `03-翻译服务接口契约` 为 SSOT）。本迭代**不含** Box 桌面端与真实后端，后端行为由 `mock-service/` 模拟。

## 目录结构

```
miao-trans/
├── extension/          Chrome MV3 扩展（WXT 0.21 + React 18 + Redux Toolkit + AntD 5）
│   ├── entrypoints/    background（消息路由/SSE/抓图）、content（Shadow DOM 面板挂载）
│   ├── src/
│   │   ├── types/      契约逐条映射（DTO / 13 个错误码 / SSE 事件）
│   │   ├── adapters/   box-service 客户端（端口探测 / multipart / SSE 手动消费）
│   │   ├── naming/     漫画名 NFKC 0–10 步管线、阅读顺序排序、分批切分
│   │   ├── selection/  计数三态、分层拦截、P0-1/P0-2 规则
│   │   ├── domain/     客户端 8 态状态机与逐态能力表
│   │   ├── store/      Redux（batch / item / selection 三 slice，DOM 对象走 registry）
│   │   ├── panel/      悬浮球 + 360×680 面板 + 七层缩略格（L0–L6）
│   │   └── content/    回写（P0-1）与路由监听（P0-2）
│   ├── tests/          单测 153 项（含规格几何钉死、CSS 硬规则正则断言、静态资源完整性）
│   └── e2e/            真实浏览器端到端验收
├── mock-service/       box-service 替身（零第三方依赖，仅 node:*）
├── docs/               验收报告与规格偏差记录
└── e2e/                端到端验收脚本（npm run verify）
```

## 常用命令

```bash
npm install          # 安装依赖（extension + 根）
npm run build        # 构建扩展 → extension/.output/chrome-mv3
npm test             # 插件单测（vitest，150 项）
npm run mock         # 启动 mock box-service（默认 5180，打印令牌）
npm run page         # 启动漫画页夹具（5199，含「追加 8 张 / SPA 换页 / 整页导航」）
npm run verify       # 端到端验收（自动起 mock + 夹具 + 扩展浏览器，27 项断言）
```

手动联调：`npm run build` 后在 `chrome://extensions` 以开发者模式加载 `extension/.output/chrome-mv3`，`npm run mock` + `npm run page`，访问 `http://127.0.0.1:5199/`，点开右下角悬浮球展开面板，粘贴令牌配对。

本地测试配对令牌（mock 默认值，可用 `MOCK_TOKEN` 环境变量覆盖）：

```
a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90
```

## 演示模式（临时 —— 后端就绪后移除）

Box 后端尚未开发。`extension/src/domain/demoMode.ts` 的 `DEMO_BYPASS_SERVICE_READY = true`
会在**探测不到本地服务**时放开渲染门控：面板不再被「服务未就绪」浮层盖住、不弹配对引导，
无需启动任何服务即可预览插件整体（悬浮球 → 展开 → 扫描 → 勾选 → 分页 → 超限拦截等）。

- 仅在服务缺席时生效；mock / 真实服务在场时行为完全不变（`npm run verify` 27 项不受影响）。
- 提交 / 回写仍走真实请求，无服务时会进入失败态（这也是 UI 的一部分）。
- 无服务场景的回归探针：`cd extension && node e2e/noservice-probe.mjs`（8 项断言）。
- 后端就绪后：把常量改回 `false` 或删除该文件，并删除 `e2e/noservice-probe.mjs`。

## 验收基线（ver1.0 迭代完成时）

| 项 | 结果 |
|---|---|
| 插件单测 | 153/153 通过 |
| mock-service 自测 | 47 + 18 + 49（回归）全绿，13 个契约错误码可达性矩阵 |
| 端到端验收 | 27/27（真实 Chromium + 未打包扩展，含像素级回写证明） |
| `tsc --noEmit` / `wxt build` | 干净 / 通过 |

详见 `docs/acceptance.md`（验收报告）与 `docs/spec-notes.md`（规格偏差与裁定记录）。
