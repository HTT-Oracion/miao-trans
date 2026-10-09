# 喵译 MiaoTrans · 漫画就地翻译器（插件端 ver1.0）

浏览器扩展端实现：在漫画网页上就地翻译 —— 悬浮球唤起面板 → 选图 → 提交本地翻译服务 → 译文直接替换网页原图。

严格依据《插件与 box ver1.0》方案文档开发（`01-插件-技术方案` / `03-翻译服务接口契约` 为 SSOT）。本迭代**不含** Box 桌面端与真实后端，后端行为由 `mock-service/` 模拟。

> **ver2.0 衔接（S8）—— ✅ 已完成**：插件侧只做必要衔接 —— 解析《03》§2.3 的 `ENGINE_NOT_READY` /
> `MODEL_DOWNLOAD_FAILED`，把「服务未就绪」扩为**未就绪 / 准备中**两态（《01》§4.1 / §4.4），
> 并删除 ver1.0 遗留的演示旁路开关（服务缺席时不再放开渲染门控，一律走原路径）。
> 其余交互沿 ver1.0 不变。验收：真机联调 E9 **19/0**，台账见 `miao-dock` 仓 D-77。

## 目录结构

```
miao-trans/
├── extension/          Chrome MV3 扩展（WXT 0.21 + React 18 + Redux Toolkit + AntD 5）
│   ├── entrypoints/    background（消息路由/SSE/抓图）、content（Shadow DOM 面板挂载）
│   ├── src/
│   │   ├── types/      契约逐条映射（DTO / 15 个错误码 / SSE 事件）
│   │   ├── adapters/   box-service 客户端（端口探测 / multipart / SSE 手动消费）
│   │   ├── naming/     漫画名 NFKC 0–10 步管线、阅读顺序排序、分批切分
│   │   ├── selection/  计数三态、分层拦截、P0-1/P0-2 规则
│   │   ├── domain/     客户端 8 态状态机与逐态能力表
│   │   ├── store/      Redux（batch / item / selection 三 slice，DOM 对象走 registry）
│   │   ├── panel/      悬浮球 + 360×680 面板 + 七层缩略格（L0–L6）
│   │   └── content/    回写（P0-1）与路由监听（P0-2）
│   ├── tests/          单测 201 项（含规格几何钉死、CSS 硬规则正则断言、静态资源完整性）
│   └── e2e/            真实浏览器端到端验收
├── mock-service/       box-service 替身（零第三方依赖，仅 node:*）
├── docs/               验收报告与规格偏差记录
└── e2e/                端到端验收脚本（npm run verify / e9-real-engine.mjs）
```

> **测试产物统一落 `.temp-translate-test/`（已 gitignore）** —— 真机联调会落盘几十 MB 的漫画原文/译文、
> box-service 的 state、Playwright 的浏览器 profile。**不要再往 `e2e/` 里写运行产物**。

## 常用命令

```bash
npm install          # 安装依赖（extension + 根）
npm run build        # 构建扩展 → extension/.output/chrome-mv3
npm test             # 插件单测（vitest，201 项）
npm run mock         # 启动 mock box-service（默认 5180，打印令牌）
npm run page         # 启动漫画页夹具（5199，含「追加 8 张 / SPA 换页 / 整页导航」）
npm run verify       # 端到端验收（自动起 mock + 夹具 + 扩展浏览器，27 项断言）
```

**真机联调（插件 ↔ 真 box-service ↔ 真引擎，E9）** —— 不复用上面的 mock，自己拉起真进程：

```bash
npm run build
node e2e/e9-real-engine.mjs       # 约 10 分钟：18 + 13 = 31 张，19 条断言
node extension/e2e/noservice-probe.mjs   # 「服务未就绪」路径（真实 Chromium，不启动 mock）
```

`e9-real-engine.mjs` 会把 box-service / 引擎 / ③ 全部拉起并**自己收尾**（含 `:8001` 执行器这个孙进程），
产物落 `.temp-translate-test/e9-<时间戳>/`；它逐一断言「扫描张数 → 勾选计数 → 提交 → 回写 → 落盘」，
并把证据写到 `miao-dock` 仓的 `docs/refs/engine/`。**需先确认 5180 / 8000 / 8001 / 8080 无占用**。

手动联调：`npm run build` 后在 `chrome://extensions` 以开发者模式加载 `extension/.output/chrome-mv3`，`npm run mock` + `npm run page`，访问 `http://127.0.0.1:5199/`，**点击**右下角悬浮球展开面板（拖动不展开；悬浮球与面板可各自拖动，收起后悬浮球落在面板旁），粘贴令牌配对。

本地测试配对令牌（mock 默认值，可用 `MOCK_TOKEN` 环境变量覆盖）：

```
a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90
```

## 验收基线（ver1.0 迭代完成时）

| 项 | 结果 |
|---|---|
| 插件单测 | 195/195 通过 |
| mock-service 自测 | 47 + 18 + 49（回归）全绿，ver1.0 的 13 个契约错误码可达性矩阵 |
| 端到端验收 | 27/27（真实 Chromium + 未打包扩展，含像素级回写证明） |
| `tsc --noEmit` / `wxt build` | 干净 / 通过 |

详见 `docs/acceptance.md`（验收报告）与 `docs/spec-notes.md`（规格偏差与裁定记录）。

## 验收基线（ver2.0 · S8 插件串联完成时）

> ver1.0 那版基线（上表 195/27）是**历史事实**，不改写；下面是当前口径。

| 项 | 结果 |
|---|---|
| 插件单测 | **247/247**（ver2.1 英译中新增 `tests/direction.test.ts` 8 条 + 分母门，定位滚动新增 `tests/dom/scrollLocate.test.ts` 7 条 + 反证 4 条 + 分母门；此前 `s8-engine-states` 两态分流、选择上限 50 的 4 条、定位修复 10 条、zip 导出 11 条均已计入） |
| 端到端验收（mock） | **30/30**（真实 Chromium + 未打包扩展，含像素级回写证明；ver2.1 新增 K1/K2 方向链路取证，并按 D-07 口径重写 H3/I 段失效断言） |
| 「服务未就绪」路径 | `extension/e2e/noservice-probe.mjs` **10/10**（不启动 mock-service） |
| 真机联调 E9（真引擎） | **19/0**（真实漫画站 31 张；序号 001–031 连续、串行不交错、31 项全成功） |
| `tsc --noEmit` / `wxt build` | 干净 / 通过 |
| 反证 | S8 三条 + noservice 探针 4 项 FAIL + 选择上限 2 条（`SELECT_LIMIT`→20 变红 6 条、→40 变红 1 条）+ P4-5 收窄 3 条 + **ver2.1 方向链路 8 条**（单测 5：删白名单 / `sameDirection` 恒真 / 共享引用 / 去保留 / 剔 lang；e2e 3：控件不可见 / controller 不带 lang / background 丢 lang），各真跑变红后按字节还原 |

台账：`miao-dock/docs/spec-notes.md` 的 **D-77**；引擎侧逐项验收见 `miao-dock/docs/engine-e2e-acceptance-report.md` §2.9。
