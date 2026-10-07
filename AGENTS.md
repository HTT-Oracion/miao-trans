# AGENTS.md —— 本仓库的 AI 协作上下文（唯一入口）

> 本文件是**任何 AI 编程工具**进入本仓库时的**第一份必读**，不是给某一家工具专用的。
> · **WorkBuddy / CodeBuddy Code**：原生自动读取。项目主指引按 `CODEBUDDY.md` → `CODEBUDDY.mdc` → `AGENTS.md` → `AGENTS.mdc`
>   取**首个命中**（同目录只加载一份）⇒ **只要维护本文件就够了**。
> · **Trae / Cursor / Codex**：按各自的 `AGENTS.md` 约定读取（Trae 需在其「设置 → 规则」里手动打开「包含 AGENTS.md」）。
> · **Claude Code**：**不读** `AGENTS.md`，需另建 `CLAUDE.md` 并用 `@AGENTS.md` 导入本文件。
> ⚠️ **不要新建 `CODEBUDDY.md`** —— 它会让同目录的 `AGENTS.md` 不再被加载（遮蔽）。
> ⚠️ 保持精简：单份指引超过 **40000 字符会被整份丢弃**（不是截断）；桌面端首轮注入还会在 8000 字符处截断。
> 本文件是入口与硬约束，**完整事实源 = `README.md` + `docs/acceptance.md` + `docs/spec-notes.md`**；
> 三者冲突时以 `docs/spec-notes.md`（裁定与偏离留痕）为准，并把结论回写本仓库。

**工作语言：中文**（注释、提交信息、文档一律中文；代码标识符除外）。

---

## 1. 项目是什么

**喵译 MiaoTrans · 漫画就地翻译器（浏览器扩展端）** —— 在漫画网页上就地翻译：
悬浮球唤起面板 → 选图 → 提交本地 box-service → 译文直接替换网页原图。

| 层 | 技术 | 位置 |
|---|---|---|
| 扩展 | Chrome MV3，WXT 0.21 + React 18 + Redux Toolkit + AntD 5 | `extension/` |
| ├ 入口 | background（消息路由 / SSE / 抓图）· content（Shadow DOM 面板挂载） | `extension/entrypoints/` |
| ├ 领域层 | 契约映射 `types/` · box-service 客户端 `adapters/` · 命名管线 `naming/` · 计数与拦截 `selection/` · 客户端 8 态状态机 `domain/` · Redux `store/` · 面板 `panel/` · 回写与路由 `content/` | `extension/src/` |
| ├ 单测 | vitest（含规格几何钉死 / CSS 硬规则正则 / 静态资源完整性） | `extension/tests/` |
| └ 端到端 | 真实浏览器验收 | `extension/e2e/` · `e2e/` |
| 后端替身 | box-service 替身（**零第三方依赖**，仅 `node:*`） | `mock-service/` |
| 文档 | 验收报告 + 规格偏差台账 | `docs/` |

**目录硬规则**：

- **测试产物一律落 `.temp-translate-test/`（已 gitignore）** —— 真机联调会落盘几十 MB 的漫画原文/译文、
  box-service state、Playwright profile。**不要再往 `e2e/` 里写运行产物**。
- 契约是**逐条映射**的（`extension/src/types/`）：DTO / 15 个错误码 / SSE 事件一一对应《03》，
  改契约必须同步映射与断言，不允许"顺手多加一个字段"。

## 2. 工程纪律（本项目硬性要求，不得绕过）

1. **交付物必须自证，断言必须可反证。** 只跑正向等于没验证 —— 反证轮必须真的变红才算数。
   新增/修改断言时同时给出「破坏什么 → 哪一条变红」。
2. **分母写死并断言，跳过必须非零退出**（跳过 ≠ 通过）。单测有 `EXPECTED_CASE_COUNT` 与 `executed[]` 空转护栏，
   别绕过它 —— 比率型指标会吞掉分母变化。
3. **记忆不能当证据，要回读代码/文档。** 台账与实际不符时以实际为准，并回写台账。
4. **假阳性比没测试更危险。** 一条断言长期全绿却从未抓到过 bug，先怀疑它测错了东西。
5. **⚠️ 字面禁令会随实现演进而失配** —— 当断言挂在某个字符串上、而该字符串的**语义已经反转**时，
   **不许为转绿直接删断言**；改为**正向判据**（必须指向真实存在的文件 + 不得与旁路叙事同现 + 分母 > 0 防空转），
   再逐条反证变红。范例见 `docs/spec-notes.md` **D-08**。
6. **所有规格偏差 / 裁定 / 踩过的坑，记入 `docs/spec-notes.md`**（`D-xx` 编号接续，不重复编号）。
   这是跨工具、跨会话**唯一能共享的记忆**。
7. **不改写历史**：文档更新只加「变更横幅 / dated 追注」，**不覆盖旧结论、不动既有章节编号**
   （代码与注释大量引用《01》§x / 《03》§x 这类编号）。
8. **不引入未经确认的新依赖**；确需引入时，在提交信息与台账里写清代价。
9. **同族纪律（与 `miao-dock` 一致）**：不得出现历史上那批被禁的品牌标识 —— 需要提及时一律写「参考实现」，
   且**规则条文本身也不写出它**（否则"全仓扫描无命中"的纪律会被规则文件自己污染）。
10. **提交粒度**：`<type>(<scope>): 中文结论`；正文写「为什么 / 改了什么 / 刻意没做什么 / 验收结果」；
    关键节点独立成 commit。
11. **跨仓耦合只有一处**：插件侧**对引擎永久不可见**，唯一耦合点是 `miao-dock` 的
    `service/src/engine-client.mjs`。插件侧只解析《03》§2.3 的 `ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`。
    **E9 真机联调的台账写在 `miao-dock` 仓（D-77）**，不在本仓。

## 3. 验收命令（改完必须跑，绿色才算交付）

```bash
npm install            # 根 + extension（postinstall 装扩展依赖）
npm run build          # 构建扩展 → extension/.output/chrome-mv3
npm test               # 插件单测（vitest）—— 当前 226/226
npm run verify         # 端到端验收（自起 mock + 漫画页夹具 + 扩展浏览器）—— 当前 27/27
npm run mock           # 启动 mock box-service（默认 5180，打印配对令牌）
npm run page           # 启动漫画页夹具（5199，含「追加 8 张 / SPA 换页 / 整页导航」）
cd extension && npx tsc --noEmit && npx wxt build   # 类型检查 / 构建
```

**真机联调（插件 ↔ 真 box-service ↔ 真引擎，E9）** —— 不复用上面的 mock，自己拉起真进程并收尾：

```bash
npm run build
node e2e/e9-real-engine.mjs              # 真实漫画站 31 张，19 条断言，约 10 分钟
node extension/e2e/noservice-probe.mjs   # 「服务未就绪」路径，10/10（不启动 mock）
```

> 真机联调**先确认 5180 / 8000 / 8001 / 8080 无占用**；产物落 `.temp-translate-test/e9-<时间戳>/`，
> 证据同时写到 `miao-dock` 仓的 `docs/refs/engine/`。
> **改了断言覆盖的东西，就要同时更新断言** —— 断言里写死的路径不同步，后果是**静默跳过**，不是变红。

## 4. 当前状态与已知缺口

- ver1.0（漫画就地翻译）**已完成**；ver2.0 的 **S8 插件串联已完成** —— 插件侧只做必要衔接：
  解析 `ENGINE_NOT_READY` / `MODEL_DOWNLOAD_FAILED`，把「服务未就绪」扩为**未就绪 / 准备中**两态，
  并删除 ver1.0 遗留的演示旁路开关（服务缺席时不再放开渲染门控）。
- **当前基线**：单测 **226/226** · 端到端（mock）**27/27** · 「服务未就绪」路径 **10/10** ·
  真机 E9 **19/0** · `tsc --noEmit` 干净 · `wxt build` 通过。
- **历史的旧基线不改写**：ver1.0 完成时的 195/195、27/27 是当时事实，仍留在 `README.md` 里对照。
- 未做项与延后项（歌手详情类 UI、真实后端等）**以 `miao-dock` 台账与本仓 `docs/spec-notes.md` 为准** ——
  别把"类型检查 + 断言通过"当成"功能可用"。

## 5. 环境陷阱（踩过多次）

- **Chrome ≥137 禁用 `--load-extension`**：真实 Chrome 无法命令行加载未打包扩展 ⇒ e2e **必须**用
  Playwright 自带 Chromium（`channel: 'chromium'` 的新 headless 全量版；默认 headless shell 不支持扩展）。
  手动联调仍可用 `chrome://extensions` 开发者模式。参见 `docs/spec-notes.md` **D-05**。
- **真机联调端口**：5180（box-service）/ 8000（引擎）/ 8001（执行器）/ 8080（LLM）任一被占即失败，
  且残留孙进程会占住端口 —— 跑之前先确认无占用。
- **e2e 用 Playwright 浏览器**，首次运行可能需要下载浏览器二进制。

## 6. 外部方案文档（可能不在本机）

方案与设计稿在 `/Users/doro/WorkBuddy/Claw/插件与box ver1.0/`（**不在本仓库、不受版本控制**）：

| 文件 | 内容 |
|---|---|
| `01-插件-技术方案-ver1.0.md` | 插件端方案 |
| `03-翻译服务接口契约-ver1.0.md` | **SSOT** —— 接口契约（端口探测 / multipart / SSE / 错误码） |
| `02-Box-技术方案-ver1.0.md`、`00-决策纪要.md` | Box 侧方案与决策 |

> 现行口径的 **ver2.0 增量**在同级 `插件与box ver2.0/`（如《01》§4.5 选择上限、《03》§3 边界）。
> 若该目录不存在（换机器 / 换用户），**以本仓库 `docs/` 与代码为准**，并在台账里注明方案文档缺失。
> 在方案文档里改动时，**不要改动既有章节编号**。

## 7. 动手前的自检清单

- [ ] `git status` / `git log -1` 看过？基线是自己的吗？有没有并发写入者？
- [ ] 改的是哪一层？契约映射 / 单测 / e2e 需要同步吗？
- [ ] 断言改了吗？**反证能变红吗？**分母（`EXPECTED_CASE_COUNT`）钉死了吗？
- [ ] 有新决策 / 新坑吗？ → `docs/spec-notes.md` 留痕（编号接续）
- [ ] 跑过 §3 里受影响的验收命令吗？真机验证项是否已如实标注为"未验证"？
- [ ] 跨仓影响（`miao-dock` 的契约 / 台账 D-77 / `docs/refs/engine/`）同步了吗？
