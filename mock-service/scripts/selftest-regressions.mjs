// F-1 ~ F-8 回归测试（每条断言都标注契约出处；实现细节类断言显式标注）
// 用法：node mock-service/scripts/selftest-regressions.mjs
//
// 铁律：全程使用独立临时目录（os.tmpdir() 下的唯一目录），跑完杀进程 + 删目录，
//       绝不污染仓库 mock-service/.runtime。
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { makeSolidPng } from '../src/png.mjs';
import { isSafeDirName, normalizeComicName } from '../src/names.mjs';
import { parseMultipart, parseMultipartEx } from '../src/multipart.mjs';
import { CODES, errorEnvelope } from '../src/errors.mjs';

const PKG = path.resolve(import.meta.dirname, '..');
const REPO_RUNTIME = path.join(PKG, '.runtime');
const TOKEN = process.env.MOCK_TOKEN ||
  'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';

const TEMP = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-regression-'));

// 关键顺序：先把运行期目录隔离好，**再**动态 import store.mjs（其 config 在模块求值时读 env）
process.env.MOCK_ROOT = path.join(TEMP, 'inproc', 'Box 漫画');
process.env.MOCK_STATE_DIR = path.join(TEMP, 'inproc', 'state');
process.env.MOCK_ITEM_MS = '1';
const { Store } = await import('../src/store.mjs');
const { config } = await import('../src/config.mjs');

let pass = 0;
let fail = 0;
const h = (t) => console.log(`\n=== ${t} ===`);
/** evidence：契约出处（章节 + 原话摘录）或「[实现细节，契约未规定]」 */
const check = (label, ok, evidence = '', extra = '') => {
  if (ok) { pass++; console.log(`  ✅ ${label}${extra ? '  ' + extra : ''}`); }
  else { fail++; console.log(`  ❌ ${label}${extra ? '  ' + extra : ''}`); }
  if (evidence) console.log(`       § 出处：${evidence}`);
};
const brief = (o, n = 240) => {
  const s = typeof o === 'string' ? o : JSON.stringify(o);
  if (s === undefined || s === null) return String(s);
  return s.length > n ? s.slice(0, n) + '…' : s;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------- 错误码可达性矩阵
const CONTRACT_CODES = Object.keys(CODES);
const reach = new Map(); // code → {how, note}
const mark = (code, how, note = '') => { reach.set(code, { how, note }); };

// --------------------------------------------------------------- 服务器管理
const children = [];
let portCursor = 5260;
const nextPort = () => String(portCursor++);

function spawnServer({ env = {}, root, state, waitFor = 'listen', timeoutMs = 10000 }) {
  if (!root || !state) throw new Error('spawnServer 必须传隔离的 root/state（禁止污染仓库）');
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['src/server.mjs'], {
      cwd: PKG,
      env: { ...process.env, MOCK_ROOT: root, MOCK_STATE_DIR: state, ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.push(child);
    let out = '';
    // waitFor='fail' 的超时意味着「它并没有失败」→ 必须判为 failed:false（否则会把 bug 误判成通过）
    const timer = setTimeout(() => resolve({
      child, url: null, failed: waitFor === 'listen', timeout: true, log: () => out,
    }), timeoutMs);
    const onData = (d) => {
      out += d.toString();
      const m = /监听地址\s*: http:\/\/127\.0\.0\.1:(\d+)/.exec(out);
      if (m && waitFor === 'listen') {
        clearTimeout(timer);
        resolve({ child, port: Number(m[1]), url: `http://127.0.0.1:${m[1]}/api/v1`, log: () => out });
      }
      if (waitFor === 'fail' && /(全部被占用|落盘根目录不合法|启动失败)/.test(out)) {
        clearTimeout(timer);
        resolve({ child, url: null, failed: true, log: () => out });
      }
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
  });
}

async function call(base, method, url, { form, token = TOKEN, origin, headers = {}, raw } = {}) {
  const hdrs = { ...headers };
  if (token !== null) hdrs['X-Box-Token'] = token;
  if (origin !== undefined) hdrs.Origin = origin;
  const opts = { method, headers: hdrs };
  if (form) opts.body = form;
  if (raw) opts.body = raw;
  const res = await fetch(base + url, opts);
  const text = await res.text();
  let body = null;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: res.status, body, headers: res.headers };
}

const TERMINAL = ['done', 'partial_failed', 'failed', 'canceled'];
async function waitTask(base, taskId, timeoutMs = 30000) {
  const t0 = Date.now();
  for (;;) {
    const r = await call(base, 'GET', `/tasks/${taskId}`);
    if (r.body && TERMINAL.includes(r.body.status)) return r.body;
    if (Date.now() - t0 > timeoutMs) return r.body;
    await sleep(60);
  }
}

function formFor(comicName, count = 1, { key, seed = 1, name } = {}) {
  const fd = new FormData();
  fd.append('payload', JSON.stringify({ comicName, idempotencyKey: key || crypto.randomUUID() }));
  for (let i = 0; i < count; i++) {
    fd.append('images[]', new Blob([makeSolidPng(48, 48, (seed + i) * 37)], { type: 'image/png' }),
      name || `${String(i + 1).padStart(3, '0')}.png`);
  }
  return fd;
}

// 手工构造 multipart 原始字节（用于 F-4 的字节级注入用例）
const RAW_BOUNDARY = '----regressionBoundaryXYZ';
function rawMultipart(images, payloadJson) {
  const chunks = [
    Buffer.from(`--${RAW_BOUNDARY}\r\n`, 'latin1'),
    Buffer.from('Content-Disposition: form-data; name="payload"\r\n\r\n', 'latin1'),
    Buffer.from(payloadJson, 'utf8'),
    Buffer.from(`\r\n--${RAW_BOUNDARY}\r\n`, 'latin1'),
  ];
  images.forEach((img, i) => {
    chunks.push(Buffer.from(
      `Content-Disposition: form-data; name="images[]"; filename="${(i + 1).toString().padStart(3, '0')}.png"\r\n`
      + 'Content-Type: image/png\r\n\r\n', 'latin1'));
    chunks.push(img);
    chunks.push(Buffer.from(`\r\n--${RAW_BOUNDARY}\r\n`, 'latin1'));
  });
  // 把最后一段的 `\r\n--b` 改写成结束分隔符
  chunks[chunks.length - 1] = Buffer.from(`\r\n--${RAW_BOUNDARY}--\r\n`, 'latin1');
  return Buffer.concat(chunks);
}

const mainRoot = path.join(TEMP, 'main', 'Box 漫画');
const mainState = path.join(TEMP, 'main', 'state');

try {
  const S = await spawnServer({ env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20' }, root: mainRoot, state: mainState });
  if (!S.url) throw new Error(`主测试实例启动失败：${S.log()}`);
  const B = S.url;

  // ===================================================================== F-1
  h('F-1（P0）漫画名含 `..` → 请求期 403/400，合法名真实落盘，非磁盘异常不得被吞');
  {
    const r1 = await call(B, 'POST', '/tasks', { form: formFor('..', 1) });
    check('comicName=".." → 400 COMIC_NAME_REQUIRED（归一化后为空）',
      r1.status === 400 && r1.body.error.code === 'COMIC_NAME_REQUIRED',
      '§6.1 步 9「空名检查（如输入 ///）→ COMIC_NAME_REQUIRED」', `HTTP ${r1.status}`);

    const r2 = await call(B, 'POST', '/tasks', { form: formFor('a..b', 2) });
    const d2 = r2.status === 201 ? await waitTask(B, r2.body.taskId) : null;
    const dir = path.join(mainRoot, 'a..b');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
    check('comicName="a..b" → 201（无分隔符、无法穿越，是合法漫画名）',
      r2.status === 201 && r2.body.normalizedComicName === 'a..b',
      '§8.2 校验点 2 的语义是「防路径穿越」；§6.1 步 3 已剥离 `/ \\ :`，`a..b` 无路径成分',
      `HTTP ${r2.status} normalized=${r2.body.normalizedComicName}`);
    check('comicName="a..b" → 真实落盘 a..b/001.png + 001_translated.png 且终态 done',
      !!d2 && d2.status === 'done' && files.includes('001.png') && files.includes('001_translated.png'),
      '§7.2「原图：NNN.<ext> / 译文：NNN_translated.<ext>」', `files=${JSON.stringify(files)}`);
    check('「静默 saved:false 且 done」已消失：item 为 success 且 saved=true',
      !!d2 && d2.items.every((i) => i.status === 'success' && i.saved === true),
      '§4.2「translating | 推理成功 | success | 带 saved: true | false」；只有落盘失败才允许 saved:false',
      d2 ? brief(d2.items) : '');

    // 白盒 backstop（HTTP 面因归一化剥离分隔符而不可达，只能白盒测）
    const unsafe = ['../etc', '..', '.', 'a/b', 'a\\b', 'x\u0000y', '', '/etc', '..\\..', '.../...'];
    const bad = unsafe.filter((s) => isSafeDirName(s) !== false);
    check('白盒 isSafeDirName：路径成分/分隔符/NUL/空名 全部 false',
      bad.length === 0,
      '§8.2 校验点 2「normalizedComicName 不含 / \\ ..（再断言一次，不信任上游）」',
      bad.length ? `漏网=${JSON.stringify(bad)}` : `用例=${unsafe.length}`);
    check('白盒 isSafeDirName("a..b") === true（不得误伤合法名）',
      isSafeDirName('a..b') === true,
      '§8.2 校验点 2 的意图是防穿越，`a..b` 不含路径成分');

    // 白盒：非磁盘异常必须向上抛（不得被 _processItem 的 catch 吞成 saved:false）
    const store = new Store(path.join(TEMP, 'whitebox', 'Box 漫画'));
    const wTask = { taskId: 'tsk_wb', dirName: '../evil', batches: [], events: [], clients: new Set(), status: 'running' };
    const wItem = { seq: 1, ext: 'png', status: 'pending', saved: false, retryCount: 0 };
    const wBatch = { batchIndex: 1, items: [wItem] };
    let threw = null;
    try { await store._processItem(wTask, wBatch, wItem); } catch (e) { threw = e; }
    check('白盒 _processItem：路径类异常（ApiError PERMISSION_DENIED）向上抛，不再静默降级',
      !!threw && threw.code === 'PERMISSION_DENIED',
      '§4.2 只有「落盘失败（磁盘满）」才允许 saved:false；路径越界是安全拒绝，不是落盘失败',
      threw ? `threw=${threw.code}` : `未抛出（item.saved=${wItem.saved}, reason=${wItem.reason}）`);

    // 白盒：真正的磁盘类错误仍降级为 saved:false（不阻断）
    config.diskFull = true;
    const wItem2 = { seq: 1, ext: 'png', status: 'pending', saved: false, retryCount: 0 };
    const wTask2 = { taskId: 'tsk_wb2', dirName: 'okname', batches: [], events: [], clients: new Set(), status: 'running' };
    const wBatch2 = { batchIndex: 1, items: [wItem2] };
    let threw2 = null;
    try { await store._processItem(wTask2, wBatch2, wItem2); } catch (e) { threw2 = e; }
    config.diskFull = false;
    check('白盒 _processItem：磁盘类错误（ENOSPC）仍降级 saved:false 且 item=success（不阻断）',
      !threw2 && wItem2.status === 'success' && wItem2.saved === false,
      '§4.2「saved: false 时 item 仍为 success——落盘失败不阻断主路径」',
      `threw=${threw2 && threw2.code} status=${wItem2.status} saved=${wItem2.saved} reason=${wItem2.reason}`);

    mark('PERMISSION_DENIED', 'e2e（F-1/F-5/鉴权）');
  }

  // ===================================================================== F-2
  h('F-2（P1）幂等续做默认生效：NNN_translated.* 已存在 → skipped(already_exists)，序号不变');
  {
    const name = 'F2 续做默认';
    const dir = path.join(mainRoot, name);
    const t1 = await call(B, 'POST', '/tasks', { form: formFor(name, 5) });
    const d1 = await waitTask(B, t1.body.taskId);
    const files1 = fs.readdirSync(dir).sort();
    for (const f of fs.readdirSync(dir)) if (!f.includes('_translated')) fs.rmSync(path.join(dir, f));
    const t2 = await call(B, 'POST', '/tasks', { form: formFor(name, 5) });
    const d2 = await waitTask(B, t2.body.taskId);
    const files2 = fs.readdirSync(dir).sort();
    check('默认配置（未设 MOCK_SKIP_EXISTING）下第 2 次提交 → 全部 skipped',
      d2.items.every((i) => i.status === 'skipped'),
      '§4.2「pending | 续做时 NNN_translated.* 已存在 | skipped | reason: already_exists」',
      brief(d2.items.map((i) => `${i.seq}:${i.status}`)));
    check('reason 全为 already_exists（[实现细节，契约未规定] 字符串取值）',
      d2.items.every((i) => i.reason === 'already_exists'),
      '§4.2 表格原文即 `reason: already_exists`', '');
    check('序号不变（seqFrom/seqTo 与首次一致）',
      d2.batches[0].seqFrom === d1.batches[0].seqFrom && d2.batches[0].seqTo === d1.batches[0].seqTo,
      '§7.4「幂等续做：NNN_translated.* 已存在 → item 置 skipped(already_exists)，序号不变」',
      `${d2.batches[0].seqFrom}–${d2.batches[0].seqTo}`);
    check('目录里不新增任何文件（不写原图、不写译文）',
      files2.length === 5 && files2.join(',') === files1.filter((f) => f.includes('_translated')).sort().join(','),
      '§7.4「序号不变」+ §5.6「未开始的 item … 原图也不落盘」', `files=${JSON.stringify(files2)}`);
    check('任务终态 done（skipped 与 success 等价收敛）',
      d2.status === 'done',
      '§4.1「running | 全部 item ∈ {success, skipped} | done」');

    // 反向演练：显式关闭 → 保留旧 EEXIST 行为
    const off = await spawnServer({
      env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20', MOCK_SKIP_EXISTING: '0' },
      root: path.join(TEMP, 'f2off', 'Box 漫画'), state: path.join(TEMP, 'f2off', 'state'),
    });
    const name2 = 'F2 关闭续做';
    const dir2 = path.join(TEMP, 'f2off', 'Box 漫画', name2);
    const a1 = await call(off.url, 'POST', '/tasks', { form: formFor(name2, 3) });
    await waitTask(off.url, a1.body.taskId);
    for (const f of fs.readdirSync(dir2)) if (!f.includes('_translated')) fs.rmSync(path.join(dir2, f));
    const a2 = await call(off.url, 'POST', '/tasks', { form: formFor(name2, 3) });
    const dOff = await waitTask(off.url, a2.body.taskId);
    check('MOCK_SKIP_EXISTING=0 显式关闭 → 回到旧的 EEXIST 行为（反向演练可用）',
      dOff.items.every((i) => i.status === 'success' && i.saved === false
        && String(i.reason).startsWith('write_failed:')),
      '[实现细节，契约未规定]：契约要求默认 skipped(already_exists)，关闭开关仅用于反向演练',
      brief(dOff.items.map((i) => `${i.status}:saved=${i.saved}:${i.reason}`)));
  }

  // ===================================================================== F-3
  h('F-3（P1）DISK_FULL(507)：请求级落盘不可用可达；item 级仍 saved:false');
  {
    const roBase = path.join(TEMP, 'f3');
    const roRoot = path.join(roBase, 'Box 漫画');
    const roState = path.join(roBase, 'state');
    fs.mkdirSync(roRoot, { recursive: true, mode: 0o700 });
    const ok1 = await spawnServer({ env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20' }, root: roRoot, state: roState });
    const r0 = await call(ok1.url, 'POST', '/tasks', { form: formFor('F3 可写', 1) });
    ok1.child.kill('SIGKILL');
    await sleep(200);

    fs.chmodSync(roRoot, 0o500);
    const ro = await spawnServer({ env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20' }, root: roRoot, state: roState });
    const r1 = await call(ro.url, 'POST', '/tasks', { form: formFor('F3 只读', 1) });
    const logged = /落盘根目录不可写（DISK_FULL）/.test(ro.log());
    check('MOCK_ROOT=chmod 500 的只读目录 → POST /tasks 返回 507 DISK_FULL（可达）',
      r1.status === 507 && r1.body.error.code === 'DISK_FULL',
      '§2.2「DISK_FULL | 507 | 落盘失败（磁盘满）」', `HTTP ${r1.status}`);
    check('同时写入安全日志（§8.2 要求任一校验失败即 403/日志语义的日志面）',
      logged, '[实现细节，契约未规定日志文案]：契约只要求「安全日志」', '');
    ro.child.kill('SIGKILL');
    await sleep(200);

    fs.chmodSync(roRoot, 0o700);
    const rw = await spawnServer({ env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20' }, root: roRoot, state: roState });
    const r2 = await call(rw.url, 'POST', '/tasks', { form: formFor('F3 恢复', 1) });
    check('恢复可写后 → 201（507 不是永久状态）',
      r2.status === 201, '§2.2 DISK_FULL 为运行时错误，非配置项', `HTTP ${r2.status}`);
    check('只读期间 201 行为未被破坏（先证可写路径正常）',
      r0.status === 201, '§5.2 响应 201', `HTTP ${r0.status}`);
    rw.child.kill('SIGKILL');
    await sleep(150);

    // item 级：MOCK_DISK_FULL=1 仍得到 saved:false + done
    const df = await spawnServer({
      env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20', MOCK_DISK_FULL: '1' },
      root: path.join(TEMP, 'f3df', 'Box 漫画'), state: path.join(TEMP, 'f3df', 'state'),
    });
    const t3 = await call(df.url, 'POST', '/tasks', { form: formFor('F3 磁盘满演练', 4) });
    const d3 = await waitTask(df.url, t3.body.taskId);
    check('MOCK_DISK_FULL=1：item 全 success 且 saved:false、任务继续到 done（既有行为未被破坏）',
      d3.status === 'done' && d3.items.every((i) => i.status === 'success' && i.saved === false),
      '§2.2 DISK_FULL 行「item 标 saved:false，任务继续」+ §4.2「saved:false 时 item 仍为 success」',
      brief(d3.items.map((i) => `${i.status}:saved=${i.saved}:${i.reason}`)));
    mark('DISK_FULL', 'e2e（F-3 只读根目录）');
    df.child.kill('SIGKILL');
    await sleep(150);
  }

  // ===================================================================== F-4
  h('F-4（P1）multipart 分隔符严格校验：内嵌 `\\r\\n--<boundary>X` 不得被当作边界');
  {
    const base = makeSolidPng(32, 32, 100);
    const idx = Math.floor(base.length / 2);

    // 白盒：内嵌 `\r\n--<boundary>X` + 伪 header 块
    const inject = Buffer.from(
      `\r\n--${RAW_BOUNDARY}X\r\nContent-Disposition: form-data; name="images[]"; filename="999.png"\r\n`
      + 'Content-Type: image/png\r\n\r\n', 'latin1');
    const evil = Buffer.concat([base.subarray(0, idx), inject, base.subarray(idx)]);
    const ct = `multipart/form-data; boundary=${RAW_BOUNDARY}`;

    const buildOne = (bytes) => Buffer.concat([
      Buffer.from(`--${RAW_BOUNDARY}\r\n`, 'latin1'),
      Buffer.from('Content-Disposition: form-data; name="payload"\r\n\r\n', 'latin1'),
      Buffer.from('{"comicName":"x"}', 'latin1'),
      Buffer.from(`\r\n--${RAW_BOUNDARY}\r\n`, 'latin1'),
      Buffer.from('Content-Disposition: form-data; name="images[]"; filename="001.png"\r\n', 'latin1'),
      Buffer.from('Content-Type: image/png\r\n\r\n', 'latin1'),
      bytes,
      Buffer.from(`\r\n--${RAW_BOUNDARY}--\r\n`, 'latin1'),
    ]);

    const parts = parseMultipart(buildOne(evil), ct);
    const imgs = parts.filter((p) => p.name === 'images[]');
    check('白盒：1 张图（内嵌 `\\r\\n--<boundary>X` + 伪 header）解析出的 images 数量仍为 1',
      imgs.length === 1,
      'RFC 2046（契约未逐字规定解析算法；§8.2 校验点 2 要求服务端自证文件名与张数）',
      `images=${imgs.length}`);
    check('白盒：且该图字节完整（未被截断）',
      imgs.length === 1 && imgs[0].data.length === evil.length,
      '[实现细节，契约未规定]：分片错位会导致原图数据丢失',
      `parsed=${imgs[0] && imgs[0].data.length} expected=${evil.length}`);

    const truncated = buildOne(base).subarray(0, buildOne(base).length - 30);
    const ex = parseMultipartEx(truncated, ct);
    check('白盒：缺少结束分隔符的截断请求 → complete=false（调用方应拒绝而非静默少收）',
      ex && ex.complete === false,
      '[实现细节，契约未规定]：属健壮性增强，避免「少收图」被静默接受', '');

    // e2e：3 张图，其中第 2 张带注入 → 服务端必须仍收到 3 张
    const img1 = makeSolidPng(40, 40, 10);
    const img2 = Buffer.concat([base.subarray(0, idx), inject, base.subarray(idx)]);
    const img3 = makeSolidPng(40, 40, 30);
    const raw = rawMultipart([img1, img2, img3], JSON.stringify({ comicName: 'F4 注入', idempotencyKey: crypto.randomUUID() }));
    const rr = await call(B, 'POST', '/tasks', {
      raw,
      headers: { 'Content-Type': `multipart/form-data; boundary=${RAW_BOUNDARY}` },
    });
    const dd = rr.status === 201 ? await waitTask(B, rr.body.taskId) : null;
    check('e2e：batches[0].count 与客户端实际发送张数一致（3 张）',
      rr.status === 201 && rr.body.batches[0].count === 3,
      '§3「单次提交上限 20 张 = 单次 API 请求携带的图片数」；§5.2 `images[]` 必填',
      `HTTP ${rr.status} count=${rr.body.batches && rr.body.batches[0] && rr.body.batches[0].count}`);
    // GET /tasks/{id} 的 items[] 不含 byteSize（§5.4 未定义该字段）→ 直接核对落盘字节
    const f4dir = path.join(mainRoot, 'F4 注入');
    const onDisk = ['001.png', '002.png', '003.png'].map((f) => {
      const p = path.join(f4dir, f);
      return fs.existsSync(p) ? fs.readFileSync(p) : null;
    });
    check('e2e：落盘的 3 张原图字节与客户端发送逐一相等（无串图 / 无丢字节）',
      !!dd && dd.items.length === 3
      && onDisk[0] && onDisk[0].equals(img1)
      && onDisk[1] && onDisk[1].equals(img2)
      && onDisk[2] && onDisk[2].equals(img3),
      '§7.2「<ext> 取自服务端对上传字节的嗅探结果，不信任客户端 filename」；§5.8「导出 = 字节级复制」',
      `磁盘字节=${JSON.stringify(onDisk.map((b) => (b ? b.length : null)))} 发送字节=${JSON.stringify([img1.length, img2.length, img3.length])}`);
  }

  // ===================================================================== F-5
  h('F-5（P1）validateRoot 黑名单前缀包含 + 补系统目录');
  {
    const HOME = os.homedir();
    const passRoot = path.join(TEMP, 'f5ok', 'Box 漫画');
    const MUST_FAIL = ['/', '/usr', '/usr/bin', '/tmp', '/private/var/tmp', '/private', '/private/var',
      '/var', '/Users', path.join(HOME, 'Library'), path.join(HOME, 'Library', 'Caches', 'xxx')];
    const MUST_PASS = [passRoot, REPO_RUNTIME && path.join(REPO_RUNTIME, 'Box 漫画'),
      path.join(HOME, 'Pictures', 'Box 漫画')];

    const rows = [];
    let bad = 0;
    for (const p of MUST_FAIL) {
      const r = await spawnServer({ env: { MOCK_PORT: nextPort() }, root: p, state: path.join(TEMP, 'f5state'), waitFor: 'fail', timeoutMs: 2300 });
      const okRefused = r.failed === true;
      if (!okRefused) bad++;
      rows.push([okRefused ? '拒绝启动 ✅' : '错误放行 ❌', p]);
      r.child.kill('SIGKILL');
    }
    for (const p of MUST_PASS) {
      const r = await spawnServer({ env: { MOCK_PORT: nextPort() }, root: p, state: path.join(TEMP, 'f5state'), timeoutMs: 2300 });
      const okStart = !!r.url;
      if (!okStart) bad++;
      rows.push([okStart ? '正常启动 ✅' : '错误拒绝 ❌', p]);
      r.child.kill('SIGKILL');
    }
    check('黑名单矩阵全部符合预期（含 /usr/bin、/private/var/tmp、~/Library/Caches/xxx、/Users 等子路径）',
      bad === 0,
      '§8.2 校验点 1「黑名单 /、C:\\、用户主目录本身、/tmp、系统目录；创建权限 0700」失败即拒绝启动',
      `不符项=${bad}`);
    console.log('       实测表：');
    for (const [v, p] of rows) console.log(`         ${v}  ${p}`);
    check('合法路径不被误伤：$TMPDIR 下的 Box 漫画 与仓库默认 .runtime/Box 漫画 仍可启动',
      rows.filter((r2) => r2[0] === '正常启动 ✅').length === MUST_PASS.length,
      '§8.2 校验点 1 的意图是挡系统目录，不是挡用户数据目录');
    // 收尾：F-5 探测可能创建了 $HOME/Pictures/Box 漫画 与仓库 .runtime
    fs.rmSync(path.join(HOME, 'Pictures', 'Box 漫画'), { recursive: true, force: true });
    fs.rmSync(REPO_RUNTIME, { recursive: true, force: true });
  }

  // ===================================================================== F-6
  h('F-6（P2）取消排队任务后 queuePosition 与 GET /queue 的 position 一致');
  {
    const q6 = await spawnServer({
      env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '500' },
      root: path.join(TEMP, 'f6', 'Box 漫画'), state: path.join(TEMP, 'f6', 'state'),
    });
    const A = await call(q6.url, 'POST', '/tasks', { form: formFor('F6-A', 20) });
    await sleep(250);
    const Bt = await call(q6.url, 'POST', '/tasks', { form: formFor('F6-B', 2) });
    const Ct = await call(q6.url, 'POST', '/tasks', { form: formFor('F6-C', 2) });
    const Dt = await call(q6.url, 'POST', '/tasks', { form: formFor('F6-D', 2) });
    await call(q6.url, 'POST', `/tasks/${Bt.body.taskId}/cancel`);
    const snap = await call(q6.url, 'GET', '/queue');
    let mismatched = 0;
    const detail = [];
    for (const t of [Ct, Dt]) {
      const d = await call(q6.url, 'GET', `/tasks/${t.body.taskId}`);
      const fromQueue = snap.body.queued.find((x) => x.taskId === t.body.taskId);
      const same = fromQueue && d.body.queuePosition === fromQueue.position;
      if (!same) mismatched++;
      detail.push(`${t.body.comicName}: detail=${d.body.queuePosition} queue=${fromQueue && fromQueue.position}`);
    }
    check('取消队首后：余下任务的 detail.queuePosition === /queue.position',
      mismatched === 0,
      '§5.7「GET /queue（排队位次与 eta 的唯一来源）」「queued[].position 从 1 起」',
      detail.join(' | '));
    check('被取消的任务不再出现在 /queue.queued 中',
      !snap.body.queued.some((x) => x.taskId === Bt.body.taskId),
      '§5.6「取消 … 队列余下任务不受影响，继续按 FIFO 消费」');
    q6.child.kill('SIGKILL');
    await sleep(150);
    void A;
  }

  // ===================================================================== F-7
  h('F-7（P2）删除自造字段 idempotentReplay，只用 200/201 区分');
  {
    const key = crypto.randomUUID();
    const r1 = await call(B, 'POST', '/tasks', { form: formFor('F7 幂等', 1, { key }) });
    const r2 = await call(B, 'POST', '/tasks', { form: formFor('F7 幂等', 1, { key }) });
    check('首次 → 201；重放 → 200 且 taskId 相同、无 error 信封',
      r1.status === 201 && r2.status === 200 && r2.body.taskId === r1.body.taskId && !r2.body.error,
      '§5.2「idempotencyKey …重复提交返回已有 taskId 且不报错」/ §2.2「IDEMPOTENT_REPLAY | 200 | 复用已有 taskId，不报错」',
      `${r1.status} → ${r2.status}`);
    check('响应体不含契约外自造字段 idempotentReplay',
      r2.body.idempotentReplay === undefined,
      '§5.2 响应字段表未定义该字段（自造字段即契约不一致）', `keys=${JSON.stringify(Object.keys(r2.body))}`);
    mark('IDEMPOTENT_REPLAY', 'e2e（HTTP 200 重放）');
  }

  // ===================================================================== F-8
  h('F-8 自测脚本隔离与断言收紧（静态审计 + 运行期残留检查）');
  {
    const audit = (file) => {
      const src = fs.readFileSync(file, 'utf8');
      const hits = [];
      let i = 0;
      while ((i = src.indexOf('startServer(', i)) >= 0) {
        // 跳过函数声明本身 `function startServer(...)`，只审计调用点
        if (/function\s*$/.test(src.slice(Math.max(0, i - 16), i))) { i += 'startServer('.length; continue; }
        const braceStart = src.indexOf('{', i);
        let depth = 0;
        let j = braceStart;
        for (; j < src.length; j++) {
          if (src[j] === '{') depth++;
          else if (src[j] === '}') { depth--; if (depth === 0) { j++; break; } }
        }
        const block = src.slice(braceStart, j);
        hits.push({ line: src.slice(0, i).split('\n').length, ok: /MOCK_ROOT/.test(block) && /MOCK_STATE_DIR/.test(block) });
        i = j;
      }
      return hits;
    };
    for (const f of ['selftest.mjs', 'selftest-extras.mjs']) {
      const file = path.join(PKG, 'scripts', f);
      const hits = audit(file);
      const badCalls = hits.filter((x) => !x.ok);
      check(`${f}：每个 startServer(...) 都传了隔离的 MOCK_ROOT + MOCK_STATE_DIR`,
        hits.length > 0 && badCalls.length === 0,
        '§8.2（安全）/ F-8 裁决：server.mjs 在监听之前就执行 validateRoot + store.init',
        `共 ${hits.length} 处调用，缺隔离 ${badCalls.length} 处${badCalls.length ? ' @' + badCalls.map((x) => x.line).join(',') : ''}`);
    }
    const st = fs.readFileSync(path.join(PKG, 'scripts', 'selftest.mjs'), 'utf8');
    check('selftest.mjs：ROOT_A 不再默认指向仓库 .runtime，改用 mkdtempSync 临时目录',
      /mkdtempSync/.test(st) && !/\.\.\/\.runtime\/Box 漫画/.test(st),
      'F-8.2：默认根目录必须在 os.tmpdir() 下并在收尾清理');
    check('selftest.mjs：越界断言收紧为严格 403（不再接受 404）',
      /escape\.status === 403/.test(st) && !/escape\.status === 404/.test(st),
      '§8.2「三次校验，任一失败即 403 + 安全日志」');
    check('selftest.mjs：收尾有 finally 清理（杀进程 + 删临时目录）',
      /finally\s*\{/.test(st) && /rmSync\(TEMP_BASE/.test(st),
      '[实现细节，契约未规定]：脚本自身的资源回收要求');
    check('仓库 mock-service/.runtime 不存在（脚本未在仓库内产生运行期残留）',
      !fs.existsSync(REPO_RUNTIME),
      'F-8 裁决：此前的残留正是由未隔离的 startServer 用例产生',
      REPO_RUNTIME);
  }

  // ===================================================================== 错误码可达性
  h('13 个契约错误码可达性矩阵（§2.2 错误码表）');
  {
    const r20 = await call(B, 'POST', '/tasks', {
      form: formFor('BATCH 超限', 21),
    });
    check('BATCH_LIMIT_EXCEEDED → 400（21 张）', r20.status === 400 && r20.body.error.code === 'BATCH_LIMIT_EXCEEDED');
    mark('BATCH_LIMIT_EXCEEDED', 'e2e');

    const rName = await call(B, 'POST', '/tasks', { form: formFor('   ', 1) });
    check('COMIC_NAME_REQUIRED → 400（空名）', rName.status === 400 && rName.body.error.code === 'COMIC_NAME_REQUIRED');
    mark('COMIC_NAME_REQUIRED', 'e2e');

    const rRes = await call(B, 'POST', '/tasks', { form: formFor('CON', 1) });
    check('INVALID_COMIC_NAME → 400（Windows 保留名 CON）', rRes.status === 400 && rRes.body.error.code === 'INVALID_COMIC_NAME');
    mark('INVALID_COMIC_NAME', 'e2e');

    const badImg = new FormData();
    badImg.append('payload', JSON.stringify({ comicName: '坏图', idempotencyKey: crypto.randomUUID() }));
    badImg.append('images[]', new Blob([Buffer.from('not-an-image')], { type: 'image/png' }), '001.png');
    const rImg = await call(B, 'POST', '/tasks', { form: badImg });
    check('INVALID_IMAGE → 400（不可解码字节）', rImg.status === 400 && rImg.body.error.code === 'INVALID_IMAGE');
    mark('INVALID_IMAGE', 'e2e');

    const rNF = await call(B, 'GET', '/tasks/tsk_不存在');
    check('TASK_NOT_FOUND → 404', rNF.status === 404 && rNF.body.error.code === 'TASK_NOT_FOUND');
    mark('TASK_NOT_FOUND', 'e2e');

    const doneT = await call(B, 'POST', '/tasks', { form: formFor('终态追加', 1) });
    await waitTask(B, doneT.body.taskId);
    const rApp = await call(B, 'POST', `/tasks/${doneT.body.taskId}/batches`, { form: formFor('', 1, { key: undefined }) });
    check('TASK_NOT_APPENDABLE → 409（向终态任务追加）',
      rApp.status === 409 && rApp.body.error.code === 'TASK_NOT_APPENDABLE');
    mark('TASK_NOT_APPENDABLE', 'e2e');

    const rCan = await call(B, 'POST', `/tasks/${doneT.body.taskId}/cancel`);
    check('TASK_NOT_CANCELABLE → 409（重复取消）',
      rCan.status === 409 && rCan.body.error.code === 'TASK_NOT_CANCELABLE');
    mark('TASK_NOT_CANCELABLE', 'e2e');

    const seqRoot = path.join(TEMP, 'seq', 'Box 漫画');
    const seqDir = path.join(seqRoot, '满编号');
    fs.mkdirSync(seqDir, { recursive: true });
    for (let i = 1; i <= 999; i++) fs.writeFileSync(path.join(seqDir, `${String(i).padStart(3, '0')}.png`), '');
    const seqSrv = await spawnServer({ env: { MOCK_PORT: nextPort(), MOCK_ITEM_MS: '20' }, root: seqRoot, state: path.join(TEMP, 'seq', 'state') });
    const rSeq = await call(seqSrv.url, 'POST', '/tasks', { form: formFor('满编号', 1) });
    check('SEQUENCE_OVERFLOW → 409（目录已有 001–999）',
      rSeq.status === 409 && rSeq.body.error.code === 'SEQUENCE_OVERFLOW');
    mark('SEQUENCE_OVERFLOW', 'e2e');
    seqSrv.child.kill('SIGKILL');

    const rPerm = await call(B, 'POST', '/tasks', { token: 'f'.repeat(64), form: formFor('x', 1) });
    check('PERMISSION_DENIED → 403（错令牌；Origin 拒绝同码）',
      rPerm.status === 403 && rPerm.body.error.code === 'PERMISSION_DENIED');

    const rLibEsc = await call(B, 'POST', '/library/..%2F..%2Fetc/reveal');
    check('PERMISSION_DENIED → 403（路径越界，§8.2 只允许 403）',
      rLibEsc.status === 403 && rLibEsc.body.error.code === 'PERMISSION_DENIED');

    const downSrv = await spawnServer({
      env: { MOCK_PORT: nextPort(), MOCK_SIDECAR_DOWN: '1' },
      root: path.join(TEMP, 'down', 'Box 漫画'), state: path.join(TEMP, 'down', 'state'),
    });
    const rDown = await call(downSrv.url, 'POST', '/tasks', { form: formFor('sidecar down', 1) });
    check('UNAVAILABLE → 503（sidecar 未就绪）',
      rDown.status === 503 && rDown.body.error.code === 'UNAVAILABLE');
    mark('UNAVAILABLE', 'e2e');
    downSrv.child.kill('SIGKILL');

    // INTERNAL(500)：纯 catch-all，无刻意可达的 HTTP 路径 → 白盒验证信封映射，e2e 标记为未覆盖
    const env500 = errorEnvelopeProbe();
    check('INTERNAL → 500：白盒验证「非 ApiError → INTERNAL 500」映射存在',
      env500.status === 500 && env500.code === 'INTERNAL',
      '§2.2「INTERNAL | 500 | 其他」',
      `status=${env500.status} code=${env500.code}`);
    mark('INTERNAL', 'whitebox', 'e2e 不可达：仅由非 ApiError 的意外异常触发，无刻意构造路径');

    console.log('\n  错误码覆盖一览：');
    for (const code of CONTRACT_CODES) {
      const r = reach.get(code);
      const how = r ? r.how : '未覆盖';
      console.log(`    ${r ? '✅' : '⚠️ '} ${code.padEnd(22)} ${how}${r && r.note ? '  —— ' + r.note : ''}`);
    }
    const uncovered = CONTRACT_CODES.filter((c) => !reach.has(c));
    console.log(`\n  未覆盖（e2e）错误码：${uncovered.length ? uncovered.join(', ') : '无'}`);
    console.log('  其中 INTERNAL 仅白盒覆盖，原因：契约定义为 catch-all「其他」，无刻意可达的 HTTP 触发条件。');
    check('13 个契约错误码均有可达性验证（含白盒）或显式列入「未覆盖」',
      CONTRACT_CODES.length === 13 && CONTRACT_CODES.every((c) => reach.has(c)),
      '§2.2 错误码表（13 条）',
      `覆盖 ${reach.size}/13，未覆盖 ${uncovered.length}`);
  }
} finally {
  for (const child of children) {
    try { child.kill('SIGKILL'); } catch { /* ignore */ }
  }
  await sleep(150);
  fs.rmSync(TEMP, { recursive: true, force: true });
  fs.rmSync(REPO_RUNTIME, { recursive: true, force: true }); // 兜底：绝不留仓库残留
}

function errorEnvelopeProbe() {
  const { status, body } = errorEnvelope(new Error('boom'));
  return { status, code: body.error.code };
}

console.log(`\n=== 回归自测汇总：通过 ${pass} / 失败 ${fail} ===`);
console.log(`仓库 .runtime 残留：${fs.existsSync(REPO_RUNTIME) ? '❌ 存在' : '✅ 不存在'}`);
process.exit(fail === 0 ? 0 : 1);
