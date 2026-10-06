/**
 * 单元测试 —— 契约客户端。
 * 依据：《03》§2.1 / §2.2 / §5.2 / §5.3 / §5.5 / §8.3。
 */

import { describe, expect, it, vi } from 'vitest';
import {
  BoxServiceClient,
  SseParser,
  buildBatchFormData,
  buildTaskFormData,
  discoverService,
  probePorts,
  uuidV4,
} from '../src/adapters/boxServiceClient';
import { BoxServiceError, PORT_RANGE, SERVICE_NAME } from '../src/types/contract';

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('《03》§8.3 端口探测握手', () => {
  it('探测段就是 5180–5190（含两端，共 11 个）', () => {
    expect(probePorts()).toHaveLength(11);
    expect(probePorts()[0]).toBe(PORT_RANGE.from);
    expect(probePorts()[10]).toBe(PORT_RANGE.to);
  });

  it('命中条件是 `service === "box-service"`，只看 200 会把别的本地服务误判', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes(':5181')) {
        // 恰好占用该端口的其他程序：200 但 service 不对
        return jsonResponse({ status: 'ok', service: 'some-other-service' });
      }
      if (url.includes(':5182')) {
        return jsonResponse({ status: 'ok', service: SERVICE_NAME });
      }
      throw new TypeError('connect ECONNREFUSED');
    });
    const found = await discoverService({ ctx: { fetchImpl: fetchImpl as unknown as typeof fetch } });
    expect(found.ok).toBe(true);
    if (found.ok) expect(found.service.port).toBe(5182);
  });

  it('全段未命中 → 返回 triedPorts，由上层切「服务未就绪」态', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('connect ECONNREFUSED');
    });
    const found = await discoverService({
      ports: [5180, 5181],
      ctx: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    expect(found.ok).toBe(false);
    if (!found.ok) expect(found.triedPorts).toEqual([5180, 5181]);
  });
});

describe('《03》§2.2 错误信封 → BoxServiceError', () => {
  it('解析统一信封，保留 code / message / status / details', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(
        { error: { code: 'BATCH_LIMIT_EXCEEDED', message: '单次最多提交 20 张，当前 31 张', details: { limit: 20, submitted: 31 } } },
        400,
      ),
    );
    const client = new BoxServiceClient({ baseUrl: 'http://127.0.0.1:5180', token: TOKEN, ctx: { fetchImpl: fetchImpl as unknown as typeof fetch } });
    await expect(client.getQueue()).rejects.toMatchObject({
      name: 'BoxServiceError',
      code: 'BATCH_LIMIT_EXCEEDED',
      status: 400,
      details: { limit: 20, submitted: 31 },
    });
  });

  it('PERMISSION_DENIED 引导重新配对；UNAVAILABLE 引导切未就绪态', () => {
    expect(new BoxServiceError('PERMISSION_DENIED', 'x', 403).meansRepairToken).toBe(true);
    expect(new BoxServiceError('UNAVAILABLE', 'x', 503).meansServiceNotReady).toBe(true);
    expect(new BoxServiceError('NETWORK', 'x', 0).meansServiceNotReady).toBe(true);
    expect(new BoxServiceError('BATCH_LIMIT_EXCEEDED', 'x', 400).meansServiceNotReady).toBe(false);
  });

  it('每个请求都带 X-Box-Token 与归因头', async () => {
    const seen: Array<Record<string, string>> = [];
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      seen.push((init?.headers ?? {}) as Record<string, string>);
      return jsonResponse({ root: '/tmp', comics: [] });
    });
    const client = new BoxServiceClient({
      baseUrl: 'http://127.0.0.1:5180',
      token: TOKEN,
      clientId: 'extension/1.0.0',
      ctx: { fetchImpl: fetchImpl as unknown as typeof fetch },
    });
    await client.getLibrary();
    expect(seen[0]!['X-Box-Token']).toBe(TOKEN);
    expect(seen[0]!['X-Box-Client']).toBe('extension/1.0.0');
  });
});

describe('《03》§5.2 multipart 构造', () => {
  const images = [
    { seq: 1, blob: new Blob(['a'], { type: 'image/png' }), contentType: 'image/png', sourceUrl: 'u1' },
    { seq: 2, blob: new Blob(['b'], { type: 'image/jpeg' }), contentType: 'image/jpeg', sourceUrl: 'u2' },
  ];

  it('filename 为三位补零序号，扩展名取自 MIME（服务端仍以字节嗅探为准）', () => {
    const fd = buildTaskFormData({ comicName: '第12话', idempotencyKey: 'k' }, images);
    const file1 = fd.get('images[]');
    expect(file1).toBeInstanceOf(File);
    expect((file1 as File).name).toBe('001.png');
    const list = fd.getAll('images[]');
    expect(list).toHaveLength(2);
    expect((list[1] as File).name).toBe('002.jpg');
  });

  it('payload 为 application/json，且不含 lang / translator（首版由服务端固定）', async () => {
    const fd = buildTaskFormData({ comicName: '第12话', idempotencyKey: 'k' }, images);
    const payload = fd.get('payload') as Blob;
    expect(payload.type).toBe('application/json');
    const parsed = JSON.parse(await payload.text()) as Record<string, unknown>;
    expect(parsed.comicName).toBe('第12话');
    expect(parsed.idempotencyKey).toBe('k');
    expect(parsed.lang).toBeUndefined();
    expect(parsed.translator).toBeUndefined();
  });

  it('附加请求省略 comicName（自任务继承），并带 imageOrder[]', async () => {
    const fd = buildBatchFormData({ comicName: '', idempotencyKey: 'k2' }, images, [7, 8]);
    const parsed = JSON.parse(await (fd.get('payload') as Blob).text()) as Record<string, unknown>;
    expect(parsed.comicName).toBe('');
    expect(await (fd.get('imageOrder[]') as Blob).text()).toBe('7,8');
  });

  it('超过 20 张在客户端就被挡下（**单批**纵深防御；面板内的拦截在 50，见 selection.test.ts）', async () => {
    const many = Array.from({ length: 21 }, (_, i) => ({
      seq: i + 1,
      blob: new Blob(['x'], { type: 'image/png' }),
      contentType: 'image/png',
      sourceUrl: `u${i}`,
    }));
    const client = new BoxServiceClient({ baseUrl: 'http://127.0.0.1:5180', token: TOKEN });
    await expect(
      client.createTask({ comicName: 'a', idempotencyKey: 'k' }, many),
    ).rejects.toMatchObject({ code: 'BATCH_LIMIT_EXCEEDED', status: 400 });
  });
});

describe('《03》§5.3 批次追加的重试语义', () => {
  const images = [{ seq: 1, blob: new Blob(['a'], { type: 'image/png' }), contentType: 'image/png', sourceUrl: 'u1' }];

  it('重试必须复用**同一个** idempotencyKey，否则服务端会记成两个批次', async () => {
    const keys: string[] = [];
    let attempt = 0;
    const fetchImpl = vi.fn(async (_url: string, init?: RequestInit) => {
      const body = init?.body as FormData;
      const payload = JSON.parse(await (body.get('payload') as Blob).text()) as { idempotencyKey: string };
      keys.push(payload.idempotencyKey);
      attempt += 1;
      if (attempt === 1) throw new TypeError('network down');
      return jsonResponse({ taskId: 'tsk_1', comicName: 'a', status: 'queued', batches: [] });
    });
    const client = new BoxServiceClient({ baseUrl: 'http://127.0.0.1:5180', token: TOKEN, ctx: { fetchImpl: fetchImpl as unknown as typeof fetch } });
    const res = await client.appendBatchWithRetry('tsk_1', images, 'key-fixed', 3);
    expect(res.ok).toBe(true);
    expect(keys).toEqual(['key-fixed', 'key-fixed']);
  });

  it('4xx 是确定性拒绝，**不重试**（重试改变不了结果，只会拖长等待）', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ error: { code: 'TASK_NOT_APPENDABLE', message: '任务已结束' } }, 409),
    );
    const client = new BoxServiceClient({ baseUrl: 'http://127.0.0.1:5180', token: TOKEN, ctx: { fetchImpl: fetchImpl as unknown as typeof fetch } });
    const res = await client.appendBatchWithRetry('tsk_1', images, 'k', 3);
    expect(res.ok).toBe(false);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('全部重试失败也返回失败（由面板展示「剩余 N 张待提交」）', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('network down');
    });
    const client = new BoxServiceClient({ baseUrl: 'http://127.0.0.1:5180', token: TOKEN, ctx: { fetchImpl: fetchImpl as unknown as typeof fetch } });
    const res = await client.appendBatchWithRetry('tsk_1', images, 'k', 2);
    expect(res.ok).toBe(false);
  });
});

describe('《03》§5.5 SSE 解析', () => {
  it('解析 id / event / data，并按空行派发', () => {
    const p = new SseParser();
    const out = p.push('id: 1\nevent: task.status\ndata: {"status":"running"}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ id: '1', event: 'task.status', data: '{"status":"running"}' });
  });

  it('支持分片到达（半行不派发，补齐后才派发）', () => {
    const p = new SseParser();
    expect(p.push('id: 7\nevent: item.st')).toHaveLength(0);
    const out = p.push('atus\ndata: {"seq":3}\n\n');
    expect(out).toHaveLength(1);
    expect(out[0]?.event).toBe('item.status');
    expect(out[0]?.id).toBe('7');
  });

  it('多行 data 用 \\n 拼接（规范要求）', () => {
    const p = new SseParser();
    const out = p.push('event: x\ndata: line1\ndata: line2\n\n');
    expect(out[0]?.data).toBe('line1\nline2');
  });

  it('冒号开头的注释行被忽略（服务端用 `: connected` 做链路确认）', () => {
    const p = new SseParser();
    expect(p.push(': connected\n\n')).toHaveLength(0);
    const out = p.push('event: heartbeat\ndata: {"ts":"t"}\n\n');
    expect(out).toHaveLength(1);
  });

  it('兼容 CRLF 与 `field: value` 的空格', () => {
    const p = new SseParser();
    const out = p.push('id: 3\r\nevent: task.status\r\ndata: {"a":1}\r\n\r\n');
    expect(out[0]).toEqual({ id: '3', event: 'task.status', data: '{"a":1}' });
  });

  it('id 会延续到后续事件（重连时作为 Last-Event-ID）', () => {
    const p = new SseParser();
    const first = p.push('id: 9\nevent: a\ndata: {}\n\n');
    expect(first[0]?.id).toBe('9');
    const second = p.push('event: b\ndata: {}\n\n');
    expect(second[0]?.id).toBe('9');
  });
});

describe('idempotencyKey 生成', () => {
  it('是合法 UUIDv4', () => {
    const k = uuidV4();
    expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(uuidV4()).not.toBe(k);
  });
});
