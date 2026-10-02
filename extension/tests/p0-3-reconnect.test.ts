/**
 * 单元测试 —— 《01》§6.4 **P0-3**「`taskId` 与页面生命周期解绑，按 `Last-Event-ID` 重连」。
 *
 * 这条规则有个反直觉之处：它看起来是「把 taskId 存进 storage」就完了，
 * 实际上 storage 只解决「刷新后还知道有这么个任务」；**事件流的恢复**是另一件事，
 * 而它才是真正会静默失效的地方 —— 因为流的持有者是 MV3 service worker，
 * SW 一被回收流就没了，且**不会再有任何错误回调**（死掉的 SW 无法通知任何人）。
 *
 * 因此本文件把三件事钉住：
 *   1. 看门狗的判据必须**大于**心跳间隔（否则把「健康但安静」误判为断连 → 重连风暴）
 *   2. 看门狗确实存在，且只在 `queued`/`running` 期间工作、用 `lastEventId` 续传
 *   3. 启动路径必须用 `lastEventId: null`（页面刷新要从 0 重放，否则回写会丢）
 *
 * 断言 2/3 采用「读源码 + 正则」的方式（与 `spec-geometry.test.ts` 验证 CSS 硬规则同法）：
 * 这两条是**编排层**的行为，纯函数单测覆盖不到，而真实验收在浏览器里跑（见 e2e）。
 */

import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { SSE_HEARTBEAT_MS, SSE_STALE_MS, SSE_WATCHDOG_TICK_MS } from '../src/types/contract';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, '..', rel), 'utf8');

const controllerSrc = read('src/panel/controller.ts');
const backgroundSrc = read('entrypoints/background.ts');

describe('《01》§6.4 P0-3 事件流恢复', () => {
  it('静默阈值必须**大于**心跳间隔 —— 否则会把「健康但安静」判成断连', () => {
    // 任务排队期间流上只有心跳（服务端每 15s 一条）。阈值 ≤ 15s 会持续误判 →
    // 每 20s 一次的重连风暴，既打服务端又刷日志。
    expect(SSE_STALE_MS).toBeGreaterThan(SSE_HEARTBEAT_MS);
    // 反证：若阈值取 10s（< 15s 心跳），安静排队 10s 就会被误判
    const badThreshold = 10_000;
    expect(badThreshold).toBeLessThan(SSE_HEARTBEAT_MS);
  });

  it('轮询间隔必须**小于**静默阈值 —— 否则会整段跳过判定点', () => {
    expect(SSE_WATCHDOG_TICK_MS).toBeLessThan(SSE_STALE_MS);
  });

  it('面板侧存在看门狗，且用 `lastEventId` 续传（不是从 0 重放）', () => {
    // 重新订阅这个动作本身会唤醒 SW —— 这是「面板做恢复驱动器」的关键前提
    expect(controllerSrc).toMatch(/'TASK_WATCH_START'/);
    expect(controllerSrc).toMatch(/lastEventId:\s*mirrorRef\.current\.lastEventId/);
    // 只在进行中盯着
    expect(controllerSrc).toMatch(/isActive\(mirrorRef\.current\.clientState\)/);
    // 健康但安静 → 不动；静默超时或已知断连 → 重连
    expect(controllerSrc).toMatch(/staleMs\s*<\s*SSE_STALE_MS/);
    expect(controllerSrc).toMatch(/eventsConnected\s*===\s*false/);
    // 重连后对账，补上断连窗口内的终态
    expect(controllerSrc).toMatch(/await refreshTask\(\)/);
  });

  it('`eventsConnected` 必须被**消费**，不能是只写不读的死信号', () => {
    // 历史上它只被 dispatch、无人读取 —— 这条断言防止再退化成死信号
    const reads = controllerSrc.match(/eventsConnected/g) ?? [];
    expect(reads.length).toBeGreaterThan(0);
    expect(controllerSrc).toMatch(/mirrorRef\.current\.eventsConnected/);
  });

  it('页面刷新必须从 0 全量重放（`lastEventId: null`）', () => {
    // 刷新后 DOM 回到原图 → 必须让服务端把所有 item 事件再推一遍，回写才会重做。
    // 若这里改成沿用持久化的 lastEventId，刷新后的回写会整批丢失。
    const startup = controllerSrc.slice(0, controllerSrc.indexOf('// ── 事件流推送'));
    expect(startup).toMatch(/'TASK_WATCH_START'/);
    expect(startup).toMatch(/lastEventId:\s*null/);
  });

  it('background 侧把 `lastEventId` 一路透传到 SSE 订阅', () => {
    expect(backgroundSrc).toMatch(/function startWatch\(tabId: number, taskId: string, lastEventId/);
    expect(backgroundSrc).toMatch(/lastEventId:\s*lastEventId\s*\?\?\s*null/);
    expect(backgroundSrc).toMatch(/case 'TASK_WATCH_START'/);
    expect(backgroundSrc).toMatch(/req\.lastEventId/);
  });
});
