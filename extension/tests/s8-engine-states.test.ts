/**
 * S8 插件串联 —— P-1…P-4 的回归钉（含 fix 轮：两处口径落错 + details 接缝）。
 *
 * 依据（逐字）：
 *   - 《03》§2.3 新增错误码表 + 其下「边界」段（ENGINE_NOT_READY vs UNAVAILABLE）
 *   - 《03》§4.5「引擎准备态不属于任务状态」
 *   - 《01》§4.1「准备中」状态（提示行 + **按阶段**的副行）
 *   - 《01》§4.2「首张稍慢」（**running 且第 1 张**，进度条下方一行）
 *   - 《04》§5.3 / 《09》L4 交叉印证同一判据
 *
 * 组织方式：**每条机制类断言配一条反证**（见交付报告中的实测变红输出）。
 * 本文件另设「分母钉死」用例：`caseIt` 登记实际执行过的用例 id，
 * 末尾断言登记数 == 声明数 == 27 —— **跳过 ≠ 通过**。
 */

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import {
  API_ERROR_CODES,
  API_ERROR_HTTP,
  BoxServiceError,
  ENGINE_PREPARING_STATES,
  enginePreparingStateOf,
} from '../src/types/contract';
import { BoxServiceClient, subscribeTaskEvents } from '../src/adapters/boxServiceClient';
import {
  ENGINE_PREPARING,
  ERROR_COPY,
  PREPARING_SUBLINE,
  SERVICE_NOT_READY,
  SLOW_FIRST_IMAGE_HINT,
  preparingSubline,
  serviceOverlayFor,
  showsSlowFirstImageHint,
} from '../src/domain/clientState';
import { batchActions, batchReducer } from '../src/store/translation/batchSlice';

const here = dirname(fileURLToPath(import.meta.url));
const read = (rel: string): string => readFileSync(resolve(here, '..', rel), 'utf8');
const exists = (rel: string): boolean => existsSync(resolve(here, '..', rel));

const controllerSrc = read('src/panel/controller.ts');
const panelSrc = read('src/panel/Panel.tsx');
const panelRootSrc = read('src/panel/PanelRoot.tsx');
const panelCss = read('src/panel/panel.css');
const backgroundSrc = read('entrypoints/background.ts');
const messagesSrc = read('src/types/messages.ts');
const clientSrc = read('src/adapters/boxServiceClient.ts');
const readme = readFileSync(resolve(here, '..', '..', 'README.md'), 'utf8');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });
}
function clientWith(fetchImpl: unknown): BoxServiceClient {
  return new BoxServiceClient({
    baseUrl: 'http://127.0.0.1:5180',
    token: TOKEN,
    ctx: { fetchImpl: fetchImpl as typeof fetch },
  });
}

// ─────────────────────────── 分母（写死） ───────────────────────────

const DECLARED_CASES = [
  // P-1
  'P1-1', 'P1-2', 'P1-3', 'P1-4', 'P1-5', 'P1-6', 'P1-7', 'P1-8', 'P1-9',
  // P-2
  'P2-1', 'P2-2', 'P2-3', 'P2-4', 'P2-5', 'P2-6', 'P2-7', 'P2-8',
  // P-3
  'P3-1', 'P3-2', 'P3-3', 'P3-4',
  // P-4
  'P4-1', 'P4-2', 'P4-3', 'P4-4', 'P4-5', 'P4-6',
] as const;
const EXPECTED_CASE_COUNT = 27;

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
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'ENGINE_NOT_READY', message: '引擎处于 prewarming' } }, 503),
    );
    await expect(clientWith(fetchImpl).getQueue()).rejects.toMatchObject({
      name: 'BoxServiceError',
      code: 'ENGINE_NOT_READY',
      status: 503,
    });
  });

  caseIt('P1-6', 'ENGINE_NOT_READY **不**被 appendBatchWithRetry 自动重试（《01》§4.1 不排队不缓存）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'ENGINE_NOT_READY', message: '引擎准备中' } }, 503),
    );
    const res = await clientWith(fetchImpl).appendBatchWithRetry(
      'tsk_1',
      [{ seq: 1, blob: new Blob(['a'], { type: 'image/png' }), contentType: 'image/png', sourceUrl: 'u' }],
      'k',
      3,
    );
    expect(res.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  caseIt('P1-7', '阶段白名单：只认 3 个已知 state，取不到 / 未知一律 null（不猜）', () => {
    expect([...ENGINE_PREPARING_STATES]).toEqual(['starting', 'prewarming', 'downloading']);
    expect(enginePreparingStateOf({ sidecar: { state: 'prewarming', port: 5003 } })).toBe('prewarming');
    expect(enginePreparingStateOf({ sidecar: { state: 'starting' } })).toBe('starting');
    expect(enginePreparingStateOf({ sidecar: { state: 'downloading' } })).toBe('downloading');
    // 兜底：形状不对 / 未知取值 / 空 details
    expect(enginePreparingStateOf({})).toBeNull();
    expect(enginePreparingStateOf({ sidecar: null })).toBeNull();
    expect(enginePreparingStateOf({ sidecar: { state: 'unloading' } })).toBeNull();
    expect(enginePreparingStateOf({ sidecar: { state: 42 } })).toBeNull();
  });

  caseIt('P1-8', 'details 全链路接通：handle / fetchLibraryFile / SSE 三处抛错都带 details', async () => {
    // ① handle（getQueue）
    const d1 = { sidecar: { state: 'prewarming', port: 5003 } };
    await expect(
      clientWith(vi.fn(async () => jsonResponse({ error: { code: 'ENGINE_NOT_READY', message: 'x', details: d1 } }, 503))).getQueue(),
    ).rejects.toMatchObject({ details: d1 });

    // ② fetchLibraryFile
    const d2 = { modelRoot: '/models', sidecar: { state: 'stopped' } };
    await expect(
      clientWith(
        vi.fn(async () => jsonResponse({ error: { code: 'MODEL_DOWNLOAD_FAILED', message: 'x', details: d2 } }, 503)),
      ).fetchLibraryFile('漫画', 1, 'translated'),
    ).rejects.toMatchObject({ details: d2 });

    // ③ SSE 订阅（重连退避里抛出的那条）
    const d3 = { sidecar: { state: 'starting' } };
    const seen: BoxServiceError[] = [];
    const sub = subscribeTaskEvents(
      { baseUrl: 'http://127.0.0.1:5180', token: TOKEN, ctx: { fetchImpl: vi.fn(async () => jsonResponse({ error: { code: 'ENGINE_NOT_READY', message: 'x', details: d3 } }, 503)) as unknown as typeof fetch } },
      'tsk_1',
      { onEvent: () => undefined, onError: (e) => seen.push(e), backoffBaseMs: 1, backoffMaxMs: 1 },
    );
    try {
      await vi.waitFor(() => {
        if (seen.length === 0) throw new Error('尚未收到 onError');
      }, { timeout: 2000 });
      expect(seen[0]!.code).toBe('ENGINE_NOT_READY');
      expect(seen[0]!.details).toEqual(d3);
    } finally {
      sub.close();
    }
  });

  caseIt('P1-9', 'details 不能在跨层边界被截断（消息协议 / background / sendBg 三处）', () => {
    // 面板 ← background 的应答类型必须带 details
    expect(messagesSrc).toMatch(/details\?:\s*Record<string,\s*unknown>/);
    // background 的 fail() 必须回传 details
    expect(backgroundSrc).toMatch(/error:\s*\{\s*code:\s*err\.code,\s*message:\s*err\.message,\s*status:\s*err\.status,\s*details:\s*err\.details\s*\}/);
    // 面板侧还原 BoxServiceError 时必须带上 details（否则永远是 {}）
    expect(controllerSrc).toMatch(/new BoxServiceError\(res\.error\.code,\s*res\.error\.message,\s*res\.error\.status,\s*res\.error\.details \?\? \{\}\)/);
    // 客户端侧三处「信封 → 抛错」都不得省略 details（旧写法是三参数单行）
    expect(clientSrc).not.toMatch(/throw new BoxServiceError\(body\.error\.code, body\.error\.message, res\.status\);/);
    const detailsPassed = clientSrc.match(/body\.error\.details \?\? \{\}/g) ?? [];
    expect(detailsPassed.length).toBe(3); // handle / fetchLibraryFile / SSE
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
    expect(ENGINE_PREPARING.secondary).toBe('准备完成后请重新提交');
    // 「首张稍慢」不属于本态（《01》§4.2 是 running 第 1 张的事）
    expect(Object.values(ENGINE_PREPARING)).not.toContain(SLOW_FIRST_IMAGE_HINT);
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
    expect(s.enginePreparingState).toBeNull();

    s = batchReducer(s, batchActions.serviceDiscovered({ port: 5180, hasToken: true, ready: true }));
    expect(s.servicePhase).toBe('ready');
    expect(s.serviceReady).toBe(true);

    s = batchReducer(s, batchActions.serviceLost());
    expect(s.servicePhase).toBe('absent');
    expect(s.serviceReady).toBe(false);

    s = batchReducer(s, batchActions.serviceDiscovered({ port: 5180, hasToken: false, ready: false }));
    expect(s.servicePhase).toBe('absent');

    s = batchReducer(s, batchActions.submitStarted({ idempotencyKey: 'k', comicName: 'a' }));
    expect(s.state).toBe('submitting');
    s = batchReducer(s, batchActions.enginePreparing({ state: 'prewarming' }));
    expect(s.servicePhase).toBe('preparing');
    expect(s.enginePreparingState).toBe('prewarming');
    expect(s.state).toBe('idle');
    expect(s.error).toBeNull();

    // resetToIdle 必须保留服务阶段与阶段副行（否则重开面板时副行会丢）
    s = batchReducer(s, batchActions.resetToIdle());
    expect(s.servicePhase).toBe('preparing');
    expect(s.enginePreparingState).toBe('prewarming');

    // 引擎转好后重试提交成功（建单返回）→ 两态与阶段都必须清干净，
    // 否则浮层会盖住正在运行的面板
    s = batchReducer(s, batchActions.submitStarted({ idempotencyKey: 'k2', comicName: 'a' }));
    s = batchReducer(s, batchActions.taskCreated({ taskId: 'tsk_1', comicName: 'a', status: 'running' }));
    expect(s.servicePhase).toBe('ready');
    expect(s.enginePreparingState).toBeNull();
    expect(s.state).toBe('running');
  });

  caseIt('P2-7', 'Panel 按**两态**渲染浮层（不同 testid + phase 属性），并经 servicePhase 分流', () => {
    expect(panelSrc).toMatch(/serviceOverlayFor\(servicePhase\)/);
    expect(panelSrc).toMatch(/data-phase=\{overlayCopy\.phase\}/);
    expect(panelSrc).toMatch(/'engine-preparing'/);
    expect(panelSrc).toMatch(/'service-not-ready'/);
    expect(panelSrc).toMatch(/overlayCopy\.actionLabel/);
    expect(panelSrc).toMatch(/overlayCopy\.phase === 'absent'/);
    expect(panelSrc).toMatch(/'引擎准备中'/);
    expect(panelRootSrc).toMatch(/servicePhase=\{batch\.servicePhase\}/);
    expect(panelSrc).toMatch(/servicePhase: ServicePhase/);
  });

  caseIt('P2-8', '准备中浮层**副行按阶段**（《01》§4.1）：prewarming→预热；starting/downloading→准备模型；取不到→不猜', () => {
    expect(PREPARING_SUBLINE.warmup).toBe('正在预热');
    expect(PREPARING_SUBLINE.model).toBe('正在准备翻译模型');
    expect(preparingSubline('prewarming')).toBe('正在预热');
    expect(preparingSubline('starting')).toBe('正在准备翻译模型');
    expect(preparingSubline('downloading')).toBe('正在准备翻译模型');
    // 兜底：拿不到阶段就**不显示副行**（不编第三句）
    expect(preparingSubline(null)).toBeNull();
    // Panel 侧确实用了它，且浮层副行不再是「首张稍慢」
    expect(panelSrc).toMatch(/preparingSubline\(batch\.enginePreparingState\)/);
    expect(panelSrc).toMatch(/data-testid="engine-preparing-subline"/);
    expect(panelSrc).not.toMatch(/ENGINE_PREPARING\.slowFirst/);
  });
});

describe('S8 P-3 两处文案（逐字，不得改写）', () => {
  caseIt('P3-1', '「正在准备翻译引擎…」同时落在浮层标题与提示行', () => {
    expect(ENGINE_PREPARING.title).toBe('正在准备翻译引擎…');
    expect(panelSrc).toMatch(/<h4>\{overlayCopy\.title\}<\/h4>/);
    expect(panelSrc).toMatch(/preparing \? ENGINE_PREPARING\.title : ''/);
    expect(panelSrc).toMatch(/'engine-preparing-hint'/);
    expect(panelSrc).toMatch(/hint\.magicCircle \|\| preparing/);
  });

  caseIt('P3-2', '准备中副行的两句逐字取自《01》§4.1（不是「首张稍慢」）', () => {
    expect(PREPARING_SUBLINE.model).toBe('正在准备翻译模型');
    expect(PREPARING_SUBLINE.warmup).toBe('正在预热');
    // 与 box 端 NotReadyScreen 的 L2/L3 同字（逐字交叉印证，不得改写）
    expect(ERROR_COPY.MODEL_DOWNLOAD_FAILED).not.toContain(PREPARING_SUBLINE.model);
  });

  caseIt('P3-3', '「首张稍慢，后续加快」判据 = running 且**第 1 张**（第 2 张起消失）', () => {
    expect(SLOW_FIRST_IMAGE_HINT).toBe('首张稍慢，后续加快');
    // 正例：running + 第 1 张
    expect(showsSlowFirstImageHint({ state: 'running', current: 1 })).toBe(true);
    // 反例：第 2 张起必须消失（**反证位**：去掉 `current === 1` 条件会让这几行走红）
    expect(showsSlowFirstImageHint({ state: 'running', current: 2 })).toBe(false);
    expect(showsSlowFirstImageHint({ state: 'running', current: 3 })).toBe(false);
    expect(showsSlowFirstImageHint({ state: 'running', current: 0 })).toBe(false);
    expect(showsSlowFirstImageHint({ state: 'running', current: undefined })).toBe(false);
    expect(showsSlowFirstImageHint({ state: 'running', current: null })).toBe(false);
    // 非 running 一律不显示（含 queued / done）
    expect(showsSlowFirstImageHint({ state: 'queued', current: 1 })).toBe(false);
    expect(showsSlowFirstImageHint({ state: 'done', current: 1 })).toBe(false);
    expect(showsSlowFirstImageHint({ state: 'idle', current: 1 })).toBe(false);
  });

  caseIt('P3-4', 'Panel 在运行中渲染该提示：进度条下方、常规辅助文案色（非 warning/error）', () => {
    expect(panelSrc).toMatch(/showsSlowFirstImageHint\(\{\s*state: batch\.state,\s*current: batch\.progress\?\.current\s*\}\)/);
    expect(panelSrc).toMatch(/data-testid="slow-first-hint"/);
    expect(panelSrc).toMatch(/\{SLOW_FIRST_IMAGE_HINT\}/);
    // 预期行为，不得做成错误 / 警告样式
    const block = /\.mt-slowfirst\s*\{[^}]*\}/s.exec(panelCss)?.[0] ?? '';
    expect(block).toMatch(/color:\s*var\(--mt-muted\)/);
    expect(block).not.toMatch(/--mt-warning/);
    expect(block).not.toMatch(/--mt-error/);
  });
});

describe('S8 P-4 删除 DEMO_BYPASS_SERVICE_READY', () => {
  caseIt('P4-1', 'demoMode.ts 整文件已删除（无人再引用）', () => {
    expect(exists('src/domain/demoMode.ts')).toBe(false);
    expect(controllerSrc).not.toMatch(/DEMO_BYPASS_SERVICE_READY/);
    expect(controllerSrc).not.toMatch(/demoMode/);
  });

  caseIt('P4-2', 'controller 不再存在任何「服务缺席时强制 ready=true」的旁路', () => {
    expect(controllerSrc).not.toMatch(/hasToken:\s*true,\s*ready:\s*true/);
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
    expect(startup).toMatch(/if \(!discovered\.hasToken\) setTokenDialogOpen\(true\)/);
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
