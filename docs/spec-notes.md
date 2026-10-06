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
