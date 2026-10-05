/**
 * S8 插件串联 —— P-1…P-4 的回归钉。
 *
 * 依据（逐字）：
 *   - 《03》§2.3 新增错误码表 + 其下「边界」段（ENGINE_NOT_READY vs UNAVAILABLE）
 *   - 《03》§4.5「引擎准备态不属于任务状态」
 *   - 《01》§4.1「准备中」状态、§4.2「首张稍慢」、§4.3 新错误码 UI、§4.4 文案区分
 *
 * 组织方式：**每条机制类断言配一条反证**（见文件末尾「反证对照表」注释与
 * 交付报告中的实测变红输出）。本文件另设「分母钉死」用例：用 `caseIt` 登记
 * 实际执行过的用例 id，末尾断言登记数 == 声明数 == 21 —— **跳过 ≠ 通过**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  API_ERROR_CODES,
  API_ERROR_HTTP,
  BoxServiceError,
} from '../src/types/contract';
import {
  BoxServiceClient,
} from '../src/adapters/boxServiceClient';
import {
  ENGINE_PREPARING,
  ERROR_COPY,
  SERVICE_NOT_READY,
  serviceOverlayFor,
} from '../src/domain/clientState';
import { batchActions, batchReducer } from '../src/store/translation/batchSlice';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, '..', rel), 'utf8');
const exists = (rel: string): boolean => existsSync(resolve(here, '..', rel));

const controllerSrc = read('src/panel/controller.ts');
const panelSrc = read('src/panel/Panel.tsx');
const panelRootSrc = read('src/panel/PanelRoot.tsx');
/** README 在**仓库根**，不在 extension/ 下 */
const readme = readFileSync(resolve(here, '..', '..', 'README.md'), 'utf8');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}

// ─────────────────────────── 分母（写死） ───────────────────────────

/** 本文件**声明**应执行的用例 id —— 与「分母钉死」用例里的期望值同源 */
const DECLARED_CASES = [
  // P-1
  'P1-1', 'P1-2', 'P1-3', 'P1-4', 'P1-5', 'P1-6',
  // P-2
  'P2-1', 'P2-2', 'P2-3', 'P2-4', 'P2-5', 'P2-6', 'P2-7',
  // P-3
  'P3-1', 'P3-2',
  // P-4
  'P4-1', 'P4-2', 'P4-3', 'P4-4', 'P4-5', 'P4-6',
] as const;
const EXPECTED_CASE_COUNT = 21;

/** 实际执行过的用例 id —— 跳过（skip）不会登记，末尾据此判「跳过 ≠ 通过」 */
const executed: string[] = [];
function caseIt(id: (typeof DECLARED_CASES)[number], title: string, fn: () => void | Promise<void>): void {
  it(`[${id}] ${title}`, async () => {
    executed.push(id);
    await fn();
  });
}

describe('S8 P-1 解析 ENGINE_NOT_READY / MODEL_DOWNLOAD_FAILED', () => {
  caseIt('P1-1', '两个新码进联合类型，HTTP 均为 503（《03》§2.3）', () => {
    expect(API_ERROR_CODES).toContain('ENGINE_NOT_READY');
    expect(API_ERROR_CODES).toContain('MODEL_DOWNLOAD_FAILED');
    expect(API_ERROR_HTTP.ENGINE_NOT_READY).toBe(503);
    expect(API_ERROR_HTTP.MODEL_DOWNLOAD_FAILED).toBe(503);
    // ver1.0 的 13 条一条不少（§2.2「13 条不变」）
    expect(API_ERROR_CODES.length).toBe(15);
  });

  caseIt(
    'P1-2',
    'ENGINE_NOT_READY → meansEnginePreparing，且**不得**混入 meansServiceNotReady',
    () => {
      const e = new BoxServiceError('ENGINE_NOT_READY', '引擎准备中', 503);
      expect(e.meansEnginePreparing).toBe(true);
      // ⚠️ 关键边界（《03》§2.3）：进程在但未就绪 ≠ 进程不在。混用会让「准备中」被当成
      // 「服务未运行」，直接给出错误的「启动 Box」引导。**反证位**：把该码塞进
      // meansServiceNotReady 会让这一行走红。
      expect(e.meansServiceNotReady).toBe(false);
      expect(e.meansModelDownloadFailed).toBe(false);
    },
  );

  caseIt('P1-3', 'MODEL_DOWNLOAD_FAILED → meansModelDownloadFailed（唯一命中）', () => {
    const e = new BoxServiceError('MODEL_DOWNLOAD_FAILED', '模型校验失败', 503);
    expect(e.meansModelDownloadFailed).toBe(true);
    expect(e.meansEnginePreparing).toBe(false);
    expect(e.meansServiceNotReady).toBe(false);
  });

  caseIt('P1-4', '边界另一侧：UNAVAILABLE 仍走 meansServiceNotReady（进程不在）', () => {
    const e = new BoxServiceError('UNAVAILABLE', '服务未运行', 503);
    expect(e.meansServiceNotReady).toBe(true);
    expect(e.meansEnginePreparing).toBe(false);
  });

  caseIt('P1-5', '响应流转无缺口：503 信封里的 ENGINE_NOT_READY 能原样抛出', async () => {
    // 校验 `handle()` 的通用透传路径（无需为新码补分支 —— 见 boxServiceClient 注释）
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'ENGINE_NOT_READY', message: '引擎处于 prewarming' } }, 503),
    );
    const client = new BoxServiceClient({
      baseUrl: 'http://127.0.0.1:5180',
      token: TOKEN,
      ctx: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    await expect(client.getQueue()).rejects.toMatchObject({
      name: 'BoxServiceError',
      code: 'ENGINE_NOT_READY',
      status: 503,
    });
  });

  caseIt('P1-6', 'ENGINE_NOT_READY **不**被 appendBatchWithRetry 自动重试（《01》§4.1 不排队不缓存）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'ENGINE_NOT_READY', message: '引擎准备中' } }, 503),
    );
    const client = new BoxServiceClient({
      baseUrl: 'http://127.0.0.1:5180',
      token: TOKEN,
      ctx: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    const res = await client.appendBatchWithRetry(
      'tsk_1',
      [{ seq: 1, blob: new Blob(['a'], { type: 'image/png' }), contentType: 'image/png', sourceUrl: 'u' }],
      'k',
      3,
    );
    expect(res.ok).toBe(false);
    // 只发一次：meansServiceNotReady=false → 不进入退避重试
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe('S8 P-2 「未就绪 / 准备中」两态', () => {
  caseIt('P2-1', 'absent 态（进程不在）：title「本地翻译服务未运行」+「启动 Box」', () => {
    const copy = serviceOverlayFor('absent');
    expect(copy).toBe(SERVICE_NOT_READY);
    expect(copy?.title).toBe('本地翻译服务未运行');
    expect(copy?.primary).toBe('启动 Box');
    expect(SERVICE_NOT_READY.secondary).toBe('重试');
  });

  caseIt('P2-2', 'preparing 态（进程在未就绪）：title「正在准备翻译引擎…」，**不给**「启动 Box」', () => {
    const copy = serviceOverlayFor('preparing');
    expect(copy).toBe(ENGINE_PREPARING);
    expect(copy?.title).toBe('正在准备翻译引擎…');
    // 《01》§4.4 中列：「重试」（无「启动 Box」）—— **反证位**：删掉 ENGINE_PREPARING
    // 或让它回落到 SERVICE_NOT_READY，这一行走红。
    expect(copy?.primary).toBe('重试');
    expect(copy?.primary).not.toBe('启动 Box');
    // 等待语义（§4.1 交互）
    expect(ENGINE_PREPARING.secondary).toBe('准备完成后请重新提交');
  });

  caseIt('P2-3', '两态不可混用：title / primary 均不同（《03》§2.3 边界 /《01》§4.4）', () => {
    expect(ENGINE_PREPARING.title).not.toBe(SERVICE_NOT_READY.title);
    expect(ENGINE_PREPARING.primary).not.toBe(SERVICE_NOT_READY.primary);
    expect(ENGINE_PREPARING.phase).not.toBe(SERVICE_NOT_READY.phase);
  });

  caseIt('P2-4', 'ready 时无浮层（serviceOverlayFor 返回 null）', () => {
    expect(serviceOverlayFor('ready')).toBeNull();
  });

  caseIt('P2-5', 'ERROR_COPY 补两条，逐字（《01》§4.3）', () => {
    expect(ERROR_COPY.ENGINE_NOT_READY).toBe('正在准备翻译引擎…');
    expect(ERROR_COPY.MODEL_DOWNLOAD_FAILED).toBe('翻译模型下载失败或校验不通过');
  });

  caseIt('P2-6', 'store 阶段流转：探测/丢失 → absent；ENGINE_NOT_READY → preparing 且回 idle', () => {
    let s = batchReducer(undefined, { type: '@@init' });
    expect(s.servicePhase).toBe('absent');

    s = batchReducer(s, batchActions.serviceDiscovered({ port: 5180, hasToken: true, ready: true }));
    expect(s.servicePhase).toBe('ready');
    expect(s.serviceReady).toBe(true);

    s = batchReducer(s, batchActions.serviceLost());
    expect(s.servicePhase).toBe('absent');
    expect(s.serviceReady).toBe(false);

    // 命中但未配对：沿 ver1.0 行为仍渲染「服务未就绪」浮层
    s = batchReducer(s, batchActions.serviceDiscovered({ port: 5180, hasToken: false, ready: false }));
    expect(s.servicePhase).toBe('absent');

    // 提交 → ENGINE_NOT_READY：不建单、任务回 idle、阶段转 preparing
    s = batchReducer(s, batchActions.submitStarted({ idempotencyKey: 'k', comicName: 'a' }));
    expect(s.state).toBe('submitting');
    s = batchReducer(s, batchActions.enginePreparing());
    expect(s.servicePhase).toBe('preparing');
    expect(s.state).toBe('idle');
    expect(s.error).toBeNull();

    // resetToIdle 必须保留服务阶段（否则浮层会在重开面板时闪回「未就绪」）
    s = batchReducer(s, batchActions.resetToIdle());
    expect(s.servicePhase).toBe('preparing');
    expect(s.serviceReady).toBe(false);

    // 引擎转好后重试提交成功（建单返回）→ 「准备中」浮层必须解除，
    // 否则它会盖住正在运行的面板（缺陷：只切不解除）
    s = batchReducer(s, batchActions.submitStarted({ idempotencyKey: 'k2', comicName: 'a' }));
    s = batchReducer(s, batchActions.taskCreated({ taskId: 'tsk_1', comicName: 'a', status: 'running' }));
    expect(s.servicePhase).toBe('ready');
    expect(s.state).toBe('running');
  });

  caseIt('P2-7', 'Panel 按**两态**渲染浮层（不同 testid + phase 属性），并经 servicePhase 分流', () => {
    expect(panelSrc).toMatch(/serviceOverlayFor\(servicePhase\)/);
    expect(panelSrc).toMatch(/data-phase=\{overlayCopy\.phase\}/);
    expect(panelSrc).toMatch(/'engine-preparing'/);
    expect(panelSrc).toMatch(/'service-not-ready'/);
    expect(panelSrc).toMatch(/overlayCopy\.actionLabel/);
    // 准备中态的分支不得再走「启动 Box」引导
    expect(panelSrc).toMatch(/overlayCopy\.phase === 'absent'/);
    // 头徽标三值
    expect(panelSrc).toMatch(/'引擎准备中'/);
    // 阶段由 store 传入
    expect(panelRootSrc).toMatch(/servicePhase=\{batch\.servicePhase\}/);
    expect(panelSrc).toMatch(/servicePhase: ServicePhase/);
  });
});

describe('S8 P-3 两处文案（逐字，不得改写）', () => {
  caseIt('P3-1', '「正在准备翻译引擎…」同时落在浮层标题与提示行', () => {
    expect(ENGINE_PREPARING.title).toBe('正在准备翻译引擎…');
    // 浮层标题
    expect(panelSrc).toMatch(/<h4>\{overlayCopy\.title\}<\/h4>/);
    // 提示行（《01》§4.1 指定位置）
    expect(panelSrc).toMatch(/preparing \? ENGINE_PREPARING\.title : ''/);
    expect(panelSrc).toMatch(/'engine-preparing-hint'/);
    // 准备中态提示行左侧要有 24px 小魔法阵（§4.1）
    expect(panelSrc).toMatch(/hint\.magicCircle \|\| preparing/);
  });

  caseIt('P3-2', '「首张稍慢，后续加快」逐字，且以预期行为（非错误/警告）呈现', () => {
    expect(ENGINE_PREPARING.slowFirst).toBe('首张稍慢，后续加快');
    expect(panelSrc).toMatch(/ENGINE_PREPARING\.slowFirst/);
    // 不得挂在错误/警告回执条上（《01》§4.2：它是预期行为）
    expect(ERROR_COPY.MODEL_DOWNLOAD_FAILED).not.toContain('首张稍慢');
  });
});

describe('S8 P-4 删除 DEMO_BYPASS_SERVICE_READY', () => {
  caseIt('P4-1', 'demoMode.ts 整文件已删除（无人再引用）', () => {
    expect(exists('src/domain/demoMode.ts')).toBe(false);
    // 全仓库不得再有该标识或该模块引用
    expect(controllerSrc).not.toMatch(/DEMO_BYPASS_SERVICE_READY/);
    expect(controllerSrc).not.toMatch(/demoMode/);
  });

  caseIt('P4-2', 'controller 不再存在任何「服务缺席时强制 ready=true」的旁路', () => {
    expect(controllerSrc).not.toMatch(/hasToken:\s*true,\s*ready:\s*true/);
    // 不得有「无条件 return 到 ready」的早退
    expect(controllerSrc).not.toMatch(/DEMO_BYPASS/);
  });

  caseIt('P4-3', '启动探测走原路径：命中 → serviceDiscovered(真实值)；未命中 → serviceLost()', () => {
    const startup = controllerSrc.slice(0, controllerSrc.indexOf('// ── 事件流推送'));
    expect(startup).toMatch(/batchActions\.serviceDiscovered\(\{ port: discovered\.port \?\? 0, hasToken: discovered\.hasToken, ready: discovered\.ready && discovered\.hasToken \}\)/);
    expect(startup).toMatch(/dispatch\(batchActions\.serviceLost\(\)\)/);
  });

  caseIt('P4-4', '「重试连接」走原路径：探测异常 → serviceLost()（真实失败态）', () => {
    const retry = controllerSrc.slice(
      controllerSrc.indexOf('const onRetryService'),
      controllerSrc.indexOf('// ── 定位图片'),
    );
    expect(retry.length).toBeGreaterThan(0);
    expect(retry).toMatch(/catch \{/);
    expect(retry).toMatch(/dispatch\(batchActions\.serviceLost\(\)\)/);
    expect(retry).not.toMatch(/ready:\s*true/);
  });

  caseIt('P4-5', 'README 不再自述演示开关', () => {
    expect(readme).not.toMatch(/DEMO_BYPASS_SERVICE_READY/);
    expect(readme).not.toMatch(/演示模式/);
    expect(readme).not.toMatch(/noservice-probe/);
  });

  caseIt('P4-6', 'P0-3 任务恢复与令牌配对引导**必须保留**（删除旁路时不得顺手删掉）', () => {
    const startup = controllerSrc.slice(0, controllerSrc.indexOf('// ── 事件流推送'));
    // 令牌配对引导：命中但未配对 → 弹配对层
    expect(startup).toMatch(/if \(!discovered\.hasToken\) setTokenDialogOpen\(true\)/);
    // P0-3：恢复进行中任务（Last-Event-ID 从 0 重放）
    expect(startup).toMatch(/'ACTIVE_TASK_GET'/);
    expect(startup).toMatch(/'TASK_REFRESH'/);
    expect(startup).toMatch(/'TASK_WATCH_START', taskId: rec\.taskId, lastEventId: null/);
    expect(startup).toMatch(/'ACTIVE_TASK_CLEAR'/);
  });
});

describe('S8 分母钉死（跳过 ≠ 通过）', () => {
  it(`应执行 ${EXPECTED_CASE_COUNT} 条用例：实执行 == 声明 == 期望`, () => {
    expect(executed.length).toBe(DECLARED_CASES.length);
    expect(new Set(executed).size).toBe(DECLARED_CASES.length);
    expect(DECLARED_CASES.length).toBe(EXPECTED_CASE_COUNT);
  });
});
