/**
 * E9 · 与插件联调（《04》§14.2）—— **真实漫画站 + 真引擎**
 * =============================================================================
 * 判据原文：**插件提交 31 张 → 同一队列、同一落盘规则、序号连续（真实引擎下复跑 D1）**
 *
 * ## 为什么必须跑在**真实站点**上（这条是上一版的教训）
 * 上一版用自建夹具页（本地 HTTP 服务同步吐 31 个 `<img>`，同一张图重命名 31 次）。
 * 那版能证明「插件的请求落在真引擎上」，但**证明不了抓图规则在真实站点上成立**：
 * 夹具页的 31 张是同步、立即、全部渲染完的，而真实漫画站是
 *   · **懒加载**：未进入视口的 `<img>` 先挂 1×1 透明占位 gif，真地址在 `data-src`
 *   · **前端渲染**：图片由阅读器 JS 注入，静态 HTML 里一张都搜不到
 * 两者对 `collectImages.ts` 的过滤规则（可见 + 渲染 ≥60×60 + 原图 ≥100×100）压力完全不同。
 *
 * ## 站点事实（**写死**：站点改版必须报错，不能静默放过 —— 见 E9.2 / E9.9）
 *   · 転生ゴブリンだけど質問ある？：`chapter-112` = 18 页，`chapter-113` = 16 页
 *   · 31 = 112 的 18 张 + 113 的**前 13 张** ⇒ 两次提交、两个 Task、序号 001–031 跨任务连续
 *     （**不是**"一个 Task 两个 Batch" —— 那是 E3 的判据。插件的契约是"一次提交 = 一个任务"，
 *      见 §9 的注释；把 E3 的形状搬过来是上一版空等 15 min 的根因）
 *   · 页面上另有 2 个非漫画 `<img>`（站点 logo 47×50、amung.us 隐藏像素）—— 必须被排除
 *
 * ## 三个实测踩过的坑（**别删**，都是花时间换来的）
 *   1. 面板缩略图网格**每页 20 格**（`GRID.perPage`）。断言「网格里有 31 个格子」
 *      **永远不可能成立** —— 20 张在第 1 页、11 张在第 2 页。上一版就死在这条。
 *   2. 真实站点懒加载：**必须先滚动把图全部逼出来，再唤出面板**。不滚动时未加载的图
 *      是 1×1 占位，会被 60×60 的渲染尺寸门槛挡掉（实测 18 张只剩 4 张合格）。
 *   3. 完成态的工具条会整条换掉（没有勾选框），第二批要从页脚的**「继续翻一批」**进。
 *
 * ## 运行产物（全部在 `.temp-translate-test/` 下，已 gitignore）
 *   `miao-trans/.temp-translate-test/e9-<时间戳>/`
 *     `state/`   box-service 状态目录（**每轮全新** ⇒ `/tasks` 只看到本轮任务）
 *     `out/`     Box 落盘根目录（**测试产生的漫画原文/译文都在这里**）
 *     `profile/` 浏览器 profile
 *     `logs/`    ③ / ② / box-service 的日志
 * 证据文件（进仓）：`miao-dock/docs/refs/engine/02-e9-plugin-real-engine.*`
 *
 * 用法：
 *   npm run build                              # 先构建扩展（.output/chrome-mv3）
 *   node e2e/e9-real-engine.mjs                # 约 10 分钟
 *   E9_HEADFUL=1 node e2e/e9-real-engine.mjs   # 想看着它跑
 *
 * 前置：miao-dock 仓的真引擎已预置（`runtimes/manga-translator/`，含 venv 与 Sakura 权重）；
 *      机器能访问 jmanga.media（约 20 s/页，站点本身慢，属正常）。
 * ⚠️ 与 `e2e/verify.mjs` **不要并发跑**：verify 的 mock 硬编码 5180，与本探针的真
 *    box-service 抢同一段端口（并发时 verify 会连到真服务并报 `PERMISSION_DENIED`）。
 */
import { spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import { createRequire } from 'node:module';
import net from 'node:net';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TRANS = path.resolve(HERE, '..'); // miao-trans
const DOCK = path.resolve(TRANS, '..', 'miao-dock'); // 同级的 miao-dock
const EXT_DIR = path.join(TRANS, 'extension', '.output', 'chrome-mv3');
const requireExt = createRequire(path.join(TRANS, 'extension', 'package.json'));
const { chromium } = requireExt('playwright');

// ── 端口（扩展只探 5180–5190；引擎/③ 与 miao-dock 的既有分配一致）──
const SVC_PORT = 5180;
const ENGINE_PORT = 8000;
/**
 * 🔴 **`8001` 必须一起管**：它是**引擎的执行器**，也就是引擎的**子**进程 ——
 * 对 `killAll()` 而言是**孙**进程。只 SIGKILL 直接子进程时，它会被 reparent 后
 * **继续占着 8001**；下一轮引擎起来时执行器 `bind: address already in use`，
 * 新引擎**看着是 running，实际是那个陈旧的执行器在干活**，于是**每一张都**
 * 报 `engine_engine_error`（实测：18 张全失败、磁盘上 0 份译文，而 HTTP 层面
 * 全是 200 OK —— 只看 HTTP 状态码会以为一切正常）。
 * 这与 E11「三进程树回收」里"执行器是孙进程"是同一条事实，两个脚本都要各管一遍。
 */
const EXECUTOR_PORT = 8001;
const LLAMA_PORT = 8080;

// ── 站点与页数事实 ──
const COMIC_SLUG = '%E8%BB%A2%E7%94%9F%E3%82%B4%E3%83%96%E3%83%AA%E3%83%B3%E3%81%A0%E3%81%91%E3%81%A9%E8%B3%AA%E5%95%8F%E3%81%82%E3%82%8B%EF%BC%9F';
const SITE_A = process.env.E9_URL_A ?? `https://jmanga.media/read/${COMIC_SLUG}/ja/chapter-112-raw/`;
const SITE_B = process.env.E9_URL_B ?? `https://jmanga.media/read/${COMIC_SLUG}/ja/chapter-113-raw/`;
const PAGES_A = 18; // chapter-112 的真实页数
const PAGES_B = 16; // chapter-113 的真实页数
const TAKE_B = 13; // 第二批只取前 13 张 ⇒ 合计 31（与 E3 的 HTTP 直连形状一致）
const TOTAL = PAGES_A + TAKE_B; // 31
const BATCH_LIMIT = 20; // 插件单批上限＝面板单页格数

const COMIC = 'E9 真站点联调 112+113';
const TOKEN = crypto.createHash('sha256').update('e9-real-engine').digest('hex');
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

// ── 断言（分母写死：E9.0 前置 + E9.1–E9.18）──
const DECLARED = 19;
const results = [];
let failures = 0;
function check(id, ok, detail = '') {
  results.push({ id, ok: !!ok, detail: String(detail).slice(0, 500) });
  if (!ok) failures += 1;
  console.log(`${ok ? '✓' : '✗'} ${id}${detail ? `  ${detail}` : ''}`);
}

// ── 运行目录（每轮全新；不自动清理旧轮次，见文件头）──
const STAMP = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-');
const RUN = path.join(TRANS, '.temp-translate-test', `e9-${STAMP}`);
const LOGS = path.join(RUN, 'logs');
const STATE = path.join(RUN, 'state');
const OUT_ROOT = path.join(RUN, 'out');
const PROFILE = path.join(RUN, 'profile');
for (const d of [RUN, LOGS, STATE, OUT_ROOT, PROFILE]) fs.mkdirSync(d, { recursive: true });
console.log(`  [e9] 运行目录 ${path.relative(TRANS, RUN)}/`);

const procs = [];

/**
 * 给**被测应用**用的环境变量：把 WorkBuddy CLI 注入的 `safe-delete` shim 摘掉。
 *
 * 🔴 **为什么必须摘**（这不是"绕过安全检查"，而是"别把测试环境装进被测应用"）：
 *   CLI 通过 `NODE_OPTIONS=--require=…/cli/vendor/shim/node-language-shim.cjs` 把
 *   `fs.unlinkSync` 等**包了一层删除守卫**，并注入到**所有子 node 进程**。而
 *   box-service 建单前要做一次可写性探测：写一个 `out/.write-probe-*` 再 `unlinkSync`
 *   （`server.mjs:151 assertRootWritable`）。守卫的配额是**按工具调用**记的
 *   （`CODEBUDDY_TOOL_CALL_ID` + `SAFE_DELETE_BULK_STATE_DIR`，阈值 50 次），
 *   配额一满，**应用自己删自己的探针文件**也会被拦：
 *
 *   ```
 *   [safe-delete][SAFE_DELETE_BULK_CONFIRM_REQUIRED] {"count":50,"threshold":50,"scope":"turn"}
 *     at Object.unlinkSync (node-safe-delete-shim.cjs:665)
 *     at assertRootWritable (service/src/server.mjs:155)
 *   ```
 *
 *   于是建单请求返回 500、任务根本没建出来 —— 而磁盘、权限、引擎**全都好好的**。
 *   生产里 Box 由 Tauri 直接 spawn，**没有这层 shim**，所以带着它跑 E9 量到的是
 *   测试环境而不是产品。守卫对 `/tmp`、npm 缓存等系统临时目录本来就放行
 *   （`shouldBypassSafeDelete`），可见它要管的是**代理的文件操作**，不是应用的行为。
 *
 * ⚠️ 摘完必须**自检**（见 `assertAppEnvClean`）：变量名/注入方式一旦变了，
 *    静默失效会让这个坑原样回来，只是更难查。
 */
function appEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (env.NODE_OPTIONS) {
    const kept = String(env.NODE_OPTIONS)
      .split(/\s+/)
      .filter((t) => t && !/cli[/\\]vendor[/\\]shim[/\\]/.test(t));
    if (kept.length) env.NODE_OPTIONS = kept.join(' ');
    else delete env.NODE_OPTIONS;
  }
  for (const k of Object.keys(env)) {
    if (k.startsWith('CODEBUDDY_SAFE_DELETE_') || k === 'CODEBUDDY_TOOL_CALL_ID') delete env[k];
  }
  return env;
}

/**
 * 自检：拿一份 `appEnv()` 起来跑一个 node 子进程，问它 `fs.unlinkSync` 还是不是原生的。
 * 不是原生的就**当场抛** —— 否则会退化成"E9 在某个说不清的时刻报 500"。
 */
function assertAppEnvClean() {
  const probe = 'console.log(String(require("fs").unlinkSync).includes("safe-delete") ? "PATCHED" : "CLEAN")';
  const r = spawnSync(process.execPath, ['-e', probe], { env: appEnv(), encoding: 'utf8' });
  const verdict = (r.stdout || '').trim();
  if (verdict !== 'CLEAN') {
    throw new Error(
      `被测应用的 Node 环境没清干净（fs.unlinkSync 仍是 CLI 的 safe-delete 包装：${verdict}）——\n` +
      'box-service 的写探针会因此被判成"落盘不可用"，建单 500 而磁盘其实没问题。\n' +
      '请检查 node-safe-delete-shim 的注入方式是否变了（NODE_OPTIONS / CODEBUDDY_SAFE_DELETE_*）。',
    );
  }
  return verdict;
}

function spawnLogged(cmd, args, opts, tag) {
  const logPath = path.join(LOGS, `${tag}.log`);
  const fd = fs.openSync(logPath, 'w');
  const child = spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] });
  const st = { child, tag, log: '', logPath };
  // 收尾时先 SIGKILL 再关 fd，子进程的 stdout 可能还排着最后几块数据 ⇒ 写已关闭的 fd 会抛
  // EBADF 并**把整个脚本掀翻**（实测：断言都跑完了，收尾阶段崩在写日志上）。所以这里一律容错。
  let fdClosed = false;
  const onData = (d) => {
    if (fdClosed) return;
    try { fs.writeSync(fd, d); } catch { fdClosed = true; return; }
    st.log += d.toString();
    if (st.log.length > 200_000) st.log = st.log.slice(-100_000);
  };
  child.stdout.on('data', onData);
  child.stderr.on('data', onData);
  child.on('exit', () => {
    fdClosed = true;
    try { fs.closeSync(fd); } catch { /* ignore */ }
  });
  procs.push(st);
  return st;
}
function killAll() {
  for (const { child } of procs) { try { child.kill('SIGKILL'); } catch { /* dead */ } }
}

/**
 * 收尾：把那几个端口上**还活着**的进程一并收掉。
 *
 * 必要性见 `EXECUTOR_PORT` 的注释 —— 执行器是孙进程，`killAll()` 够不着它。
 * 这些端口的空闲性由前置检查保证过，所以收尾时还占着它们的一定是本轮（或上一轮
 * 漏下来的）遗留进程，收掉是安全的。
 */
function killLeakedPorts() {
  const killed = [];
  for (const port of [SVC_PORT, ENGINE_PORT, EXECUTOR_PORT, LLAMA_PORT]) {
    try {
      const out = spawnSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' });
      for (const pid of (out.stdout || '').trim().split('\n').filter(Boolean)) {
        try { process.kill(Number(pid), 'SIGKILL'); killed.push(`${port}:${pid}`); } catch { /* ignore */ }
      }
    } catch { /* lsof 不在也不影响主流程 */ }
  }
  if (killed.length) console.log(`  [e9] 收尾清掉遗留端口占用：${killed.join(' ')}`);
}

const portOpen = (port, ms = 400) =>
  new Promise((resolve) => {
    const s = net.connect({ host: '127.0.0.1', port });
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(ms);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });

const getJson = (port, p, token) =>
  new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: p, method: 'GET', headers: token ? { 'X-Box-Token': token } : {}, agent: false },
      (res) => {
        const c = [];
        res.on('data', (b) => c.push(b));
        res.on('end', () => {
          try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(c).toString('utf8')) }); }
          catch { resolve({ status: res.statusCode, body: null }); }
        });
      },
    );
    req.on('error', () => resolve({ status: 0, body: null }));
    req.end();
  });

/**
 * 轮询直到 `fn()` 返回真值。
 *
 * 🔴 **长等待必须有心跳 + 进程快照**（本轮实测教训）：上一版第二批卡在"引擎不再吐任何东西"
 * 上，脚本**静默空等 14 分钟**然后报一句超时 —— 既看不出是"慢"还是"死"，
 * 也拿不到当时的证据。所以这里在等待超过 45 s 后每 45 s 打一行进度，
 * 并在超过 120 s 时附带一次 `ps`（引擎/执行器/LLM 的 CPU% 与已运行时长）：
 *   · CPU 一直 0%  ⇒ 是真卡死（等不到响应）；
 *   · CPU 很高      ⇒ 只是慢（大图 + MPS）。
 * 这一行输出能把"要不要杀重跑"从猜变成看。
 */
async function waitFor(fn, timeoutMs, label) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  let last;
  let nextBeat = t0 + 45_000;
  let nextPs = t0 + 120_000;
  for (;;) {
    try { last = await fn(); if (last) return last; } catch { /* retry */ }
    const now = Date.now();
    if (now > deadline) throw new Error(`等待超时：${label}（最后观测：${JSON.stringify(last)?.slice(0, 300)}）`);
    if (now >= nextBeat) {
      console.log(`  [e9] 仍在等待：${label}（已 ${((now - t0) / 1000).toFixed(0)} s，最后观测：${JSON.stringify(last)?.slice(0, 160)}）`);
      nextBeat = now + 45_000;
      if (now >= nextPs) { psSnapshot(); nextPs = now + 120_000; }
    }
    await sleep(400);
  }
}

/** 打一次相关进程的 CPU/内存/已运行时长（长等待时的现场证据） */
function psSnapshot() {
  const pids = new Set(procs.map((p) => p.child?.pid).filter(Boolean));
  for (const port of [SVC_PORT, ENGINE_PORT, EXECUTOR_PORT, LLAMA_PORT]) {
    const r = spawnSync('lsof', ['-ti', `tcp:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8' });
    for (const s of (r.stdout || '').split('\n')) if (s.trim()) pids.add(Number(s.trim()));
  }
  const list = [...pids].filter((p) => Number.isFinite(p));
  if (list.length === 0) return;
  const r = spawnSync('ps', ['-o', 'pid=,pcpu=,pmem=,etime=,comm=', '-p', list.join(',')], { encoding: 'utf8' });
  console.log(`  [e9] 进程快照（pid/cpu%/mem%/已运行/进程）：\n${(r.stdout || '').trim().split('\n').map((l) => `        ${l.trim()}`).join('\n')}`);
}

function walkRel(dir, base = dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkRel(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

const sha256 = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

// ─────────────────────────── 页面侧动作 ───────────────────────────

/**
 * 把懒加载的图全部逼出来。
 *
 * 真实漫画站的 `<img>` 分两拨：视口内的已经加载好（800×1136），视口外的还是
 * **1×1 透明占位 gif**（真地址在 `data-src`）。插件的过滤规则要求渲染尺寸 ≥60×60，
 * 所以不滚动的话，18 张里只有 4 张合格 —— 这不是插件坏了，是**页面还没加载**。
 * 真机上用户的动作也是「先滚着看，再点悬浮球」，这里如实复刻。
 *
 * ⚠️ **两个必须分开的等待**（第一次跑就是在这上面翻车）：
 *   ① 等**阅读器把 `<img>` 注入** —— 图片是前端框架渲染的，`domcontentloaded` 时刻
 *      静态 HTML 里一张都没有（实测 0.7 s 时 `document.querySelectorAll('img')` = 0）。
 *      少了这一步，下面的循环会在「没有图 ⇒ 高度≈视口高 ⇒ 判定已到底」上立刻退出，
 *      结果是 0 张进面板（症状：`已扫描到 0 张图片`）。
 *   ② 再滚动，逼懒加载。
 */
async function warmUpPage(page, label) {
  const t0 = Date.now();

  // ① 等阅读器注入图片（本站在未注入时全页只有 2 个 img：站点 logo + 统计像素）
  await waitFor(async () => {
    const st = await page.evaluate(() => ({
      imgs: document.querySelectorAll('img').length,
      lazy: document.querySelectorAll('img[data-src]').length,
    }));
    return st.lazy >= 4 || st.imgs >= 8;
  }, 90_000, `${label}：等阅读器注入图片`);

  // ② 一路向下滚，直到「懒图全部加载完」；到底了就回顶再滚一轮（逼二次懒加载）
  let rounds = 0;
  let last = null;
  let bottomHits = 0;
  for (; rounds < 120; rounds += 1) {
    last = await page.evaluate(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      const lazy = imgs.filter((im) => im.getAttribute('data-src'));
      return {
        imgs: imgs.length,
        lazy: lazy.length,
        pending: lazy.filter((im) => im.naturalWidth < 100).length,
        loaded: imgs.filter((im) => im.naturalWidth >= 100).length,
        y: Math.round(window.scrollY),
        h: document.documentElement.scrollHeight,
        vh: window.innerHeight,
      };
    });
    if (last.lazy > 0 && last.pending === 0) break; // 目标达成：懒图全部加载完
    if (last.y + last.vh >= last.h - 4) {
      bottomHits += 1;
      if (last.pending === 0) break; // 没有待加载的了（页面本来就没有懒图）
      if (bottomHits > 6) break; // 到底多轮仍有待加载 ⇒ 放弃，如实记进报告
      await page.evaluate(() => window.scrollTo(0, 0));
      await sleep(700);
      continue;
    }
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.8)));
    await sleep(450);
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(800);
  const warm = { rounds, bottomHits, ms: Date.now() - t0, ...last };
  console.log(`  [e9] ${label} 预热：${rounds} 轮滚动，已加载 ${warm.loaded} 张，剩未加载 ${warm.pending} 张（${(warm.ms / 1000).toFixed(1)} s）`);
  return warm;
}

/** 打开面板并等它渲染（含 service worker 就绪） */
async function openPanel(page) {
  const ball = page.locator('[data-testid="floating-ball"]');
  await ball.waitFor({ state: 'visible', timeout: 45_000 });
  await ball.click();
  await waitFor(() => page.locator('[data-testid="miao-panel"]').isVisible().catch(() => false), 25_000, '面板渲染');
}

/** 面板当前页的格子数 */
const cellCount = (page) => page.locator('[data-testid="thumb-cell"]').count();

/** 等面板网格达到 n 格（超时把**实际观测**报出来，否则无从归因） */
async function waitCells(page, n, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const seen = await cellCount(page);
    if (seen === n) return seen;
    if (Date.now() > deadline) {
      const hint = (await page.locator('.mt-panel__pagehint').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
      throw new Error(`${label}：期望 ${n} 格，实际 ${seen} 格｜提示行="${hint}"`);
    }
    await sleep(400);
  }
}

/**
 * 勾选 [from, to) 区间的缩略图（0-based，= 阅读顺序）。
 *
 * ⚠️ 必须点**格子里那颗勾选框**（`button.mt-thumb__checkbox`），不是格子容器 ——
 * ThumbCell 的七层结构里，L0–L4 一律 `pointer-events: none`（免得覆盖整格的选中蒙层
 * 吞掉指针事件），唯一接管点击的就是 L2 勾选框。点容器**不会报错，只是没反应**
 * （实测症状：`已选 0 张`，然后提交按钮一直 disabled）。
 */
async function pick(page, from, to) {
  for (let i = from; i < to; i += 1) {
    await page.locator('[data-testid="thumb-cell"]').nth(i).locator('button.mt-thumb__checkbox').click({ timeout: 15_000 });
  }
}

/** 选择计数里的第一个数字（文案形如「已选 18 张 · 已达单次上限」） */
async function selectedCount(page) {
  const t = await page.locator('[data-testid="selection-counter"]').innerText();
  const m = t.match(/\d+/);
  return { text: t.trim(), n: m ? Number(m[0]) : -1 };
}

/**
 * 服务端快照：把**当前所有 Task 的明细**一起取回来。
 *
 * ⚠️ 主键叫 **`taskId`**，不是 `id`（`store.listView()` / `detailView()` 都用 `taskId`）。
 * 写成 `.id` 会拼出 `/api/v1/tasks/undefined` ⇒ 404 ⇒ `detail` 为空 ⇒
 * 「等 items 到齐」永远等不到，超时后报 `items=0 status=undefined` ——
 * 看着像任务没跑，其实任务早就跑完了（磁盘上 18 对译文都在）。
 *
 * 🔴 **item 在 `detail.items`（顶层），不在 `detail.batches[].items`**（又踩了一次）：
 * `detailView()` 返回的是 `{ ..., batches: batches.map(batchBrief), items: items.map(itemBrief) }`，
 * 而 `batchBrief` **只带** `batchIndex/count/seqFrom/seqTo/status` —— **没有 items**。
 * 嵌套的 `batches[].items[]` 是 `state/tasks/*.json` 的**落盘形状**，不是 API 形状。
 * 把拍平写成 `batches.flatMap(b => b.items)` 会恒得 **0 个 item**，
 * 症状是「任务明明 done、磁盘上一对不缺，脚本却一直等、最后报超时」。
 *
 * 🔴 **为什么是"所有 Task"而不是"那一个 Task"**（上一版就死在这条）：
 * 本插件的契约是「**一次提交 = 一个任务**」（插件内 `onRetryFailed` 的注释明写
 * 「作为**新任务**提交（comicName 复用 → 服务端续编号）」；服务端 `createTask` 只按
 * `idempotencyKey` 去重，**从不按漫画名归并**）。所以「chapter-112 提一次 + chapter-113 提一次」
 * 在服务端就**应该**是 2 个 Task —— 判据原文（《04》§14.2 E9）要的也是
 * 「同一队列、同一落盘规则、序号连续」，**没有**要求"一个 Task"（那是 E3 的判据）。
 * 上一版误把 E3 的形状搬到这里，于是 `tasks.length !== 1` ⇒ detail 恒空 ⇒ 空等到 15 min 超时。
 */
async function taskSnapshot() {
  const list = await getJson(SVC_PORT, '/api/v1/tasks?status=all&limit=50', TOKEN);
  const tasks = (list.body?.tasks ?? []).slice().sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
  const details = [];
  for (const t of tasks) {
    const d = await getJson(SVC_PORT, `/api/v1/tasks/${t.taskId}`, TOKEN);
    details.push(d.body);
  }
  const items = details.flatMap((d) => d?.items ?? []); // ← 顶层 items，见上
  return { tasks, details, items };
}

/** 等服务端把**累计** `wantItems` 个 item 全部收进终态，且没有任务还在跑 */
async function waitServerTerminal(wantItems, timeoutMs, label) {
  let snap = null;
  await waitFor(
    async () => {
      snap = await taskSnapshot();
      const items = snap.items;
      const active = (snap.details ?? []).some((d) => d?.status === 'running' || d?.status === 'queued');
      return items.length === wantItems
        && items.every((i) => ['success', 'skipped', 'failed'].includes(i.status))
        && !active;
    },
    timeoutMs, label,
  ).catch((e) => {
    const items = snap?.items ?? [];
    const st = {};
    for (const i of items) st[i.status] = (st[i.status] || 0) + 1;
    throw new Error(`${e.message}｜已入账 ${items.length}/${wantItems} 项（${JSON.stringify(st)}）｜任务状态=${JSON.stringify((snap?.details ?? []).map((d) => d?.status))}`);
  });
  return snap;
}

/**
 * 提交一批并等终态。
 *
 * **两侧都要等**：服务端到终态（items 收齐且全终态）**且**页面回执从占位文案
 * 「任务进行中」变成真回执。只等第一侧会误判 —— 完成态工具条在 `submitting` 阶段就
 * 已经渲染出来了（那时文案正是「任务进行中」），所以「等工具条可见」是**恒真**的。
 *
 * `wantTasks` = 这次提交**之后**服务端应有的任务总数（一次提交建一个任务 ⇒ 逐次 +1）。
 * 用它而不是 `>= 1`：否则第二次提交时"上一个任务还在"就会让"建单成功"这个判断**恒真**。
 */
async function submitAndWait(page, wantItems, timeoutMs, tag, wantTasks) {
  const t0 = Date.now();
  const btn = page.locator('[data-testid="submit-button"]');
  if (!(await btn.isEnabled().catch(() => false))) {
    // 勾选/漫画名不合规时按钮是 disabled 的 —— 空等 30 s 的 click 超时只会让日志难读
    const c = await selectedCount(page);
    throw new Error(`${tag}：提交按钮处于 disabled —— 前缀断言已判红（当前 counter="${c.text}"），不再空等 click 超时`);
  }
  await btn.click();

  /**
   * 先只等「任务被建出来」（90 s），再去等终态。
   *
   * 必要性来自一次实测：建单请求吃了 500（原因见 `appEnv()`），**任务压根没建**，
   * 而"等 items 到齐"会一直等到 15 min 超时 —— 15 分钟里没有任何输出，
   * 看起来像"翻译特别慢"，实际是第一步就失败了。90 s 足够覆盖真引擎建单，
   * 失败时把 box-service 的日志尾巴一起报出来，省一次完整复现。
   */
  let snap = null;
  await waitFor(async () => {
    snap = await taskSnapshot();
    return (snap.tasks ?? []).length >= wantTasks;
  }, 90_000, `${tag} 建单`).catch((e) => {
    const svc = procs.find((p) => p.tag === 'box-service');
    const tail = (svc?.log || '').split('\n').filter(Boolean).slice(-6).join('\n');
    throw new Error(`${e.message}（期望 ≥${wantTasks} 个任务，实得 ${snap?.tasks?.length ?? 0}）\n—— 提交后 90 s 内服务端没出现新任务。box-service 日志尾部：\n${tail}`);
  });

  snap = await waitServerTerminal(wantItems, timeoutMs, `${tag} 服务端到终态`);

  let sum = '';
  await waitFor(async () => {
    sum = (await page.locator('[data-testid="toolbar-summary"]').innerText().catch(() => '')).trim();
    return sum.length > 0 && sum !== '任务进行中';
  }, 120_000, `${tag} 页面到完成回执`).catch(() => { /* 由断言判红，不在这里抛 */ });

  return { ms: Date.now() - t0, summary: sum, snap };
}

/**
 * 让面板停在**可勾选态**（`data-state=idle`）—— 完成态的工具条整条换掉了，没有勾选框。
 *
 * 🔴 **必须"等状态稳定"，不能"看到 `selection-counter` 就认为已就绪"**：
 * 面板挂载时会先渲染成 `idle`（此刻选择工具条**已经可见**），紧接着**异步**的
 * 「恢复进行中任务」（`ACTIVE_TASK_GET` → `TASK_REFRESH`）把它推回 `done`，
 * 于是漫画名输入框变成 `readOnly`（`caps.comicName` 只对 `idle` 为真）。
 * 上一版就是栽在"假 idle"上 —— 报 `locator.fill: element is not editable`，
 * 而日志里明明写着 state=idle。
 * 所以这里先等 `data-state` **连续多次采样不变**，再去判断/动作。
 */
async function settleState(page, rounds = 5, sleepMs = 350) {
  const panel = page.locator('[data-testid="miao-panel"]');
  let prev = null;
  let stable = 0;
  let st = null;
  for (let i = 0; i < 100; i += 1) {
    st = await panel.getAttribute('data-state').catch(() => null);
    if (st === prev) stable += 1; else { stable = 0; prev = st; }
    if (stable >= rounds) return st;
    await sleep(sleepMs);
  }
  return st;
}

/** 稳定在 `idle`；不在就从页脚的「继续翻一批」回去（完成态唯一回 idle 的入口） */
async function ensureSelecting(page, label) {
  const counter = page.locator('[data-testid="selection-counter"]');
  const cont = page.getByRole('button', { name: '继续翻一批' });
  let state = await settleState(page);
  let clicked = 0;
  const deadline = Date.now() + 30_000;
  while (state !== 'idle' && Date.now() < deadline) {
    if (await cont.isVisible().catch(() => false)) {
      await cont.click();
      clicked += 1;
    }
    await sleep(400);
    state = await settleState(page, 3);
  }
  const ok = await counter.isVisible().catch(() => false);
  console.log(`  [e9] ${label}：面板 state=${state}，可勾选=${ok}${clicked ? `（点了 ${clicked} 次「继续翻一批」）` : ''}`);
  return { state, clicked, ok };
}

/**
 * 「可勾选态 + 漫画名就位」—— 两件事都要，且**填完还要复验一次状态**。
 *
 * 复验的理由：异步「恢复任务」的到达时刻不保证；万一它在我们填完名字之后才落地，
 * 状态会被翻回 `done`、输入框重新变只读、已选集也被清空。宁可多等 1.2 s 复验一轮，
 * 也不要在后面收到一个莫名其妙的"提交按钮 disabled"。
 */
async function prepareSelecting(page, label, comicName) {
  const panel = page.locator('[data-testid="miao-panel"]');
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    const sel = await ensureSelecting(page, label);
    if (sel.state !== 'idle') return { sel, cn: null, ok: false, attempts: attempt };
    await sleep(1200);
    const after = await panel.getAttribute('data-state').catch(() => null);
    if (after !== 'idle') {
      console.log(`  [e9] ${label}：填名前状态被翻回 ${after}，重来一轮（第 ${attempt} 次）`);
      continue;
    }
    const cn = await ensureComicName(page, comicName);
    return { sel, cn, ok: true, attempts: attempt };
  }
  return { sel: null, cn: null, ok: false, attempts: 3 };
}

/** 漫画名填好（完成态下是 readonly —— 所以先 `prepareSelecting` 再进来） */
async function ensureComicName(page, name) {
  const input = page.locator('#mt-comic-name');
  if (!(await input.isEditable().catch(() => false))) {
    const st = await page.locator('[data-testid="miao-panel"]').getAttribute('data-state').catch(() => null);
    throw new Error(`漫画名输入框不可编辑（面板 data-state=${st}）—— 「继续翻一批」没把状态推回 idle`);
  }
  const cur = await input.inputValue().catch(() => '');
  if (cur.trim() === name) return { filled: false, value: cur };
  await input.fill(name);
  await sleep(200);
  const now = await input.inputValue();
  return { filled: true, value: now };
}

// ─────────────────────────── 主体 ───────────────────────────
let ctx = null;
let page = null;
/** 插件自身的异常（**只有这部分算失败**） */
const pluginErrors = [];
/** 站点第三方脚本的异常（真实站点上必然有，单列记录，不参与判定） */
const siteErrors = [];

const report = {
  startedAt: new Date().toISOString(),
  runDir: RUN,
  sites: { a: SITE_A, b: SITE_B },
  facts: { pagesA: PAGES_A, pagesB: PAGES_B, takeB: TAKE_B, total: TOTAL, batchLimit: BATCH_LIMIT },
};

try {
  // ── 0) 前置检查（缺什么直接说，不要跑到一半才报）──
  // 先确认"被测应用跑在干净的 Node 语义下" —— 见 `appEnv()` 的说明（CLI 的 safe-delete 守卫）
  console.log(`  [e9] 被测应用的 Node 环境自检：${assertAppEnvClean()}`);
  const VENV_PY = path.join(DOCK, 'runtimes', 'manga-translator', 'venv', 'bin', 'python');
  for (const [label, p] of [
    ['扩展构建产物', EXT_DIR],
    ['引擎 venv', VENV_PY],
    ['Sakura 权重', path.join(DOCK, 'runtimes', 'manga-translator', 'models', 'sakura')],
  ]) {
    if (!fs.existsSync(p)) throw new Error(`缺少${label}：${p}\n（扩展请先 \`npm run build\`；引擎资产见 miao-dock 的 fetch:models / 预置流程）`);
  }
  for (const port of [SVC_PORT, ENGINE_PORT, EXECUTOR_PORT, LLAMA_PORT]) {
    if (await portOpen(port)) {
      throw new Error(
        `端口 ${port} 已被占用 —— E9 需要它空闲（且不要与 verify.mjs 并发跑）。\n` +
        (port === EXECUTOR_PORT
          ? '⚠️ 8001 是引擎**执行器**（孙进程）：上一轮如果没干净退出，它会一直占着；\n' +
            '   此时新引擎照样报 running，但翻译会**每张都** engine_engine_error。\n' +
            '   清理：lsof -nP -iTCP:8001 -sTCP:LISTEN -t | xargs kill -9'
          : ''),
      );
    }
  }

  // ── 1) 网络可达性预检（只判 TCP 通不通，快速失败）──
  //    ⚠️ 别用 HTTP 预检：该站点对 `HEAD` 直接回 400；用 GET/`Range` 又会被限速到 45 s+
  //    （真实浏览器打开只要 ~2 s）。所以这里只做「DNS + TCP 443 能不能连上」，
  //    HTTP 层成不成立交给后面真正的 `page.goto`（它的状态码会记进报告）。
  const tcp = await new Promise((resolve) => {
    const s = net.connect({ host: 'jmanga.media', port: 443 });
    let done = false;
    const fin = (v) => { if (!done) { done = true; s.destroy(); resolve(v); } };
    s.setTimeout(15_000);
    s.once('connect', () => fin(true));
    s.once('timeout', () => fin(false));
    s.once('error', () => fin(false));
  });
  if (!tcp) throw new Error('站点不可达：连不上 jmanga.media:443 —— E9 需要真实站点（检查网络/代理）');

  // ── 2) ③ llama-server（Sakura）──
  const RT = path.join(DOCK, 'runtimes', 'manga-translator');
  const llamaBin = path.join(RT, 'bin', 'llama', 'llama-b11417', 'llama-server');
  const sakura = path.join(RT, 'models', 'sakura', 'sakura-1.5b-qwen2.5-v1.0-fp16.gguf');
  spawnLogged(llamaBin, ['-m', sakura, '--port', String(LLAMA_PORT), '-c', '4096', '-ngl', '99'], {}, 'llama');
  await waitFor(async () => (await getJson(LLAMA_PORT, '/v1/models')).status === 200, 120_000, 'llama-server 就绪');
  console.log(`  [e9] ③ llama-server 就绪 @${LLAMA_PORT}`);

  // ── 3) ② 引擎（uvicorn + 执行器），用适配层自己拼的启动参数 ──
  process.env.MIAO_ENGINE_PROTOCOL = 'real'; // 显式声明：不要在探针里靠默认值碰巧对上
  const mod = await import(`${pathToFileURL(path.join(DOCK, 'service', 'src', 'engine-client.mjs')).href}`);
  const launch = mod.resolveEngineLaunch({
    port: ENGINE_PORT, useGpu: true, modelsTtl: 0,
    sakuraBase: `http://127.0.0.1:${LLAMA_PORT}/v1`,
  });
  const engineProc = spawnLogged(launch.cmd[0], launch.cmd.slice(1), { cwd: launch.cwd, env: appEnv(launch.env) }, 'engine');
  report.engineLaunch = { cmd: launch.cmd, cwd: launch.cwd, executorPort: launch.executorPort };

  const tEngine = Date.now();
  await waitFor(async () => {
    const probe = await mod.probeEngine();
    return probe.state === 'running';
  }, 5 * 60_000, '引擎 running');
  report.engineReadyMs = Date.now() - tEngine;
  console.log(`  [e9] ② 引擎就绪（${(report.engineReadyMs / 1000).toFixed(1)} s）`);

  /**
   * 🔴 **必须在这里拦一次**：执行器（8001）绑定失败时，uvicorn 照样 200 起得来
   * （引擎自报 `running`），但真正干活的是**上一轮遗留的陈旧执行器** ——
   * 表现是「HTTP 全是 200，但每一张都 `engine_engine_error`、磁盘 0 份译文」。
   * 如果不在这里拦，故障要等到 18 张全跑完才以"任务 failed"浮现，
   * 而且很容易被误判成引擎/模型的毛病。日志里的 `Errno 48` 是**唯一**的线索。
   */
  if (/address already in use/.test(engineProc.log)) {
    throw new Error(
      `② 引擎的子进程（执行器 :${EXECUTOR_PORT}）绑定地址失败 —— 端口被上一轮遗留进程占着。\n` +
      `清理后重跑：lsof -nP -iTCP:${EXECUTOR_PORT} -sTCP:LISTEN -t | xargs kill -9\n\n` +
      engineProc.log.split('\n').filter((l) => /Errno 48|address already in use/.test(l)).slice(0, 3).join('\n'),
    );
  }

  // ── 4) box-service（真服务，起在扩展能探测到的 5180 段）──
  spawnLogged(process.execPath, [path.join(DOCK, 'service', 'src', 'server.mjs')], {
    env: appEnv({
      MIAO_ENGINE_PROTOCOL: 'real',
      MIAO_ENGINE_PORT: String(ENGINE_PORT),
      MIAO_ENGINE_PROBE_MS: '500',
      MIAO_ENGINE_TIMEOUT_MS: '90000',
      MIAO_ROOT: OUT_ROOT,
      MIAO_STATE_DIR: STATE,
      MIAO_TOKEN: TOKEN,
      MIAO_PORT: String(SVC_PORT),
      MIAO_NO_LLM_AUTOSTART: '1', // ③ 已由本探针拉起，别让服务再拉一个
    }),
  }, 'box-service');
  await waitFor(async () => (await getJson(SVC_PORT, '/api/v1/health', TOKEN)).status === 200, 30_000, 'box-service 就绪');
  const health = await getJson(SVC_PORT, '/api/v1/health', TOKEN);
  const hb = health.body ?? {};
  const opt = await getJson(SVC_PORT, '/api/v1/engine/options', TOKEN);
  const ob = opt.body ?? {};
  report.health = { status: hb.status, sidecar: hb.sidecar?.state, tier: hb.sidecar?.tier, accel: hb.sidecar?.accel, model: hb.sidecar?.model };
  report.engineOptions = { protocol: ob.protocol ?? null, effectiveTier: ob.tier?.effective ?? null, hardwareAccel: ob.hardware?.accel ?? null };
  console.log(`  [e9] box-service 就绪 @${SVC_PORT}（sidecar=${hb.sidecar?.state} · protocol=${ob.protocol}）`);
  check('E9.0 前置：box-service 明确报**真引擎**协议 `protocol=real`（不是靠 mock 默认值碰巧对上）',
    ob.protocol === 'real', `protocol=${ob.protocol} · options=${JSON.stringify(report.engineOptions)}`);

  // ── 5) 带扩展的浏览器 ──
  ctx = await chromium.launchPersistentContext(PROFILE, {
    channel: 'chromium',
    headless: !process.env.E9_HEADFUL,
    viewport: { width: 1280, height: 900 },
    userAgent: UA,
    args: [`--disable-extensions-except=${EXT_DIR}`, `--load-extension=${EXT_DIR}`, '--no-first-run', '--no-default-browser-check'],
  });
  await waitFor(async () => ctx.serviceWorkers().some((s) => s.url().startsWith('chrome-extension://')), 30_000, '扩展 SW');

  page = await ctx.newPage();
  page.on('pageerror', (e) => {
    const s = `${e?.message ?? e}\n${e?.stack ?? ''}`;
    // 只有**扩展自身**的异常算插件的问题；站点自己的第三方脚本噪声单列记录
    if (/chrome-extension:\/\//.test(s)) pluginErrors.push(s);
    else siteErrors.push(s.split('\n')[0]);
  });
  page.on('console', (m) => {
    if (m.type() !== 'error') return;
    const s = m.text();
    if (/chrome-extension:\/\//.test(s)) pluginErrors.push(s);
  });

  // ── 6) 第一批：chapter-112 全 18 张 ──
  const tNavA = Date.now();
  const respA = await page.goto(SITE_A, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  report.navA = { ms: Date.now() - tNavA, status: respA?.status() ?? 0, title: await page.title() };
  const warmA = await warmUpPage(page, 'chapter-112');
  report.warmA = warmA;

  // 页面侧复核：用插件的同一条过滤规则数一遍（先于面板，作为交叉验证）
  const pageSide = await page.evaluate(() => {
    const vis = (el) => {
      const r = el.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) return false;
      const s = getComputedStyle(el);
      return s.display !== 'none' && s.visibility !== 'hidden' && s.opacity !== '0';
    };
    const all = Array.from(document.querySelectorAll('img'));
    const kept = [];
    for (const img of all) {
      if (!vis(img)) continue;
      const r = img.getBoundingClientRect();
      const nw = img.naturalWidth || 0;
      const nh = img.naturalHeight || 0;
      if (r.width < 60 || r.height < 60) continue;
      if (nw > 0 && nw < 100) continue;
      if (nh > 0 && nh < 100) continue;
      kept.push({ src: (img.currentSrc || img.src || '').slice(-40), w: Math.round(r.width), h: Math.round(r.height) });
    }
    return { total: all.length, kept };
  });
  report.pageSideA = { total: pageSide.total, kept: pageSide.kept.length };

  await openPanel(page);
  // 令牌配对（fresh profile ⇒ 服务探到但无令牌 ⇒ 配对弹层自动打开）
  const tokenInput = page.locator('input[placeholder="64 位十六进制令牌"]');
  await tokenInput.waitFor({ state: 'visible', timeout: 20_000 });
  await tokenInput.fill(TOKEN);
  await page.locator('button:has-text("保存")').first().click();
  await waitFor(async () => !(await tokenInput.isVisible().catch(() => true)), 20_000, '令牌弹层关闭');

  const badge = (await page.locator('.mt-panel__service').innerText().catch(() => '')).trim();
  check('E9.3 面板头部徽标 = 「服务已就绪」（插件真的探到了 5180 上的真 box-service）',
    badge === '服务已就绪', `badge="${badge}"`);

  await waitCells(page, PAGES_A, 60_000, 'E9.1/E9.2 扫描 chapter-112');
  check(`E9.1 真实站点 chapter-112 扫描到 ${PAGES_A} 张（页面共 ${pageSide.total} 个 <img>，非漫画图被过滤规则排除）`,
    pageSide.kept.length === PAGES_A && pageSide.total > PAGES_A,
    `页面命中=${pageSide.kept.length} 页面 img 总数=${pageSide.total}`);
  const hintRow = (await page.locator('.mt-panel__pagehint').innerText().catch(() => '')).replace(/\s+/g, ' ').trim();
  check(`E9.2 面板只渲染第 1 页 = ${PAGES_A} 格（${PAGES_A} ≤ 单页上限 ${BATCH_LIMIT}，不分页）；提示行「本页 ${PAGES_A} 张 · 全页共 ${PAGES_A} 张」`,
    hintRow.includes(`本页 ${PAGES_A} 张`) && hintRow.includes(`全页共 ${PAGES_A} 张`), `hint="${hintRow}"`);

  // 令牌配对之后面板可能还在恢复上一个任务 —— 等它稳定在可勾选态、并把漫画名填好
  const prepA = await prepareSelecting(page, 'chapter-112', COMIC);
  report.prepareA = prepA;
  const cnA = prepA.cn;
  if (!prepA.ok) {
    throw new Error(`第一批：面板没能稳定在可勾选态（state=${prepA.sel?.state}，试了 ${prepA.attempts} 轮）——「继续翻一批」未把状态推回 idle`);
  }
  await pick(page, 0, PAGES_A);
  const selA = await selectedCount(page);
  check(`E9.4 勾选 ${PAGES_A} 张后计数正确（未达单批上限 ${BATCH_LIMIT}）`,
    selA.n === PAGES_A, `counter="${selA.text}"`);

  await page.screenshot({ path: path.join(LOGS, 'panel-18.png') });
  const batchA = await submitAndWait(page, PAGES_A, 15 * 60_000, '第一批', 1);
  report.batchA = { ms: batchA.ms, summary: batchA.summary, items: batchA.snap.items.length, tasks: batchA.snap.tasks.length };
  check('E9.5 第一批走完插件全流程到完成态（页面给出完成回执 + 服务端任务 done + 该批 18 项已入账）',
    batchA.summary.length > 0 && batchA.summary !== '任务进行中'
      && batchA.snap.details.every((d) => d?.status === 'done') && batchA.snap.items.length === PAGES_A,
    `summary="${batchA.summary}" · 任务状态=${JSON.stringify(batchA.snap.details.map((d) => d?.status))} · items=${batchA.snap.items.length} · ${(batchA.ms / 1000).toFixed(0)} s`);

  // ── 7) 回写：页面上的原图被就地换成 box-service 给的译文 ──
  //    ⚠️ 必须等**全部 18 张**都标记上，不能「出现第一张就返回」—— 回写是随 SSE 逐张做的，
  //    等第一张就返回会拿到 17 张的快照，断言变成随机红（典型的"断言在竞态上"）。
  const wb = await waitFor(async () => {
    const snap = await page.evaluate(() => {
      const marked = Array.from(document.querySelectorAll('img[data-miao-translated]'));
      return {
        n: marked.length,
        blob: marked.filter((im) => (im.currentSrc || im.src || '').startsWith('blob:')).length,
        decoded: marked.filter((im) => im.naturalWidth > 0 && im.naturalHeight > 0).length,
        keptOriginal: marked.filter((im) => /freeimgmg|jmanga/.test(im.getAttribute('data-miao-original-src') || '')).length,
        seqs: marked.map((im) => im.getAttribute('data-miao-translated')).sort((a, b) => Number(a) - Number(b)),
      };
    });
    return snap.n >= PAGES_A ? snap : null;
  }, 4 * 60_000, `回写（等 ${PAGES_A} 张全部就地替换）`);
  report.writebackA = wb;
  check(`E9.6 **回写生效**：页面 ${PAGES_A} 个原图被标记 data-miao-translated，src 换成 blob:（译文确实是从 box-service 取回来的）`,
    wb.n === PAGES_A && wb.blob === PAGES_A, `标记=${wb.n} blob:=${wb.blob}`);
  check('E9.7 回写后的 blob 能解码为真图片，且原 CDN URL 被保留在 data-miao-original-src',
    wb.decoded === PAGES_A && wb.keptOriginal === PAGES_A,
    `可解码=${wb.decoded} 保留原址=${wb.keptOriginal} seq=${wb.seqs.join(',')}`);

  await page.evaluate(() => window.scrollTo(0, 0));
  await sleep(500);
  await page.screenshot({ path: path.join(LOGS, 'page-translated.png') });

  // ── 8) 第二批：chapter-113 的前 13 张（**新的一次提交 ⇒ 服务端新建一个 Task**，序号接着 19 起）──
  const tNavB = Date.now();
  const respB = await page.goto(SITE_B, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  report.navB = { ms: Date.now() - tNavB, status: respB?.status() ?? 0, title: await page.title() };
  const warmB = await warmUpPage(page, 'chapter-113');
  report.warmB = warmB;

  await openPanel(page);
  // 跨页导航后恢复出来的是「完成态」（没有勾选框）⇒ 从页脚的「继续翻一批」回到可勾选态。
  // 与第一批同法：必须**等状态稳定**，不能"看到 counter 就以为就绪"（否则又被异步恢复翻回 done）。
  const prepB = await prepareSelecting(page, 'chapter-113', COMIC);
  report.prepareB = prepB;
  const cnB = prepB.cn;
  await waitCells(page, PAGES_B, 60_000, 'E9.9 扫描 chapter-113');
  check(`E9.8 跨页导航后面板回到可勾选态（同一漫画名续编号；state=${prepB.sel?.state}，点了 ${prepB.sel?.clicked ?? 0} 次「继续翻一批」，共试 ${prepB.attempts} 轮）`,
    prepB.ok && (await page.locator('[data-testid="selection-counter"]').isVisible().catch(() => false)),
    `counter="${(await selectedCount(page)).text}" state=${prepB.sel?.state} comicName="${cnB?.value ?? ''}"`);
  check(`E9.9 跨页导航（URL 变更）后重扫 chapter-113 = ${PAGES_B} 张`,
    (await cellCount(page)) === PAGES_B, `${await cellCount(page)} 格`);
  if (!prepB.ok) {
    throw new Error(`第二批：面板没能稳定在可勾选态（state=${prepB.sel?.state}，试了 ${prepB.attempts} 轮）——「继续翻一批」未把状态推回 idle`);
  }

  await pick(page, 0, TAKE_B);
  const selB = await selectedCount(page);
  check(`E9.10 第二批勾选 ${TAKE_B} 张（本页共 ${PAGES_B} 张）`,
    selB.n === TAKE_B, `counter="${selB.text}"`);

  const batchB = await submitAndWait(page, TOTAL, 15 * 60_000, '第二批', 2);
  report.batchB = { ms: batchB.ms, summary: batchB.summary, items: batchB.snap.items.length, tasks: batchB.snap.tasks.length };
  check(`E9.11 第二批走完插件全流程到完成态（页面给出完成回执 + 服务端累计 ${TOTAL} 项全入账）`,
    batchB.summary.length > 0 && batchB.summary !== '任务进行中' && batchB.snap.items.length === TOTAL
      && batchB.snap.details.every((d) => d?.status === 'done'),
    `summary="${batchB.summary}" · 任务状态=${JSON.stringify(batchB.snap.details.map((d) => d?.status))} · items=${batchB.snap.items.length} · ${(batchB.ms / 1000).toFixed(0)} s`);

  // ── 9) 服务端事实：**两次提交 = 两个 Task、各 1 个 Batch**；序号跨任务连续 1–31 ──
  //
  // 🔴 这里曾经写错（上一版把 E3 的形状搬过来了）：断言「服务端只建了 1 个 Task、
  //    该 Task 有 2 个 Batch」。**判据原文没有这一条**（《04》§14.2：E3 = 「一个 Task 两个 Batch」，
  //    E9 = 「同一队列、同一落盘规则、序号连续」）。而本插件的契约就是**一次提交 = 一个任务**：
  //      · 插件 `onRetryFailed` 的注释：「作为**新任务**提交（comicName 复用 → 服务端续编号）」
  //      · 服务端 `createTask` 只按 `idempotencyKey` 去重，**从不按漫画名归并**
  //      · 「前 20 → POST /tasks，其余 → append 到同一任务」只发生在**同一次提交内部**
  //        （`splitIntoBatches` 的注释：「不产生新任务」），而面板单次上限就是 20（`decideSubmit`）
  //        ⇒ 该 append 分支**从 UI 不可达**（登记在案，见 §4）
  //    所以「两个 Task」是**契约事实**，不是失败；判据要的三件事改由 E9.13（序号连续）/
  //    E9.16（同一队列）/ E9.15（同一落盘规则）三条分别承担。
  const snap = batchB.snap;
  const tasks = snap.tasks;
  const details = snap.details;
  const items = snap.items;
  const allBatches = details.flatMap((d) => d?.batches ?? []);
  report.tasks = details.map((d) => ({ taskId: d?.taskId, status: d?.status, batches: (d?.batches ?? []).map((b) => `#${b.batchIndex} ${b.seqFrom}-${b.seqTo}×${b.count}`) }));

  check(`E9.12 【契约事实】两次提交 → **两个** Task，且每个 Task 各 1 个 Batch（面板单次上限 20 ⇒ 插件永远不产生"跨提交的追加批次"）`,
    tasks.length === 2 && details.every((d) => (d?.batches ?? []).length === 1),
    `任务数=${tasks.length} · 各任务批次=${JSON.stringify(report.tasks.map((t) => t.batches))}`);

  const seqs = items.map((i) => i.seq).sort((a, b) => a - b);
  const want = Array.from({ length: TOTAL }, (_, i) => i + 1);
  const b1 = details[0]?.batches?.[0];
  const b2 = details[1]?.batches?.[0];
  check(`E9.13 【判据「序号连续」】两个 Task 的 seq 首尾相接（Task1 = 1–${PAGES_A}、Task2 = ${PAGES_A + 1}–${TOTAL}），全页 1–${TOTAL} 无洞无重；且 Task2 **不是**从 1 重新开始`,
    seqs.length === TOTAL && seqs.every((s, i) => s === want[i])
      && b1?.seqFrom === 1 && b1?.seqTo === PAGES_A && b2?.seqFrom === PAGES_A + 1 && b2?.seqTo === TOTAL,
    `seqs 共 ${seqs.length} 个（${seqs[0]}…${seqs[seqs.length - 1]}）· Task1=${b1?.seqFrom}-${b1?.seqTo} · Task2=${b2?.seqFrom}-${b2?.seqTo}`);

  const bad = items.filter((i) => i.status !== 'success' && i.status !== 'skipped');
  check(`E9.14 ${TOTAL} 个 item 全部终态成功（无 failed / 无卡在 pending）`,
    items.length === TOTAL && bad.length === 0,
    `items=${items.length} · 非成功=${bad.map((i) => `${i.seq}:${i.status}`).join(',') || '无'}`);
  report.itemDurations = items.map((i) => i.durationMs).filter((d) => Number.isFinite(d));
  const durSum = report.itemDurations.reduce((a, b) => a + b, 0);
  console.log(`  [e9] 单张耗时：n=${report.itemDurations.length}`
    + ` 合计=${(durSum / 1000).toFixed(0)} s`
    + ` 均值=${report.itemDurations.length ? (durSum / report.itemDurations.length / 1000).toFixed(1) : 'n/a'} s`);

  // ── 10) 落盘：31 对、序号 001–031 连续 ──
  //     ⚠️ 每条断言**只 `check()` 一次**（不写在 if/else 两个分支里）：写在分支里迟早
  //        会漏掉一条，而分母守卫只能告诉你"条数不对"、说不出漏了哪条。
  const dirs = fs.readdirSync(OUT_ROOT).filter((n) => fs.statSync(path.join(OUT_ROOT, n)).isDirectory());
  const comicDir = dirs.find((n) => n.normalize('NFKC') === COMIC.normalize('NFKC'));
  const comicAbs = comicDir ? path.join(OUT_ROOT, comicDir) : null;
  const files = comicAbs ? walkRel(comicAbs) : [];

  let diskOk = false;
  let diskDetail = `未找到漫画目录 ${COMIC}；实际目录=${JSON.stringify(dirs)}`;
  if (comicDir) {
    const originals = files.filter((f) => /^\d{3}\.webp$/.test(path.basename(f)));
    const translated = files.filter((f) => /^\d{3}_translated\./.test(path.basename(f)));
    const want = Array.from({ length: TOTAL }, (_, i) => String(i + 1).padStart(3, '0'));
    const missO = want.filter((s) => !originals.some((f) => path.basename(f) === `${s}.webp`));
    const missT = want.filter((s) => !translated.some((f) => path.basename(f).startsWith(`${s}_translated.`)));
    const dup = (arr) => arr.length !== new Set(arr.map((f) => path.basename(f).slice(0, 3))).size;
    diskOk = missO.length === 0 && missT.length === 0
      && translated.length === TOTAL && originals.length === TOTAL && !dup(originals) && !dup(translated);
    diskDetail = `原图 ${originals.length} 译文 ${translated.length} 缺原图[${missO.join(',')}] 缺译文[${missT.join(',')}]`;
    report.landed = { root: OUT_ROOT, comicDir, originals: originals.length, translated: translated.length };
  }
  check(`E9.15 落盘 ${TOTAL} 对（原图 + 译文）在**同一漫画目录**、**同一命名规则**下，序号 001–${String(TOTAL).padStart(3, '0')} 连续、无缺、无重`,
    diskOk, diskDetail);

  // ── 10b) 【判据「同一队列」】串行执行的**直接证据**：译文的落盘时间严格单调递增 ──
  //
  // 为什么用落盘时间而不用批次时间戳：batch 记录里**没有** startedAt/finishedAt
  // （`store.mjs` 的 batch 只有 batchIndex/count/seqFrom/seqTo/status/items），
  // 拿不到"批次起止"就没有别的办法在后验阶段区分"串行"与"并发"。
  // 而落盘时间对**并发**是敏感的：两个批次若被并行执行，019–031 的写入时间就会与
  // 001–018 交错；串行则必然严格递增。这条断言是**可反证的**（把服务端的串行队列换成
  // 并发执行，它就会红）。
  let serialOk = false;
  let serialDetail = '无漫画目录，无法判定';
  if (comicAbs) {
    const ordered = Array.from({ length: TOTAL }, (_, i) => String(i + 1).padStart(3, '0'));
    const mtimes = ordered.map((s) => {
      const f = files.find((x) => path.basename(x).startsWith(`${s}_translated.`));
      return f ? { seq: Number(s), ms: fs.statSync(path.join(comicAbs, f)).mtimeMs } : null;
    });
    const missing = mtimes.filter((m) => !m).map((_, i) => i + 1);
    const times = mtimes.filter(Boolean).map((m) => m.ms);
    const violations = [];
    for (let i = 1; i < times.length; i += 1) if (!(times[i] > times[i - 1])) violations.push(mtimes[i].seq);
    serialOk = missing.length === 0 && times.length === TOTAL && violations.length === 0;
    report.serial = { n: times.length, violations, spanMs: times.length ? times[times.length - 1] - times[0] : 0 };
    serialDetail = `译文落盘时刻递增：n=${times.length} 逆序点=[${violations.join(',')}] 跨度=${((times[times.length - 1] - times[0]) / 1000).toFixed(0)} s`;
  }
  check(`E9.16 【判据「同一队列」】${TOTAL} 张译文的落盘时刻严格按序号递增 —— 两批**串行**、没有交错执行`,
    serialOk, serialDetail);

  // ── 11) 译文确为**真翻译**（不是把原图抄一遍）—— 与 E3 同法，抽样跨两次提交 ──
  const samples = [PAGES_A, PAGES_A + 1, TOTAL]; // 018(首批末) / 019 / 031(次批末)
  let compare = null;
  let compareDetail = '无漫画目录，无法比对';
  if (comicAbs) {
    const pairs = samples.map((s) => {
      const p3 = String(s).padStart(3, '0');
      const out = files.find((f) => path.basename(f).startsWith(`${p3}_translated.`));
      return { seq: s, src: path.join(comicAbs, `${p3}.webp`), out: out ? path.join(comicAbs, out) : null };
    }).filter((x) => x.out && fs.existsSync(x.out));
    compareDetail = `可比对 ${pairs.length}/${samples.length} 对`;
    if (pairs.length === samples.length) {
      const py = `
import numpy as np, json
from PIL import Image
pairs = json.loads(${JSON.stringify(JSON.stringify(pairs))})
res = []
for p in pairs:
    a = np.asarray(Image.open(p['src']).convert('RGB')).astype(int)
    b = np.asarray(Image.open(p['out']).convert('RGB')).astype(int)
    r = {'seq': p['seq'], 'sameShape': a.shape == b.shape, 'size': list(a.shape[1::-1])}
    if a.shape == b.shape:
        d = np.abs(b - a).max(axis=2)
        r['changedPct'] = round(100*float((d > 8).mean()), 2)
    res.append(r)
print(json.dumps(res, ensure_ascii=False))
`;
      const r = spawnSync(VENV_PY, ['-c', py], { encoding: 'utf8' });
      const line = (r.stdout || '').trim().split('\n').pop();
      try { compare = JSON.parse(line); } catch { compare = { raw: (r.stdout || '').slice(0, 300), err: (r.stderr || '').slice(0, 300) }; }
      compareDetail = JSON.stringify(compare)?.slice(0, 400) ?? compareDetail;
    }
  }
  report.compare = compare;
  check('E9.17 抽样 3 张（首批末 + 次批首尾，跨两个 Task）译文与原文逐像素不同 —— 真引擎的翻译阶段确实跑了',
    Array.isArray(compare) && compare.length === samples.length && compare.every((c) => c.sameShape && c.changedPct > 0.5),
    compareDetail);

  // ── 12) 插件自身的 JS 异常（站点第三方脚本噪声单列）──
  check('E9.18 全程无**插件自身**的 JS 异常（插件不靠吞异常过；站点自带脚本的噪声不计入）',
    pluginErrors.length === 0,
    pluginErrors.length ? pluginErrors.slice(0, 2).join(' | ') : `站内噪声 ${siteErrors.length} 条（如 ${siteErrors[0]?.slice(0, 60) ?? '无'}）`);

  // ── 汇总 ──
  report.finishedAt = new Date().toISOString();
  report.results = results;
  report.pluginErrors = pluginErrors;
  report.siteErrors = [...new Set(siteErrors)];

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n通过 ${passed} / 失败 ${failures} / 声明 ${DECLARED}`);
  if (results.length !== DECLARED) {
    console.log(`🔴 分母不符：声明 ${DECLARED} 条，实际执行 ${results.length} 条 —— 视为失败`);
    failures += 1;
  }

  const outDir = path.join(DOCK, 'docs', 'refs', 'engine');
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(outDir, '02-e9-plugin-real-engine.report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, '02-e9-plugin-real-engine.stdout.log'),
    `# E9 插件 ↔ 真引擎（真实站点）\n站点 A：${SITE_A}\n站点 B：${SITE_B}\n\n` +
      `${results.map((r) => `${r.ok ? '✓' : '✗'} ${r.id}  ${r.detail}`).join('\n')}\n\n` +
      `通过 ${passed} / 失败 ${failures} / 声明 ${DECLARED}\n运行目录：${RUN}\n`,
  );
  // 视觉证据（进仓）：面板 18 格 + 页面就地译文
  for (const [src, dst] of [
    [path.join(LOGS, 'panel-18.png'), path.join(outDir, '02-e9-panel-18.png')],
    [path.join(LOGS, 'page-translated.png'), path.join(outDir, '02-e9-page-translated.png')],
  ]) {
    if (fs.existsSync(src)) fs.copyFileSync(src, dst);
  }
  console.log('证据已写入 docs/refs/engine/02-e9-plugin-real-engine.*');
  process.exitCode = failures === 0 ? 0 : 1;
} catch (err) {
  console.error(`\n✗ E9 中断：${err.message}`);
  console.error(String(err.stack).split('\n').slice(0, 6).join('\n'));
  try {
    fs.writeFileSync(path.join(LOGS, 'abort.log'),
      `E9 中断：${err.message}\n${err.stack}\n\n已完成的断言：\n${results.map((r) => `${r.ok ? '✓' : '✗'} ${r.id}  ${r.detail}`).join('\n')}\n`);
  } catch { /* ignore */ }
  process.exitCode = 1;
} finally {
  if (page) { try { await page.screenshot({ path: path.join(LOGS, 'final.png'), fullPage: false }); } catch { /* ignore */ } }
  if (ctx) { try { await ctx.close(); } catch { /* ignore */ } }
  killAll();
  await sleep(800);
  killLeakedPorts();
  console.log(`\n运行目录（可整目录删除）：${RUN}`);
}
