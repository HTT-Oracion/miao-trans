// 附加自测：MOCK_SKIP_EXISTING / MOCK_DISK_FULL / MOCK_SIDECAR_DOWN / 端口探测策略
// 脚本自行拉起所需实例，跑完自动关闭。
// 用法：node mock-service/scripts/selftest-extras.mjs
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import { makeSolidPng } from '../src/png.mjs';

const NODE = process.execPath;
const PKG = path.resolve(import.meta.dirname, '..');
const TOKEN = process.env.MOCK_TOKEN ||
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

let pass = 0;
let fail = 0;
const check = (label, ok, extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
};
const h = (t) => console.log(`\n=== ${t} ===`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const brief = (o, n = 300) => {
  const s = typeof o === 'string' ? o : JSON.stringify(o);
  return s && s.length > n ? s.slice(0, n) + '…' : String(s);
};

function startServer(env, { waitFor = 'listen', timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(NODE, ['src/server.mjs'], {
      cwd: PKG, env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    const timer = setTimeout(() => { resolve({ child, port: null, failed: true, log: () => out, timeout: true }); }, timeoutMs);
    const onData = (d) => {
      out += d.toString();
      const m = /监听地址\s*: http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m && waitFor === 'listen') {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), url: `http://127.0.0.1:${m[1]}/api/v1`, log: () => out });
      }
      if (waitFor === 'fail' && /全部被占用/.test(out)) {
        clearTimeout(timer);
        resolve({ child, port: null, failed: true, log: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

function makeForm(count, comicName, startSeq = 1) {
  const fd = new FormData();
  fd.append('payload', JSON.stringify({ comicName, idempotencyKey: crypto.randomUUID() }));
  for (let i = 0; i < count; i++) {
    const seq = startSeq + i;
    fd.append('images[]', new Blob([makeSolidPng(320, 240, seq * 37)], { type: 'image/png' }),
      `${String(i + 1).padStart(3, '0')}.png`);
  }
  return fd;
}

async function call(base, method, url, { form } = {}) {
  const opts = { method, headers: { 'X-Box-Token': TOKEN } };
  if (form) opts.body = form;
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let body; try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body };
}

async function waitDone(base, taskId, timeoutMs = 20000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(base, 'GET', `/tasks/${taskId}`);
    if (['done', 'partial_failed', 'failed', 'canceled'].includes(r.body.status)) return r.body;
    if (Date.now() - t0 > timeoutMs) return r.body;
    await sleep(100);
  }
}

const servers = [];
const TMP = process.env.MTS_TMP || '/tmp/mts-extras';
fs.mkdirSync(TMP, { recursive: true });

try {
  // ---------------------------------------------------------------- E1
  h('E1. MOCK_SKIP_EXISTING=1 → NNN_translated.* 已存在则 skipped(already_exists)，序号不变');
  const rootA = path.join(TMP, `skip-${Date.now()}`);
  const sA = await startServer({
    MOCK_PORT: '5185', MOCK_ITEM_MS: '30', MOCK_SKIP_EXISTING: '1',
    MOCK_ROOT: path.join(rootA, 'Box 漫画'), MOCK_STATE_DIR: path.join(rootA, 'state'),
  });
  servers.push(sA.child);
  const name = 'skip 测试';
  const dir = path.join(rootA, 'Box 漫画', name);

  const t1 = await call(sA.url, 'POST', '/tasks', { form: makeForm(5, name) });
  if (t1.status !== 201) throw new Error(`E1 首次创建失败 ${t1.status} ${brief(t1.body)}`);
  const d1 = await waitDone(sA.url, t1.body.taskId);
  console.log('   首次：', d1.status, brief(d1.items.map((i) => `${i.seq}:${i.status}`)));
  check('首次全部 success 并落盘', d1.status === 'done' && fs.readdirSync(dir).length === 10,
    `文件数=${fs.readdirSync(dir).length}`);

  // 只删原图，保留译文 → 复现「续做」场景
  for (const f of fs.readdirSync(dir)) if (!f.includes('_translated')) fs.rmSync(path.join(dir, f));
  const t2 = await call(sA.url, 'POST', '/tasks', { form: makeForm(5, name, 100) });
  const d2 = await waitDone(sA.url, t2.body.taskId);
  console.log('   续做：', d2.status, brief(d2.items.map((i) => `${i.seq}:${i.status}:${i.reason}`)));
  console.log('   续做 batches：', brief(d2.batches));
  check('全部 item 为 skipped', d2.items.every((i) => i.status === 'skipped'));
  check('reason 均为 already_exists', d2.items.every((i) => i.reason === 'already_exists'));
  check('序号不变（1–5，不重号）', d2.items.map((i) => i.seq).join(',') === '1,2,3,4,5');
  check('保留了既有 outputFile', d2.items.every((i) => /^\d{3}_translated\.png$/.test(i.outputFile)));
  check('任务终态 done（skipped 与 success 等价收敛）', d2.status === 'done');
  check('未覆盖已有译文（文件数仍为 5）',
    fs.readdirSync(dir).filter((f) => f.includes('_translated')).length === 5);

  // ---------------------------------------------------------------- E2
  h('E2. MOCK_DISK_FULL=1 → saved:false 且 item 仍 success，任务继续到 done');
  const rootB = path.join(TMP, `disk-${Date.now()}`);
  const sB = await startServer({
    MOCK_PORT: '5186', MOCK_ITEM_MS: '30', MOCK_DISK_FULL: '1',
    MOCK_ROOT: path.join(rootB, 'Box 漫画'), MOCK_STATE_DIR: path.join(rootB, 'state'),
  });
  servers.push(sB.child);
  const t3 = await call(sB.url, 'POST', '/tasks', { form: makeForm(4, '磁盘满测试') });
  const d3 = await waitDone(sB.url, t3.body.taskId);
  console.log('   ', d3.status, brief(d3.items.map((i) => `${i.seq}:${i.status}:saved=${i.saved}:${i.reason}`)));
  check('item 全部 success', d3.items.every((i) => i.status === 'success'));
  check('saved 全部为 false', d3.items.every((i) => i.saved === false));
  check('reason=disk_full', d3.items.every((i) => i.reason === 'disk_full'));
  check('任务未被阻断，终态 done', d3.status === 'done');
  check('未产生任何落盘目录（惰性创建 + 未写入）',
    !fs.existsSync(path.join(rootB, 'Box 漫画', '磁盘满测试')));

  // ---------------------------------------------------------------- E3
  h('E3. MOCK_SIDECAR_DOWN=1 → /health status=degraded，写操作 503 UNAVAILABLE');
  const rootC = path.join(TMP, `down-${Date.now()}`);
  const sC = await startServer({
    MOCK_PORT: '5187', MOCK_SIDECAR_DOWN: '1',
    MOCK_ROOT: path.join(rootC, 'Box 漫画'), MOCK_STATE_DIR: path.join(rootC, 'state'),
  });
  servers.push(sC.child);
  const hh = await call(sC.url, 'GET', '/health');
  console.log('   /health →', brief(hh.body, 200));
  check('status=degraded 且 sidecar.state=down',
    hh.body.status === 'degraded' && hh.body.sidecar.state === 'down');
  const t4 = await call(sC.url, 'POST', '/tasks', { form: makeForm(2, 'sidecar 未就绪测试') });
  console.log('   POST /tasks →', t4.status, brief(t4.body, 200));
  check('503 UNAVAILABLE', t4.status === 503 && t4.body.error.code === 'UNAVAILABLE');

  // ---------------------------------------------------------------- E4
  h('E4. 端口策略：5180 被占 → 段内探测下一个；MOCK_PORT 被占 → 启动失败报错');
  // 先占住 5180，模拟「默认端口被别的程序占用」（若已被占用同样满足前提）
  let blocker = null;
  try {
    blocker = await new Promise((resolve, reject) => {
      const s = http.createServer((q, r) => r.end('occupied'));
      s.once('error', reject);
      s.listen(5180, '127.0.0.1', () => resolve(s));
    });
    console.log('   已用占位程序占用 5180');
  } catch {
    console.log('   5180 已被占用（无需额外占位程序）');
  }

  const probeRoot = path.join(TMP, `port-${Date.now()}`);
  const sProbe = await startServer({
    MOCK_ITEM_MS: '30',
    MOCK_ROOT: path.join(probeRoot, 'Box 漫画'), MOCK_STATE_DIR: path.join(probeRoot, 'state'),
  });
  servers.push(sProbe.child);
  console.log('   默认端口启动命中：', sProbe.port);
  check('5180 被占时在 5180–5190 段内探测到下一个空闲端口',
    Number.isFinite(sProbe.port) && sProbe.port > 5180 && sProbe.port <= 5190, `port=${sProbe.port}`);

  const sFail = await startServer({ MOCK_PORT: '5185' }, { waitFor: 'fail' });
  servers.push(sFail.child);
  const tail = sFail.log().split('\n').filter((l) => l.includes('占用') || l.includes('Error')).slice(-2);
  console.log('   MOCK_PORT=5185（已被占）→', tail.join(' | '));
  check('显式端口被占 → 启动失败并明确报错（不静默换端口）', sFail.failed === true);
  if (blocker) blocker.close();

  // ---------------------------------------------------------------- E5
  h('E5. 续编号超 999 → 409 SEQUENCE_OVERFLOW');
  const rootE = path.join(TMP, `seq-${Date.now()}`);
  const dirE = path.join(rootE, 'Box 漫画', '超限测试');
  fs.mkdirSync(dirE, { recursive: true });
  for (let i = 1; i <= 999; i++) fs.writeFileSync(path.join(dirE, `${String(i).padStart(3, '0')}.png`), '');
  const sE = await startServer({
    MOCK_PORT: '5188', MOCK_ITEM_MS: '30',
    MOCK_ROOT: path.join(rootE, 'Box 漫画'), MOCK_STATE_DIR: path.join(rootE, 'state'),
  });
  servers.push(sE.child);
  const t5 = await call(sE.url, 'POST', '/tasks', { form: makeForm(1, '超限测试') });
  console.log('   目录已有 001–999 → POST /tasks →', t5.status, brief(t5.body, 240));
  check('409 SEQUENCE_OVERFLOW', t5.status === 409 && t5.body.error.code === 'SEQUENCE_OVERFLOW');
  check('错误信封 details 含 limit=999', t5.body.error.details.limit === 999);
} finally {
  for (const child of servers) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
}

console.log(`\n=== 附加自测汇总：通过 ${pass} / 失败 ${fail} ===`);
process.exit(fail === 0 ? 0 : 1);
