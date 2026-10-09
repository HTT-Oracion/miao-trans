/**
 * 翻译方向断言（ver2.1 插件端新增：英译中）。
 *
 * 存在的理由：方向是「插件 → box-service」的一根**新契约线**，它有三个静默失败点 ——
 *   ① 白名单与 miao-dock 服务端 `TRANSLATE_DIRECTIONS` 漂移 ⇒ 服务端硬拒（表现为提交报错）；
 *   ② 方向选了却没进 `payload.lang`（在 store / controller / background 任一处断掉）⇒
 *      服务端落默认日译中，英文漫画整页原文照抄；
 *   ③ 默认值在「任务结束后回到选图态」时被重置 ⇒ 英文用户每轮都要重选。
 * 因此这里逐点钉死，并在 D6/D8 直接对 **multipart 里真正发出的 payload** 取证。
 *
 * 反证映射（把实现改坏 → 对应编号变红；改完必须还原）：
 *   - 删 `TRANSLATE_DIRECTIONS` 里的 `en` 项                → D1 红
 *   - 改 `DEFAULT_DIRECTION` 为 en>zh                      → D2 红
 *   - `sameDirection` 改成恒 true                          → D3 红
 *   - `directionChanged` 里直接 `s.direction = a.payload`（共享引用）→ D4 红
 *   - `resetToIdle` 去掉 `direction: s.direction`           → D5 红
 *   - `buildTaskFormData` 把 `lang` 从 payload 里剔除       → D6 / D8 红
 *   - 给 payload 无条件补默认 lang                          → D7 红
 */

import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_DIRECTION,
  TRANSLATE_DIRECTIONS,
  labelOfDirection,
  sameDirection,
} from '../src/domain/direction';
import { batchActions, batchInitialState, batchReducer } from '../src/store/translation/batchSlice';
import { BoxServiceClient, buildTaskFormData } from '../src/adapters/boxServiceClient';
import type { CreateTaskPayload, UploadImage } from '../src/types/contract';

const DECLARED_CASES = ['D1', 'D2', 'D3', 'D4', 'D5', 'D6', 'D7', 'D8'] as const;
const EXPECTED_CASE_COUNT = 8;

/** 实际执行过的用例 id —— 跳过（skip）不会登记，末尾据此判「跳过 ≠ 通过」 */
const executed: string[] = [];
function caseIt(id: (typeof DECLARED_CASES)[number], title: string, fn: () => void | Promise<void>): void {
  executed.push(id);
  it(`[${id}] ${title}`, fn);
}

const images: UploadImage[] = [
  { seq: 1, blob: new Blob(['x'], { type: 'image/png' }), contentType: 'image/png', sourceUrl: 'u1' },
];

describe('ver2.1 翻译方向', () => {
  caseIt('D1', '白名单恰两条（日译中 / 英译中），与 miao-dock 服务端 TRANSLATE_DIRECTIONS 对齐', () => {
    expect(TRANSLATE_DIRECTIONS).toHaveLength(2);
    expect(TRANSLATE_DIRECTIONS.map((d) => [d.from, d.to, d.label])).toEqual([
      ['ja', 'zh', '日译中'],
      ['en', 'zh', '英译中'],
    ]);
  });

  caseIt('D2', '默认方向是日译中，且 batchSlice 初值取同一常量（避免两处各写一份）', () => {
    expect(DEFAULT_DIRECTION).toEqual({ from: 'ja', to: 'zh' });
    expect(batchInitialState.direction).toEqual(DEFAULT_DIRECTION);
  });

  caseIt('D3', 'sameDirection 按 from+to 双键判定；labelOfDirection 对白名单外方向回落短码而不抛', () => {
    expect(sameDirection({ from: 'en', to: 'zh' }, { from: 'en', to: 'zh' })).toBe(true);
    // 只差一个键即不等价（半键相等必须为 false）
    expect(sameDirection({ from: 'en', to: 'zh' }, { from: 'ja', to: 'zh' })).toBe(false);
    expect(labelOfDirection({ from: 'ja', to: 'zh' })).toBe('日译中');
    expect(labelOfDirection({ from: 'en', to: 'zh' })).toBe('英译中');
    expect(labelOfDirection({ from: 'xx', to: 'yy' })).toBe('xx>yy');
  });

  caseIt('D4', 'directionChanged 写入 store，且**不得**把 action 的 payload 对象直接存进 state（防共享引用）', () => {
    const s0 = batchReducer(undefined, { type: '@@init' } as never);
    expect(s0.direction).toEqual({ from: 'ja', to: 'zh' });

    const payload = { from: 'en', to: 'zh' };
    const s1 = batchReducer(s0, batchActions.directionChanged(payload));
    expect(s1.direction).toEqual({ from: 'en', to: 'zh' });
    // 反共享引用：若实现写成 `s.direction = a.payload`，这里会拿到同一个对象
    // （后续对 payload 的原地改写会污染 store，且 immer 的冻结会反噬调用方）
    expect(s1.direction).not.toBe(payload);

    const s2 = batchReducer(s1, batchActions.directionChanged({ from: 'ja', to: 'zh' }));
    expect(s2.direction).toEqual({ from: 'ja', to: 'zh' });
  });

  caseIt('D5', '任务结束回到选图态（resetToIdle）保留方向 —— 否则英文用户每轮都要重选', () => {
    const s0 = batchReducer(undefined, { type: '@@init' } as never);
    const s1 = batchReducer(s0, batchActions.directionChanged({ from: 'en', to: 'zh' }));
    const s2 = batchReducer(s1, batchActions.resetToIdle());
    expect(s2.state).toBe('idle');
    expect(s2.direction).toEqual({ from: 'en', to: 'zh' });
  });

  caseIt('D6', '显式给 lang 时，multipart 里的 payload JSON 含 lang（随建单下发的取证点）', async () => {
    const payload: CreateTaskPayload = {
      comicName: '第12话',
      lang: { from: 'en', to: 'zh' },
      idempotencyKey: 'k',
    };
    const fd = buildTaskFormData(payload, images);
    const parsed = JSON.parse(await (fd.get('payload') as Blob).text()) as Record<string, unknown>;
    expect(parsed.lang).toEqual({ from: 'en', to: 'zh' });
  });

  caseIt('D7', '未给 lang 时 payload 不含 lang 键 —— 旧客户端零改动，服务端落默认方向', async () => {
    const fd = buildTaskFormData({ comicName: '第12话', idempotencyKey: 'k' }, images);
    const parsed = JSON.parse(await (fd.get('payload') as Blob).text()) as Record<string, unknown>;
    expect('lang' in parsed).toBe(false);
  });

  caseIt('D8', '端到端：createTask 把 payload.lang 真正发到服务端（捕获 fetch 请求体）', async () => {
    let seen: Record<string, unknown> | null = null;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      seen = JSON.parse(await (body.get('payload') as Blob).text()) as Record<string, unknown>;
      return new Response(JSON.stringify({ taskId: 'tsk_1', comicName: '第12话', status: 'queued', batches: [] }), {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
      });
    });
    const client = new BoxServiceClient({
      baseUrl: 'http://127.0.0.1:5180',
      token: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90',
      ctx: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    await client.createTask({ comicName: '第12话', lang: { from: 'en', to: 'zh' }, idempotencyKey: 'k' }, images);
    expect(seen).not.toBeNull();
    expect((seen as unknown as { lang?: unknown }).lang).toEqual({ from: 'en', to: 'zh' });
  });
});

describe('分母钉死（跳过 ≠ 通过）', () => {
  it(`应执行 ${EXPECTED_CASE_COUNT} 条用例：实执行 == 声明 == 期望`, () => {
    expect(executed.length).toBe(DECLARED_CASES.length);
    expect(new Set(executed).size).toBe(DECLARED_CASES.length);
    expect(DECLARED_CASES.length).toBe(EXPECTED_CASE_COUNT);
  });
});
