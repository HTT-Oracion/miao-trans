// 自测脚本（交付说明中 8 条验收的可复现证据）
// 用法：node mock-service/scripts/selftest.mjs
// 脚本**自带**两个实例，并把落盘根目录 / 状态目录隔离到 os.tmpdir() 下的唯一临时目录，
// 跑完自动杀进程 + 删临时目录（绝不污染仓库 mock-service/.runtime）：
//   A: 5180，MOCK_ITEM_MS=100
//   B: 5181，MOCK_ITEM_MS=50 MOCK_FAIL_SEQ=3,5 MOCK_ETA_NULL=1
// 也可用 BASE_A / BASE_B（+ROOT_A/ROOT_B）指向外部已启动的实例，此时不再自起进程。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { makeSolidPng } from '../src/png.mjs';

const TOKEN = process.env.MOCK_TOKEN ||
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const PKG = path.resolve(import.meta.dirname, '..');

// 所有临时产物统一放这里，收尾整体删除
const TEMP_BASE = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-selftest-'));
const ROOT_A = process.env.ROOT_A || path.join(TEMP_BASE, 'A', 'Box 漫画');
const ROOT_B = process.env.ROOT_B || path.join(TEMP_BASE, 'B', 'Box 漫画');
let BASE_A = process.env.BASE_A || '';
let BASE_B = process.env.BASE_B || '';

const children = [];
function startServer(env, { waitFor = 'listen', timeoutMs = 10000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: PKG, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(
      () => resolve({ child, url: null, failed: true, log: () => out, timeout: true }), timeoutMs);
    const onData = (d) => {
      out += d.toString();
      const m = /监听地址\s*: http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m && waitFor === 'listen') {
        clearTimeout(timer);
        resolve({ child, url: `http://127.0.0.1:${m[1]}/api/v1`, log: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

if (!(BASE_A && BASE_B)) {
  const a = await startServer({
    MOCK_PORT: '5180', MOCK_ITEM_MS: '100',
    MOCK_ROOT: ROOT_A, MOCK_STATE_DIR: path.join(TEMP_BASE, 'A', 'state'),
  });
  const b = await startServer({
    MOCK_PORT: '5181', MOCK_ITEM_MS: '50', MOCK_FAIL_SEQ: '3,5', MOCK_ETA_NULL: '1',
    MOCK_ROOT: ROOT_B, MOCK_STATE_DIR: path.join(TEMP_BASE, 'B', 'state'),
  });
  children.push(a.child, b.child);
  if (!a.url || !b.url) {
    for (const c of children) { try { c.kill('SIGKILL'); } catch { /* ignore */ } }
    fs.rmSync(TEMP_BASE, { recursive: true, force: true });
    console.error('❌ 自起实例失败（5180/5181 可能被占用）：', a.log(), b.log());
    process.exit(1);
  }
  BASE_A = a.url;
  BASE_B = b.url;
}
// 运行期目录可能残留历史任务，用唯一后缀保证每次跑的序号都从 1 开始
const TAG = process.env.RUN_TAG || Math.random().toString(36).slice(2, 7);
const n = (name) => `${name} ${TAG}`;

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
};
const h = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (o, n = 320) => {
  const s = typeof o === 'string' ? o : JSON.stringify(o);
  if (s === undefined || s === null) return String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};

function png(seq, w = 640, hgt = 480) {
  return makeSolidPng(w, hgt, (seq * 41) % 360);
}

function buildForm(images, { comicName, key, fileName, payloadAsFile } = {}) {
  const fd = new FormData();
  const payload = {
    comicName,
    lang: { from: 'ja', to: 'zh' },
    translator: 'sakura',
    clientTaskRef: 'selftest',
    idempotencyKey: key || crypto.randomUUID(),
  };
  const json = JSON.stringify(payload);
  if (payloadAsFile) {
    // 变体：payload 以「文件 part」形式上送，服务端同样接受
    fd.append('payload', new Blob([json], { type: 'application/json' }), 'payload.json');
  } else {
    fd.append('payload', json);
  }
  images.forEach((img, i) => {
    const seq = i + 1;
    let name;
    let data;
    if (typeof img === 'string') { name = img; data = png(seq); }
    else if (typeof img === 'number') { name = `${String(img).padStart(3, '0')}.png`; data = png(img); }
    else { name = img.name || fileName || `${String(seq).padStart(3, '0')}.png`; data = img.data || png(seq); }
    fd.append('images[]', new Blob([data], { type: 'image/png' }), name);
  });
  return fd;
}

async function call(base, method, url, { form, token = TOKEN, origin, headers = {}, key } = {}) {
  const hdrs = { ...headers };
  if (token !== null) hdrs['X-Box-Token'] = token;
  if (origin !== undefined) hdrs.Origin = origin;
  const opts = { method, headers: hdrs };
  if (form) opts.body = form;
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

function parseSseBlock(block) {
  const out = { id: null, event: null, data: null };
  for (const line of block.split('\n')) {
    if (line.startsWith(':')) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (k === 'id') out.id = Number.parseInt(v, 10);
    else if (k === 'event') out.event = v;
    else if (k === 'data') out.data = v;
  }
  return out.event ? out : null;
}

async function readSse(url, { lastEventId, until, timeoutMs = 20000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  const headers = { 'X-Box-Token': TOKEN, Accept: 'text/event-stream' };
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId);
  const events = [];
  try {
    const res = await fetch(url, { headers, signal: ctrl.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n\n')) >= 0) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + 2);
        const ev = parseSseBlock(raw);
        if (!ev) continue;
        events.push(ev);
        if (until && until(ev)) { ctrl.abort(); return events; }
      }
    }
  } catch { /* abort / 连接结束 */ }
  clearTimeout(timer);
  return events;
}

async function waitTask(base, taskId, predicate, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(base, 'GET', `/tasks/${taskId}`);
    if (predicate(r.body)) return r.body;
    if (Date.now() - t0 > timeoutMs) return r.body;
    await sleep(120);
  }
}

const TERMINAL = ['done', 'partial_failed', 'failed', 'canceled'];

// ------------------------------------------------------------------ 1
async function t1() {
  h('1. 免鉴权 /health、错误令牌 403、非法 Origin 403');
  const r1 = await call(BASE_A, 'GET', '/health', { token: null });
  console.log('   GET /health (无令牌) →', r1.status, brief(r1.body, 240));
  check('无鉴权可通且 service=box-service',
    r1.status === 200 && r1.body.service === 'box-service' && ['ok', 'degraded', 'starting'].includes(r1.body.status));

  const r2 = await call(BASE_A, 'POST', '/tasks', { token: 'f'.repeat(64), form: buildForm([1], { comicName: 'x' }) });
  console.log('   POST /tasks (错令牌) →', r2.status, brief(r2.body, 160));
  check('错令牌 → 403 PERMISSION_DENIED', r2.status === 403 && r2.body.error.code === 'PERMISSION_DENIED');

  const r3 = await call(BASE_A, 'POST', '/tasks', { origin: 'https://evil.example.com', form: buildForm([1], { comicName: 'x' }) });
  console.log('   POST /tasks (非法 Origin) →', r3.status, brief(r3.body, 160));
  check('非法 Origin → 403 PERMISSION_DENIED（与令牌错误同码）',
    r3.status === 403 && r3.body.error.code === 'PERMISSION_DENIED');

  const r4 = await call(BASE_A, 'GET', '/health', { token: null, origin: 'chrome-extension://abcdefghijklmnopabcdefghijklmnop' });
  console.log('   GET /health (chrome-extension Origin) →', r4.status,
    'ACAO=', r4.headers.get('access-control-allow-origin'),
    'ACAH=', r4.headers.get('access-control-allow-headers'));
  check('CORS 回显具体 origin 且非 *',
    r4.headers.get('access-control-allow-origin') === 'chrome-extension://abcdefghijklmnopabcdefghijklmnop');

  const r5 = await call(BASE_A, 'GET', '/health', { token: null });
  check('无 Origin 时不带 ACAO 头', r5.headers.get('access-control-allow-origin') === null);
}

// ------------------------------------------------------------------ 2
async function t2() {
  h('2. 校验类错误');
  const r1 = await call(BASE_A, 'POST', '/tasks', { form: buildForm(Array.from({ length: 21 }, (_, i) => `${i + 1}.png`), { comicName: '超限测试' }) });
  console.log('   21 张 →', r1.status, brief(r1.body, 200));
  check('21 张 → 400 BATCH_LIMIT_EXCEEDED',
    r1.status === 400 && r1.body.error.code === 'BATCH_LIMIT_EXCEEDED' && r1.body.error.details.limit === 20);

  const r2 = await call(BASE_A, 'POST', '/tasks', { form: buildForm([1], { comicName: '   ' }) });
  console.log('   空漫画名 →', r2.status, brief(r2.body, 200));
  check('空漫画名 → 400 COMIC_NAME_REQUIRED', r2.status === 400 && r2.body.error.code === 'COMIC_NAME_REQUIRED');

  const r3 = await call(BASE_A, 'POST', '/tasks', { form: buildForm([1], { comicName: 'CON' }) });
  console.log('   保留名 CON →', r3.status, brief(r3.body, 200));
  check('CON → 400 INVALID_COMIC_NAME', r3.status === 400 && r3.body.error.code === 'INVALID_COMIC_NAME');

  const r4 = await call(BASE_A, 'POST', '/tasks', { form: buildForm([1], { comicName: 'ＣＯＮ', payloadAsFile: true }) });
  console.log('   全角 ＣＯＮ（payload 以文件 part 上送）→', r4.status, brief(r4.body, 160));
  check('全角 ＣＯＮ（NFKC 后）也被拒', r4.status === 400 && r4.body.error.code === 'INVALID_COMIC_NAME');

  return { r5form: buildForm(['001.txt', '002.txt'], { comicName: '第12话/学园祭' }) };
}

// ------------------------------------------------------------------ 2b + 7
async function t2bNormalizeAndSniff(form) {
  h('2b / 7. 规范化落盘 + 扩展名来自字节嗅探（filename 伪造成 .txt）');
  const r = await call(BASE_A, 'POST', '/tasks', { form });
  console.log('   POST comicName="第12话/学园祭" →', r.status,
    'normalizedComicName=', JSON.stringify(r.body.normalizedComicName), 'outputDir=', r.body.outputDir);
  check('规范化剥离 `/` → 第12话学园祭',
    r.status === 201 && r.body.normalizedComicName === '第12话学园祭');

  const taskId = r.body.taskId;
  const detail = await waitTask(BASE_A, taskId, (d) => TERMINAL.includes(d.status));
  const dir = path.join(ROOT_A, '第12话学园祭');
  const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
  console.log('   落盘目录：', dir);
  console.log('   目录内容：', JSON.stringify(files));
  const seqs = detail.items.map((i) => i.seq);
  const expect = seqs.flatMap((s) => [
    `${String(s).padStart(3, '0')}.png`, `${String(s).padStart(3, '0')}_translated.png`]);
  check('落盘文件名为 NNN.png / NNN_translated.png（NNN = 任务分配序号）',
    expect.every((f) => files.includes(f)), `seq=${seqs.join(',')}`);
  check('扩展名来自嗅探而非 filename(.txt)', !files.some((f) => f.endsWith('.txt')));
  check('任务终态 done', detail.status === 'done', `status=${detail.status}`);
  return taskId;
}

// ------------------------------------------------------------------ 3
async function t3() {
  h('3. 31 张分两批 → seqFrom/seqTo 与同一 taskId');
  const first = buildForm(Array.from({ length: 20 }, (_, i) => `${i + 1}.png`), { comicName: n('分批测试 31') });
  const r1 = await call(BASE_A, 'POST', '/tasks', { form: first });
  console.log('   B1 →', r1.status, brief(r1.body.batches), 'taskId=', r1.body.taskId, 'status=', r1.body.status, 'queuePosition=', r1.body.queuePosition);
  check('B1 为 1–20', r1.body.batches[0].seqFrom === 1 && r1.body.batches[0].seqTo === 20);

  const second = buildForm(Array.from({ length: 11 }, (_, i) => `${i + 21}.png`), {});
  const r2 = await call(BASE_A, 'POST', `/tasks/${r1.body.taskId}/batches`, { form: second });
  console.log('   B2 →', r2.status, brief(r2.body.batches), 'taskId=', r2.body.taskId);
  check('B2 为 21–31（续编号）', r2.body.batches[1].seqFrom === 21 && r2.body.batches[1].seqTo === 31);
  check('B2.seqFrom === B1.seqTo + 1', r2.body.batches[1].seqFrom === r2.body.batches[0].seqTo + 1);
  check('同一个 taskId', r1.body.taskId === r2.body.taskId);
  const detail = await waitTask(BASE_A, r1.body.taskId, (d) => TERMINAL.includes(d.status));
  check('31 张全部处理完 → done', detail.status === 'done', `progress=${brief(detail.progress, 120)}`);
  return r1.body.taskId;
}

// ------------------------------------------------------------------ 4
async function t4() {
  h('4. SSE：item.status / saved:true / task.status=done / Last-Event-ID 重放');
  const r = await call(BASE_A, 'POST', '/tasks', { form: buildForm(['a.png', 'b.png', 'c.png', 'd.png'], { comicName: n('SSE 测试') }) });
  const taskId = r.body.taskId;
  console.log('   创建任务', taskId, 'status=', r.body.status);
  // §5.7：建单响应必须带 progress —— 插件端 `t.progress ?? null`，缺字段提示行就退化成 0/0
  check('建单响应带 progress（4 张 → total=4, done=0）',
    r.body.progress && r.body.progress.total === 4 && r.body.progress.done === 0,
    `progress=${brief(r.body.progress, 120)}`);

  const events = await readSse(`${BASE_A}/tasks/${taskId}/events`, {
    until: (ev) => ev.event === 'task.status' && ev.data && JSON.parse(ev.data).status === 'done',
    timeoutMs: 20000,
  });
  const parsed = events.map((e) => ({ id: e.id, event: e.event, data: JSON.parse(e.data) }));
  console.log('   收到事件数：', parsed.length);
  console.log('   事件序列：', parsed.map((e) => `${e.id}:${e.event}:${e.data.status || ''}`).join(' | '));
  const itemEvents = parsed.filter((e) => e.event === 'item.status');
  console.log('   样例 item.status：', brief(itemEvents[itemEvents.length - 1], 200));
  check('收到 item.status 且 saved:true', itemEvents.some((e) => e.data.saved === true));
  check('收到 task.status=done', parsed.some((e) => e.event === 'task.status' && e.data.status === 'done'));
  // §5.7：running 期间事件必须带 progress —— 否则「已翻译数」停在建单那一刻的 0
  const withProgress = parsed.filter((e) => e.event === 'item.status' && e.data.progress
    && typeof e.data.progress.total === 'number' && typeof e.data.progress.done === 'number');
  check('item.status 事件带 progress（且 done 随进度增长）',
    withProgress.length > 0 && withProgress[withProgress.length - 1].data.progress.done >= 4,
    `末条=${brief(withProgress[withProgress.length - 1]?.data.progress, 120)}`);
  const taskEv = parsed.find((e) => e.event === 'task.status' && e.data.status === 'done');
  check('task.status 事件带 progress', !!(taskEv && taskEv.data.progress && taskEv.data.progress.total === 4));
  check('事件 id 递增', parsed.every((e, i) => i === 0 || e.id > parsed[i - 1].id));

  const mid = parsed[Math.floor(parsed.length / 2)].id;
  const replayed = await readSse(`${BASE_A}/tasks/${taskId}/events`, { lastEventId: mid, timeoutMs: 1500 });
  const rp = replayed.map((e) => e.id);
  console.log(`   Last-Event-ID=${mid} 重连收到 id：`, JSON.stringify(rp));
  check('重放仅补发 id 大于 Last-Event-ID 的事件', rp.length > 0 && rp.every((id) => id > mid));
  check('重放包含终态事件', rp.length === parsed.filter((e) => e.id > mid).length);

  const bad = await call(BASE_A, 'GET', '/tasks/tsk_不存在/events');
  check('不存在任务 → 404 TASK_NOT_FOUND', bad.status === 404 && bad.body.error.code === 'TASK_NOT_FOUND');
}

// ------------------------------------------------------------------ 5
async function t5() {
  h('5. GET /queue 位次与 eta');
  const r1 = await call(BASE_A, 'POST', '/tasks', { form: buildForm(Array.from({ length: 20 }, (_, i) => `${i + 1}.png`), { comicName: n('队列测试 A') }) });
  if (r1.status !== 201) throw new Error(`创建 A 失败：${r1.status} ${brief(r1.body)}`);
  await sleep(700); // 攒一些耗时样本
  const r2 = await call(BASE_A, 'POST', '/tasks', { form: buildForm(Array.from({ length: 5 }, (_, i) => `${i + 1}.png`), { comicName: n('队列测试 B') }) });
  if (r2.status !== 201) throw new Error(`创建 B 失败：${r2.status} ${brief(r2.body)}`);
  const q = await call(BASE_A, 'GET', '/queue');
  console.log('   GET /queue →', brief(q.body, 460));
  check('running 非空', !!q.body.running, `running=${q.body.running && q.body.running.taskId}`);
  check('queued[0].position === 1（1 = 下一个执行）', q.body.queued[0] && q.body.queued[0].position === 1);
  check('queued[0].imageCount === 5', q.body.queued[0] && q.body.queued[0].imageCount === 5);
  const eta0 = q.body.queued[0] && q.body.queued[0].etaSeconds;
  console.log('   queued[0].etaSeconds →', brief(eta0, 200));
  check('queued[0].etaSeconds 是形如 {min,max} 且带区间文案',
    !!eta0 && typeof eta0.min === 'number' && typeof eta0.max === 'number'
    && eta0.max > eta0.min && typeof eta0.text === 'string' && /\d/.test(eta0.text));
  check('创建响应 queuePosition：A=0（立即 running）、B=1',
    r1.body.queuePosition === 0 && r1.body.status === 'running' && r2.body.queuePosition === 1 && r2.body.status === 'queued');

  const qb = await call(BASE_B, 'POST', '/tasks', { form: buildForm([1, 2], { comicName: n('ETA NULL 测试') }) });
  console.log('   B(MOCK_ETA_NULL=1) 创建响应 →', qb.status, 'eta =', JSON.stringify(qb.body.eta));
  check('MOCK_ETA_NULL=1 时 eta 为 null', qb.status === 201 && qb.body.eta === null);
  return { a: r1.body.taskId, b: r2.body.taskId };
}

// ------------------------------------------------------------------ 6
async function t6() {
  h('6. MOCK_FAIL_SEQ=3,5 注入 → partial_failed');
  const r = await call(BASE_B, 'POST', '/tasks', { form: buildForm(Array.from({ length: 5 }, (_, i) => `${i + 1}.png`), { comicName: n('失败注入测试') }) });
  const detail = await waitTask(BASE_B, r.body.taskId, (d) => TERMINAL.includes(d.status));
  console.log('   终态：', detail.status, 'progress=', brief(detail.progress, 120));
  console.log('   items：', brief(detail.items, 420));
  check('终态 partial_failed', detail.status === 'partial_failed');
  const failed = detail.items.filter((i) => i.status === 'failed').map((i) => i.seq);
  check('失败项正是 seq 3 与 5', JSON.stringify(failed) === JSON.stringify([3, 5]), `failed=${JSON.stringify(failed)}`);
  check('失败项带 retryCount', detail.items.filter((i) => i.status === 'failed').every((i) => i.retryCount >= 1));
}

// ------------------------------------------------------------------ 8
async function t8() {
  h('8. 取消 queued 任务 → keptItems 0 且目录不存在');
  const formA = buildForm(Array.from({ length: 20 }, (_, i) => `${i + 1}.png`), { comicName: n('取消保留测试 A') });
  const r1 = await call(BASE_A, 'POST', '/tasks', { form: formA });
  if (r1.status !== 201) throw new Error(`创建 A 失败：${r1.status} ${brief(r1.body)}`);
  await sleep(300);
  const formB = buildForm(['001.png', '002.png', '003.png'], { comicName: n('取消排队测试 B') });
  const r2 = await call(BASE_A, 'POST', '/tasks', { form: formB });
  if (r2.status !== 201) throw new Error(`创建 B 失败：${r2.status} ${brief(r2.body)}`);
  console.log('   A=', r1.body.taskId, r1.body.status, '| B=', r2.body.taskId, r2.body.status, 'queuePosition=', r2.body.queuePosition);

  const dirB = path.join(ROOT_A, n('取消排队测试 B'));
  const c = await call(BASE_A, 'POST', `/tasks/${r2.body.taskId}/cancel`);
  console.log('   POST /tasks/{B}/cancel →', c.status, brief(c.body, 240));
  check('取消响应 {taskId,status:canceled,keptItems,outputDir}',
    c.status === 200 && c.body.status === 'canceled' && c.body.keptItems === 0 && typeof c.body.outputDir === 'string');
  check('queued 取消后目录不存在（惰性创建）', !fs.existsSync(dirB), dirB);

  const q = await call(BASE_A, 'GET', '/queue');
  check('取消的任务已从队列移除、队列余下仍在推进（不受影响）',
    !q.body.queued.some((t) => t.taskId === r2.body.taskId)
    && (q.body.running !== null || q.body.queued.length > 0),
    brief(q.body.running, 140));
  return { a: r1.body.taskId, b: r2.body.taskId };
}

// ------------------------------------------------------------------ 附加
async function t9(prev) {
  h('附加. 幂等重放（IDEMPOTENT_REPLAY 裁决）与取消 running');
  const key = crypto.randomUUID();
  const r1 = await call(BASE_A, 'POST', '/tasks', { form: buildForm([1], { comicName: n('幂等测试'), key }) });
  const r2 = await call(BASE_A, 'POST', '/tasks', { form: buildForm([1], { comicName: n('幂等测试'), key }) });
  console.log('   第一次 →', r1.status, r1.body.taskId, '| 第二次 →', r2.status, r2.body.taskId,
    '| idempotentReplay(已删除的旧自造字段) =', r2.body.idempotentReplay);
  // 契约 §5.2「重复提交返回已有 taskId 且不报错」/ §2.2 IDEMPOTENT_REPLAY|200：
  // 只用 HTTP 200（重放）vs 201（新建）区分，响应体**不得**出现契约外的自造字段。
  check('重复 idempotencyKey → HTTP 200 + 复用同一 taskId + 无 error 信封',
    r2.status === 200 && r2.body.taskId === r1.body.taskId && !r2.body.error);
  check('响应体不含契约外自造字段 idempotentReplay（§5.2）',
    r2.body.idempotentReplay === undefined);

  // 取消 running：等当前张跑完，已落盘保留
  await sleep(1200);
  const d = await waitTask(BASE_A, prev.a, (x) => x.progress.done >= 5);
  const before = d.progress.done;
  const c = await call(BASE_A, 'POST', `/tasks/${prev.a}/cancel`);
  console.log(`   取消 running 任务（已 done ${before}）→`, c.status, brief(c.body, 200));
  check('running 取消：keptItems 等于已成功张数（等当前张跑完）',
    c.body.status === 'canceled' && c.body.keptItems >= before, `keptItems=${c.body.keptItems}`);
  const after = await call(BASE_A, 'GET', `/tasks/${prev.a}`);
  const kept = after.body.items.filter((i) => i.status === 'success').length;
  const skipped = after.body.items.filter((i) => i.status === 'skipped').length;
  const dirA = path.join(ROOT_A, n('取消保留测试 A'));
  const fileCount = fs.existsSync(dirA) ? fs.readdirSync(dirA).length : 0;
  console.log('   终态：', after.body.status, `success=${kept} skipped=${skipped}`,
    `目录存在=${fs.existsSync(dirA)} 文件数=${fileCount}`);
  check('余下 item 全部 skipped，目录保留不清理',
    after.body.status === 'canceled' && skipped > 0 && fs.existsSync(dirA));
  check('取消后目录内恰好是已落盘张数的 2 倍文件（原图 + 译文）',
    fileCount === c.body.keptItems * 2, `files=${fileCount} keptItems=${c.body.keptItems}`);

  const again = await call(BASE_A, 'POST', `/tasks/${prev.a}/cancel`);
  check('重复取消 → 409 TASK_NOT_CANCELABLE', again.status === 409 && again.body.error.code === 'TASK_NOT_CANCELABLE');

  const append = await call(BASE_A, 'POST', `/tasks/${prev.a}/batches`, { form: buildForm([1], {}) });
  check('向终态任务追加批次 → 409 TASK_NOT_APPENDABLE',
    append.status === 409 && append.body.error.code === 'TASK_NOT_APPENDABLE');

  const lib = await call(BASE_A, 'GET', '/library');
  console.log('   GET /library →', lib.status, brief(lib.body, 400));
  check('库扫描返回漫画列表', lib.status === 200 && Array.isArray(lib.body.comics) && lib.body.comics.length > 0);

  const comic = lib.body.comics.find((c2) => c2.comicName === '第12话学园祭');
  const file = await call(BASE_A, 'GET', `/library/${encodeURIComponent('第12话学园祭')}/files/1?variant=translated`, { token: TOKEN });
  console.log('   文件流 →', file.status, 'content-type=', file.headers.get('content-type'));
  check('导出文件流带正确 Content-Type',
    file.status === 200 && file.headers.get('content-type') === 'image/png' && comic !== undefined);

  const reveal = await call(BASE_A, 'POST', `/library/${encodeURIComponent('第12话学园祭')}/reveal`);
  console.log('   reveal →', reveal.status, brief(reveal.body, 160));
  check('reveal 返回 {ok:true, path}', reveal.status === 200 && reveal.body.ok === true && reveal.body.path.includes('Box 漫画'));

  const escape = await call(BASE_A, 'POST', '/library/..%2F..%2Fetc/reveal');
  console.log('   越界漫画名 →', escape.status, brief(escape.body, 160));
  // 契约 §8.2：三次校验任一失败即 403 + 安全日志（只允许 403，不接受「归一化后 404」）
  check('路径越界 → 403 PERMISSION_DENIED（§8.2）',
    escape.status === 403 && escape.body.error && escape.body.error.code === 'PERMISSION_DENIED');
}

// ------------------------------------------------------------------ 主流程

console.log('喵译 mock box-service 自测');
console.log('A =', BASE_A, '\nB =', BASE_B, '\nROOT_A =', ROOT_A, '\nTEMP_BASE =', TEMP_BASE);

try {
  await t1();
  const ctx = await t2();
  await t2bNormalizeAndSniff(ctx.r5form);
  await t3();
  await t4();
  await t5();
  await t6();
  const c = await t8();
  await t9(c);
} finally {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  fs.rmSync(TEMP_BASE, { recursive: true, force: true });
}

console.log(`\n=== 汇总：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
