# 端到端验收报告 —— 插件端 ver1.0

> **2026-10-09 追注（ver2.1）**：本文是 ver1.0 的历史报告，结论**不改写**。当前口径见 `README.md`
> 「验收基线」表：单测 **235/235** · 端到端（mock）**30/30**。本轮新增 K1/K2（翻译方向链路取证），
> 并按 D-07（选择上限 20→50）**重写**了 H3/I 段的失效断言 —— 详见 `docs/spec-notes.md` D-11。

日期：2026-10-02　执行：`npm run verify`（e2e/verify.mjs）

## 验收环境

- 浏览器：Playwright 自带 Chromium 153（新 headless，支持扩展加载；本机 Chrome ≥137 已禁用 `--load-extension`，不可用）
- 扩展：`extension/.output/chrome-mv3` 未打包加载
- 服务：mock box-service（隔离 MOCK_ROOT/STATE_DIR，MOCK_ITEM_MS=120）+ 漫画页夹具（127.0.0.1:5199）

## 结果：27/27 通过

| # | 场景 | 断言 | 契约依据 |
|---|---|---|---|
| A1–A2 | 服务发现 | `/health` 只认 `service=box-service`（不看裸 200）；夹具就绪 | §5.1 |
| B1–B2 | 扩展加载 | service worker 存在；面板在 shadow DOM 内渲染，locator 可穿透 | §3 |
| C1–C2 | 令牌配对 + 扫描 | 配对弹层关闭；页面 12 张图全部进入网格 | §8.1 / §6.2 |
| D1–D3 | 提交链路 | 计数 = 12；到达完成态「已保存到 漫画库」；全程无页面 JS 异常 | §4.3 |
| E1–E3 | **回写像素验证** | 已勾选 12 张：`<img>` src 全部替换为 `blob:`，canvas 中心像素色相逐一等于译文期望色 `(seq×47)%360`（12/12）；未勾选 8 张保持原图色相 `(seq×37)%360`（无误翻） | P0-1 结果面 |
| F1–F4 | 落盘验证 | `MOCK_ROOT/e2e验收/` 下 12 份 `NNN.png` + 12 份 `NNN_translated.png`，序号 001–012 连续 | §7 |
| G1 | 无限滚动不误清 | 追加 8 张（URL 不变、无图离开 DOM）后已选仍为 12 | P0-2 |
| H1–H3 | 继续翻一批 | 回选择态 + 重扫到 20 张、已选清空；全选 20 → at-limit（yellow）态 | §4.3 / §5.2 |
| I0–I4 | **分层拦截** | 重扫 28 张（2 页）已选 20 保留；第 21 张仍可勾选（软拦）→ 计数 21 + over-limit（error）态；点确定 → 超限弹层出现且 **mock 队列为空**（不发请求）；「裁剪到 20」动作生效 | §5.1 |
| J1 | SPA 换页清空 | 换页后已选 = 0（P0-2 口径裁定：翻译中不停任务，只清未提交选择） | P0-2 |

关键证据（E1 实测输出）：

```
12/12 张命中 · #1:47° #2:94° #3:141° #4:188° #5:235° #6:282°
#7:329° #8:16° #9:63° #10:110° #11:157° #12:204°   （全部 = seq×47 % 360）
```

## 验收过程中发现并修复的缺陷

| # | 严重度 | 缺陷 | 修复 |
|---|---|---|---|
| 1 | **P0** | `onSubmit` 读 `ctx.current.comicName`，该字段只在 doSubmit 成功后才赋值 → **用户填了漫画名首次提交也必被拦**（e2e 卡死在 D2 暴露） | comicName 走 mirror 通道（comicNameRef 镜像），与按钮 disabled 判断同源 |
| 2 | P1 | 计数 >20 时提交按钮被 disabled 一刀切 → **超限弹层的两个动作（裁剪/分批）不可达**，违反 §5.1「拦截 + 两个动作」 | over-limit 时按钮保持可点，点击转开弹层；e2e I3 钉死「不发请求」 |
| 3 | P2 | content script 引用的 `icon/*` 不在 `web_accessible_resources` → 悬浮球 logo ERR_FAILED | 仅放行 icon 目录 |

## 未覆盖（诚实清单）

- Box/后端真实联调（本迭代范围外；mock 已按契约复核）
- 整页导航（MPA）场景的扩展重注入（夹具有按钮，验收脚本未走）
- 取消确认、失败重试、令牌错误 401 的 UI 路径（单测已覆盖规则层）
- 视觉走查（设计稿 18 令牌已由单测逐字核对，像素级视觉比对未做）

---

# 端到端验收报告 —— 插件端 ver2.0（S8 插件串联）

日期：2026-10-06　执行：`npm test` / `npm run verify` / `e2e/noservice-probe.mjs` / `e2e/e9-real-engine.mjs`

本迭代把「服务未就绪」扩为**未就绪 / 准备中**两态（《01》§4.1 / §4.4），
解析《03》§2.3 的 `ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`，
并**删除** ver1.0 遗留的演示旁路（`DEMO_BYPASS_SERVICE_READY` / `demoMode.ts`）。

## 结果

| 项 | 结果 |
|---|---|
| 插件单测 `npm test` | **201/201**（新增 `tests/s8-engine-states.test.ts`，分母钉死） |
| 端到端 `npm run verify`（mock） | **27/27** |
| 「服务未就绪」路径 `e2e/noservice-probe.mjs` | **10/10**（真实 Chromium + 未打包扩展，**不启动** mock-service） |
| 真机联调 `e2e/e9-real-engine.mjs` | **19/0** —— 真实漫画站（`jmanga.media` 112 全 18 页 + 113 前 13 页 = 31 张） + 真 box-service + **真引擎**；序号 001–031 连续、两批串行不交错、31 项全成功 |
| `npm run types` / `npm run compile` | 0 错 / 0 错 |

## 反证（都真跑变红后按 shasum 还原）

| # | 破坏 | 应变红的断言 |
|---|---|---|
| 1 | 去掉 `showsSlowFirstImageHint` 的 `current === 1` | `P3-3` |
| 2 | 打乱 `preparingSubline` 映射（`prewarming → model`） | `P2-8` |
| 3 | 恢复 `DEMO_BYPASS_SERVICE_READY` 语义（浮层按 `ready` 渲染） | noservice 探针 **4 项 FAIL** |

## S8 修正的两处口径（`0195952`）

1. 「首张稍慢，后续加快」的落点是 **`running` 且正在处理第 1 张**（《01》§4.2 /《04》§5.3 /《09》L4 三处一致），
   不是「准备中」浮层的副行；且它属**预期行为**，不得做成告警样式。
2. 「准备中」副行按阶段显示（事实源 = `503` 的 `details.sidecar.state`）；取不到就**不渲染**，不猜第三句。
   为此接通了 `details` 的跨层链路 —— 原先断在四处，导致 `BoxServiceError.details` 恒为 `{}`。

## 未覆盖（诚实清单）

- **懒加载站点「未滚动 = 抓不到图」**：真实漫画站上未进入视口的图是 1×1 透明占位 gif（真地址在 `data-src`），
  实测同一页不滚动只有 4 张通过过滤规则、滚到底 18 张。要不要在抓图前主动预热页面属**行为变更**，待产品拍板。
- **「同一任务追加批次」分支从 UI 不可达**：面板单次上限与批量上限同为 20（`decideSubmit` 超限即拦截），
  所以 `splitIntoBatches` 的 append 分支在插件侧永远走不到（服务端侧由引擎验收 E3 在 HTTP 层覆盖）。
- 「整页导航（MPA）」与 ver1.0 遗留项同前，未变。

台账：`miao-dock/docs/spec-notes.md` 的 **D-77**（引擎侧逐项验收见同仓 `docs/engine-e2e-acceptance-report.md` §2.9）。
