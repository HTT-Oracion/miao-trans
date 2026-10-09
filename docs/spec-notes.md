# 规格偏差与裁定记录（D 系列）

开发/验收过程中发现《插件与 box ver1.0》方案文档自身的问题。均按「文档问题不擅自改文档，实现按裁定执行，断言钉死」处理，**留待下一轮文档修订**。

## D-01 《03》§7.3 阅读顺序：公式与散文不等价

- 原文：公式 `rowBucket = floor(top / 8)`，正文又说「top 差值 < 8px 视为同一行」。
- 矛盾：跨桶边界时两者结论相反（top=100 与 top=108：公式分属 12/13 两桶；散文判同行）。
- 裁定：**按公式实现**。理由：公式是规范性表述；「差值 < 8」作为比较器不满足传递性，喂给 `sort` 结果依赖引擎实现。
- 钉死：`tests/naming.test.ts` 含全序性（自反/反对称/传递）断言。

## D-02 《03》§2.2 DISK_FULL(507) 自相矛盾

- 原文：HTTP 错误码 507，但「客户端处理」列写「item 标 saved:false，任务继续」——HTTP 错误不可能同时不阻断主路径。
- 裁定：双路径并存。item 级落盘失败 → HTTP 200 + `saved:false` + 任务继续（可执行的那一半）；请求级落盘不可用 → 真正的 `507 DISK_FULL`（`POST /tasks` 探测 root 可写性）。
- 实现：mock-service 双路径均有，回归脚本可测。

## D-03 《03》§6.1/§8.2 漫画名「不含 `..`」字面与意图冲突

- 矛盾：§6.1 步骤 3 已把 `/ \ :` 全部剥离，归一化后路径穿越不可能；字面执行「含 `..` 即拒」会误杀 `a..b` 这类合法名。
- 裁定：按**路径成分**判定（存在成分恰好等于 `..` 或 `.` 才拒），校验在归一化后、请求校验期断言（403 PERMISSION_DENIED），落盘前再断言一次（不信任上游）。

## D-04 《01》§5.1「两个动作」与按钮 disabled 的隐含冲突

- 发现：e2e 实测——若把「超出上限」的确定按钮一并 disabled，§5.1 要求的「两个动作」（裁剪/分批弹层）永远不可达。
- 裁定：硬拦的定义是「拦截网络请求 + 给出两个动作」。over-limit 时按钮保持可点，点击转为打开弹层；empty / name-missing 才锁死按钮。e2e I3 钉死「弹层出现且队列无请求」。

## D-05 Chrome ≥137 禁用 `--load-extension`（环境事实）

- 影响：真实 Chrome 无法命令行加载未打包扩展，e2e 必须用 Playwright 自带 Chromium（`channel: 'chromium'`，新 headless 全量版；默认 headless shell 不支持扩展）。
- 记录于此供后续迭代参考；手动联调仍可用 `chrome://extensions` 开发者模式。

## D-06 悬浮球 / 面板拖拽交互模型修订（本轮用户裁定，文档已同步）

- 变更：面板与悬浮球**各自独立拖动**；**仅点击**悬浮球展开（拖动手势不展开）；两者**显示互斥**（展开态不渲染球）；收起时球位**由面板位置反算**（同侧、间距 12、底边对齐、clamp），保证「拖面板 → 收起 → 再展开」回到同一面板位置。
- 顺带修复的实现缺陷：拖动/点击判定读的是 pointerup 后已清空的状态，click 恒判「未拖动」→ 拖球会顺带展开面板。修法：抬手时快照 `moved`（`createDragTracker`），单测回归钉死。
- 文档同步：《01》§6.1 / §6.2 / §12 已按新模型改写；「点击面板外收起」一并取消（互斥显示下面板即工作区，页面点选会误收起），收起入口收敛为面板头按钮 + Esc。
- 钉死：`tests/panel/drag.test.ts`（判定器 6 条 + clamp/锚定/反算往返 14 条）、`e2e/panel-drag-probe.mjs`（真实浏览器 16 条）。

## D-07 选择上限 50 与单批上限 20 解耦（本轮用户裁定，文档已同步）

- **变更**：用户**最多勾选 50 张**（新常量 `SELECT_LIMIT`）；**单批仍是 20 张**（`BATCH_LIMIT`，契约值不动）。提交时按阅读顺序自动切成 20 / 20 / **10** 三批、追加到**同一任务** —— 切批是纯内部行为，早已实现，本轮**不新增任何排队机制**。
- **删掉「分批提交」这个用户动作**（`OVER_LIMIT_ACTIONS` 由 2 项收敛为 1 项）：20–50 是**正常区间**，教用户"可以分批提交"反而让他以为自己得动手。弹层只剩「取消勾选（回到 50 张内）」。
- 计数三态随之改：`≤49` / `=50`（已达**选择**上限）/ `>50`；且**三档都显示「分布于 N 页」**（选满 50 必然跨页，页数从锦上添花变成必要信息）。
- **拆掉的设计支点**：`tests/selection.test.ts` 原先刻意让「选择上限 == 网格每页 == 单批上限 == 20」（"一页刚好一批"）。现**只拆选择上限**：`GRID.perPage === BATCH_LIMIT` 这条**几何事实保留**（`tests/spec-geometry.test.ts` 仍在守它），另立 `SELECT_LIMIT`。
- 50 **不是** 20 的整数倍（末批 10 张）—— 这不是笔误，是要求的一部分；`expect(SELECT_LIMIT % BATCH_LIMIT).not.toBe(0)` 专门钉它。
- **明确不改**：服务端 `BATCH_LIMIT`、`GRID.perPage`、"按阅读顺序全局排序后再切批"（`seq` 连续性的唯一保证）。`BoxServiceClient.createTask/appendBatch` 的 20 张守卫是**单批**纵深防御，**同步保留**（它不是选择守卫）。
- 新增 / 修改：`src/types/contract.ts`（+`SELECT_LIMIT`）· `src/selection/rules.ts`（三处默认 limit、动作表、三态文案）· `src/panel/controller.ts`（批大小改用 `BATCH_LIMIT` 常量、`onOverLimitAction` 收敛）· `src/panel/Panel.tsx`（超限副行）· `src/domain/clientState.ts`（`BATCH_LIMIT_EXCEEDED` 文案改「单批上限 20 张」）· 三个测试文件（+4 条断言）。
- **反证**（各真跑变红后按 shasum 还原）：`SELECT_LIMIT → 20` ⇒ selection / spec-geometry **6 条红**；`SELECT_LIMIT → 40` ⇒ 「50 不是 20 的整数倍」**1 条红**。
- 规格同步：ver1.0《01》§5 加变更横幅（**不改写历史**）；ver2.0《01》新增 **§4.5**（现行口径）；ver2.0《03》§3 补边界说明。
- ⚠️ **既有红（非本轮引入）**：`tests/s8-engine-states.test.ts` 的 **P4-5** 断言 README 不得出现 `noservice-probe`，而 `6c1d60a` 又把该命令写进 README。该断言是 `a1d8aa5` 删除演示旁路时立的（当时 `noservice-probe` 挂在"演示模式"叙事上），现在这条命令是**合法测试入口**（10/10）。判据已随实现演进失配，**待裁定**：收窄断言 / 或撤掉 README 那行。

## D-08 P4-5 收窄：「README 不得自述演示开关」≠「README 不得提及 noservice-probe」（2026-10-07）

- **背景**：D-07 末尾登记的那条既有红。`tests/s8-engine-states.test.ts` 的 P4-5 原有三条断言，前两条禁 `DEMO_BYPASS_SERVICE_READY` / `演示模式`（**护栏本意**：不许宣传"可绕过真服务、假装就绪"），第三条 `not.toMatch(/noservice-probe/)` 是随"演示模式"叙事一并立下的（`a1d8aa5`），而 `6c1d60a` 又把这条命令当**合法测试入口**写回 README（`extension/e2e/noservice-probe.mjs`，10/10）。⇒ 第三条的字面判据**已随实现演进而失配**：它现在禁掉的是一条真实验收。
- **裁定（用户拍板：收窄断言）**：第三条不再作字面禁令，改为**正向**判据 ——
  ① README 必须保留这条入口的说明（`probeLines.length > 0`，杜绝"数组为空 ⇒ 循环空转 ⇒ 静默通过"，即跳过≠通过）；
  ② 文档里写的入口路径必须**真实存在**（从每行抓 `*noservice-probe.mjs`，剥掉 `extension/` 前缀后在 `extension/` 下 `existsSync`）；
  ③ 该入口不得与旁路 / 假装就绪叙事同现（`旁路|绕过|跳过真服务|假装|bypass|fake`）。
  前两条护栏**一字未改**。**没有删除任何断言** —— 正向版严格强于"删掉这一行"。
- **顺带修掉一处文档缺陷**：README 里同一脚本两种路径写法（§运行 是 `extension/e2e/noservice-probe.mjs`，验收表是 `e2e/noservice-probe.mjs`）⇒ 统一为**可执行**的那一种。
- **反证 3 条**（各真跑变红后按 shasum 还原，README 哈希 `35d2f8ab7f0f3328c4ce86a13ea1a7d9a74a8668a6a7188bd56aa95b6ec4bb1e` 前后一致）：
  A. 路径改成 `extension/e2e/old/noservice-probe.mjs` ⇒ 红（判据②「必须真实存在」，报错原文带出该路径）；
  B. 该行注释改成"可直接旁路真服务" ⇒ 红（判据③）；
  C. 全文 `noservice-probe` → `ns-probe` ⇒ 红（判据① 空转护栏）。
- **结果**：插件单测 **205/205**（原 204/205）。**用例条数不变** —— 只改 P4-5 的断言体，`EXPECTED_CASE_COUNT` 仍 **27**。
- 修改文件：`extension/tests/s8-engine-states.test.ts`（P4-5 断言体 + 注释）· `README.md`（路径统一 + 反证行补记）· 本文件。

## D-09 新增仓库级通用入口 `AGENTS.md`（跨工具可读，2026-10-07）

- **背景**：本仓此前只有 `README.md` 作说明，**没有任何"AI 工具进入本仓时会被自动读取的入口"**；
  而姊妹仓 `miao-dock` 已有 `AGENTS.md` + `.trae/rules`。两仓规范入口不对称 ⇒ 新会话 / 新接手者进本仓时缺硬约束入口。
- **裁定**：新增仓库根 `AGENTS.md` 作为**唯一入口**；并**刻意不新增** `CODEBUDDY.md` ——
  在 WorkBuddy / CodeBuddy Code 里，项目主指引按 `CODEBUDDY.md` → `CODEBUDDY.mdc` → `AGENTS.md` → `AGENTS.mdc`
  取**首个命中**，多建 `CODEBUDDY.md` 会让同目录 `AGENTS.md` **不再被加载**（遮蔽）。只维护 `AGENTS.md` 反而能被原生读取。
- **覆盖面（已核实）**：WorkBuddy / CodeBuddy Code 原生读取；Trae / Cursor / Codex 亦按 `AGENTS.md` 约定读取；
  **Claude Code 不读 `AGENTS.md`**（需 `CLAUDE.md` 导入）。本仓暂无 `CLAUDE.md` / `.github/copilot-instructions.md`（按需再补）。
- **体量约束**：单份指引 > **40000 字符会被整份丢弃**（非截断）；桌面端首轮注入还在 **8000 字符**处截断。
  ⇒ 本文件控制在 **5336 字符**，细节一律指向事实源（README / acceptance.md / 本台账）。
- **验证**：新增文件后 `npm test` 仍 **205/205**（P4-5 只读根 `README.md`，`assets-integrity` 只扫资源目录，均不受影响）。

## D-10 「定位图片」失效修复 + 新增 zip 导出（2026-10-07）

> 本轮是**用户报障驱动**（原话：导出功能没有生效，定位图片的功能也没有生效），不是文档问题；
> 记在此处是因为两处都踩到了「契约口径 vs 用户口述」与「只在浏览器里才暴露的失效」两类坑，需要留档。

### 10.1 定位：三个独立原因叠在一起，缺一都还是「点了没反应」

- **① 高亮被站点 CSS 吃掉**。旧实现写普通内联样式 `element.style.outline = '2px solid #FF8FBF'`，
  站点只要有一条 `img { outline: none }` 就能盖掉它 —— 用户看到的就是完全无反应。
  改法：`element.style.setProperty('outline', v, 'important')`。
  ⚠️ 断言侧配套陷阱：`getPropertyValue()` **不含**优先级，必须用 `getPropertyPriority()` 读，否则反证轮会假绿。
- **② 首帧要等 300ms**。旧实现的闪烁定时器第一拍在 300ms 后才描边，期间无任何视觉反馈。
  改法：进入后**立即**画一帧（`paint(true)`），再起闪烁。
- **③ 元素引用失效就直接 disabled**。抓取时存下的是 `HTMLImageElement` 强引用；SPA 节点回收后
  `isConnected === false`，旧逻辑此时把定位按钮置灰 —— 而仓库里本来就有抗 DOM 复用的
  `findImageByExpectedUrl`，**定位这条路径一直没接上它**。
  改法：新增 `resolveLocateTarget(element, expectedUrl)` 两级兜底 —— ① 引用仍有效 → 直接用；
  ② 引用失效 → 按 `expectedUrl`（抓取那一刻的 `currentSrc`）重新在 DOM 里找；③ 都没有 → `null`。
  `Panel.tsx` 的 `registryElementConnected` 同步改用它，按钮不再因引用失效而无故置灰。
- **顺带**：`locateImage` 返回值 `void → boolean`，`scrollIntoView` 外包 try/catch 兜 `window.scrollTo`
  （jsdom / 部分页面无 `scrollIntoView`）。命中后给出成功提示「已定位到该图（页面已滚动并高亮 1.2 秒）」，
  两级都落空时提示「该图已不在页面上」—— 旧实现**无论成败都不吭声**，也是「没反应」观感的来源之一。

### 10.2 导出：此前是纯占位，本轮落地为真导出

- **原状**：Panel 的「导出」按钮只 `setNotice('导出功能待接入')`，**没有任何网络/落盘动作**（真占位）。
- **落地语义（用户裁定）**：导出**原图 + 译文（如有）**为一个 zip，缺译文是**正常状态**，只回报不中断。
- **命名口径偏差（需留档）**：用户口述是「`01` / `01_translate`」，实现按《03》§7.2 契约落为
  **`001` / `001_translated`** —— 依据：① `SEQ_PAD = 3`；② `parseSeqFromFileName` 的正则
  `/^(\d{3})(?:_translated)?\.…$/` **硬要求三位且后缀必须是 `_translated`**。
  若照口述写两位 + `_translate`，落盘名会被命名层**反解析不出序号**，续编号（§7.4）随之错乱。
  扩展名由响应 MIME 反查（jpg/webp/png），与 §7.2 一致。
- **零新增依赖**：自写 **STORE 模式** zip 打包器 `src/zip/storeZip.ts`（local header / central directory / EOCD + CRC32）。
  理由：图片字节本身已被 JPEG/PNG/WebP 压过，再 deflate 收益近乎为零，却要为此引入一个打包依赖
  （AGENTS.md §2.6：新增依赖需确认）。文件名含中文，故 general purpose bit 11（UTF-8）置位。
- **链路**：`TASK_EXPORT_ZIP`（新增消息类型）→ background 串行 `fetchLibraryFile` 取原图/译文字节 →
  打包 → `browser.downloads.download({ saveAs: false })`。结果回报 `{files, missingTranslated[], failed[], bytes}`，
  面板据此提示「已导出 N 个文件（M 张缺译文）」。blob URL **延迟 60s 再 revoke**（下载是异步的，过早释放会拿到 0 字节）。
- **权限**：`downloads` 早在 `wxt.config.ts:31` 声明，本轮**未动权限清单**。

### 10.3 钉死与反证

- `tests/dom/locate.test.ts`（**新增 10 条**，分母 `EXPECTED_CASE_COUNT = 6`）：L1 命中返回 true + `important` 优先级 + 2s 后自动清除描边；
  L2 离场返回 false 且不抛；L3/L4/L5 三级 `resolveLocateTarget`；L6 `scrollIntoView` 抛错时兜底 `window.scrollTo` 且仍算成功。
  反证 R1（回填普通样式 ⇒ 无 `important`）/ R2（退回只用引用 ⇒ 引用失效时返回 null）/ R3（按位置找会命中错的节点）。
  ⚠️ 环境事实：jsdom 会把 `img.src` 解析成**绝对地址**，写相对路径做期望值比对会假红。
- `tests/zip/storeZip.test.ts`（**新增 11 条**，分母 `EXPECTED_CASE_COUNT = 8`）：逐字段钉死签名 / 偏移 / CRC / 标志位。
  设计理由：zip 是**二进制**结构，写错一个偏移量不会抛异常，只会产出「下载成功但解压报损坏」的包 —— 典型静默失败。
  Z7 用**独立解析路径**（自建 `u16/u32` little-endian 读，不复用实现）把数据按字节读回比对。
- **独立第三方校验（不自检）**：把实现产出的字节落盘后交给 **Python `zipfile`** 验：`testzip()` 返回 None、
  `namelist()` 中文路径正确、`compress_type == 0`（STORE）。防止「解析器与实现一起错」的假绿。
- **结果**：`tsc --noEmit` 通过；`npm test` **226/226**（原 205，净增 21）。
- **反证可复现性**：上述反证均为**断言式反证**（在测试内构造旧写法，断言其不满足正证判据），
  无需改动实现源码即可复现，规避「改回旧代码后再还原」的 shasum 依赖。

### 10.4 修改文件

- `src/content/writeback.ts`（`locateImage` 返回 boolean + `!important` + 首帧 + `scrollIntoView` 兜底 + 新增 `resolveLocateTarget`）
- `src/panel/controller.ts`（`onLocate` 改两级兜底 + 成败提示；新增 `onExport` / `exporting` / `ExportZipResult`）
- `src/panel/Panel.tsx`（`registryElementConnected` 改两级兜底；导出按钮接真实动作 + 导出中态）
- `src/types/messages.ts`（新增 `TASK_EXPORT_ZIP`）
- `entrypoints/background.ts`（新增导出分支 + `extOf()`）
- 新增：`src/zip/storeZip.ts` · `tests/zip/storeZip.test.ts` · `tests/dom/locate.test.ts`
- 本文件（D-10）

> ⚠️ 本轮**未提交 lock 文件改动**：`npm install` 顺带删掉了 `extension/package-lock.json` 里
> 512 行其他平台的 optional 依赖（环境噪音，与本次修复无关），已 `git checkout` 还原。

## D-11 插件端「翻译方向」贯通（ver2.1 英译中，2026-10-09）

> 用户需求驱动（原话：让本机漫画支持英译中）。插件侧只加一根**建单参数**，不改任何契约 DTO ——
> 方向早在《03》§5.2 的 `CreateTaskPayload.lang` 里预留（**契约层零改动**）。

### 11.1 方向是建单参数，不是全局设置

- 引擎默认档只做日译中；英文漫画必须由服务端按方向切到离线 `nllb`（见 `miao-dock` 的
  `service/src/config.mjs::buildEngineConfig`）。方向随建单下发，**逐任务**生效。
- 服务端对非法方向**硬拒**（400 `INVALID_TRANSLATE_LANG`），**不静默回落**。理由：静默回落会让
  英文漫画整页原文照抄（引擎侧「identical to original」逐行过滤掉），用户看到的是一堆没翻译的图
  而不是报错，排障成本远高于一次显式报错。
- 白名单只有两条（日译中 / 英译中），与 `miao-dock` 的 `TRANSLATE_DIRECTIONS` **逐条对齐**；
  插件不给自由输入。两侧漂移的后果：插件发出的方向被服务端判非法 → 提交报错。

### 11.2 控件放在工具条，不为它加高面板

- 面板几何（680）与七屏一致性是硬约束（`tests/spec-geometry.test.ts` 钉死），因此方向分段控件
  塞进**已有工具条的剩余空间**（`flex-shrink:0`，高度 ≈20 ≤ 工具条 44），不新开分区、不改任何分区高度。
- 只在**选图态**出现：方向是建单参数，任务提交后不可改（要改就得新任务）。
- 默认日译中；`resetToIdle`（任务完成回选图态）**保留**方向 —— 否则英文用户每轮都要重选。

### 11.3 钉死与反证

- `tests/direction.test.ts`（**新增 8 条 + 1 条分母门**，`EXPECTED_CASE_COUNT = 8`）：
  D1 白名单对齐；D2 默认值单一来源；D3 `sameDirection` 双键判定 + 未知方向回落；D4 防共享引用；
  D5 `resetToIdle` 保留；D6/D8 直接在 **multipart 的 payload** 上取证 `lang`；D7 未选方向时 payload
  **无** `lang` 键（守旧客户端零改动）。反证 5 条全部真跑变红：M1 删白名单 en / M2 `sameDirection` 恒真 /
  M3 共享 action payload / M4 `resetToIdle` 去保留 / M5 formdata 剔 lang。
  ⚠️ **D4 首版写成 `not.toBe(DEFAULT_DIRECTION)` 恒真**（共享的是 action payload 而非常量）⇒ M3 假绿；
  改为 `not.toBe(payload)` 后 M3 真红。**断言测错对象 = 假绿**，此处留档。
- `e2e/verify.mjs` 新增 **K1 / K2**（+2 → **30/30**）：K1 断分段控件可见且可切换（`aria-pressed` 三值）；
  K2 **不看 UI**，直接读 mock 落盘的任务清单 `<MOCK_STATE_DIR>/tasks/<taskId>.json` 的 `lang` 字段，
  证明「插件选的英译中真的到了服务端」。反证 3 条真跑变红：M6 控件不可见 → K1 红；M7 controller 不带
  lang → K2 红；M8 background 丢 `req.lang` → K2 红。
  ⚠️ **M6 首版用 HTML `hidden` 属性无效**：作者样式 `.mt-dirseg{display:inline-flex}` 压过 UA 的
  `[hidden]{display:none}`，元素照样可见 ⇒ 假绿。改用**行内** `display:none` 才真红。
  ⇒ 凡「隐藏元素」类反证，**一律用行内样式**。

### 11.4 顺带修掉 e2e 的失效断言（D-07 遗留）

- `verify.mjs` 的 H3 / I1 / I2 仍写着「第 21 张即越限、提交被硬拦」—— 这是**上限 20 时代**的口径。
  D-07 把上限抬到 50 后**已失效**：21 张属正常区间，提交不再被拦，于是永远等不到超限弹层，整个 e2e
  在 I2 超时中断（⚠️ 即 **AGENTS/README 里「27/27」是失效声明**，HEAD 上基线长期是红的）。
- 裁定：按当前口径**重写**（不删）。H3 改判 20 张为 normal；I 段改为先把素材堆到 52 张（**追加 4 次**，
  素材页初始 20 张而非 28）再「逐张 + 全选本页 + 翻页」凑到真越限（>50），恢复对「软拦边界 / 提交硬拦 /
  拦截时不发请求 / 裁剪动作」的完整覆盖。修完 e2e **30/30** 真绿。

### 11.5 修改文件

- 新增 `src/domain/direction.ts`（白名单 / 默认值 / 等价判定 / 文案回落）
- `src/store/translation/batchSlice.ts`（`direction` 状态 + `directionChanged` + `resetToIdle` 保留）
- `src/store/translation/index.ts`（`selectDirection`）
- `src/panel/Panel.tsx`（工具条内方向分段控件）· `src/panel/panel.css`（`.mt-dirseg`，不加高）
- `src/panel/controller.ts`（mirror 加 `direction` + `directionRef` + `doSubmit` 带 `lang`）
- `src/types/messages.ts`（`TASK_SUBMIT` 加 `lang?`）· `entrypoints/background.ts`（透传 `req.lang`）
- 新增 `tests/direction.test.ts` · `tests/boxServiceClient.test.ts`（旧断言标题按 ver2.1 更新口径）
- `e2e/verify.mjs`（K1/K2 新增 + H3/I 段按 D-07 口径重写）
