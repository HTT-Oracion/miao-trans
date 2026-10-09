/**
 * 端到端验收 —— 真实 Chromium（Playwright 自带，新 headless）+ 未打包扩展 + mock box-service。
 *
 * 覆盖场景（对应《01》/《03》条款在断言处标注）：
 *   A. 服务发现与令牌配对（§5.1 健康检查 / §8.1 令牌头）
 *   B. 页面扫描：12 张图进入面板网格（§6.2 面板）
 *   C. 全选 → 计数三态 ink-2（§5.2）
 *   D. 提交 → 进度 → 完成态（§4.3 客户端状态机）
 *   E. 回写验证：像素级证明「页面上的图换成了译文」——
 *      mock 原图色相 (seq*37)%360，译文 (seq*47)%360，canvas 采样比对（P0-1 的结果面）
 *   F. 落盘验证：MOCK_ROOT 下 `<漫画名>/NNN.png` + `NNN_translated.png`（§7）
 *   G. 无限滚动：追加 8 张 → 重扫 → 已选 12 保留（P0-2：URL 未变不清空）
 *   H. 全选 20 张 → 计数转 yellow（§5.2 第二态）
 *   I. SPA 换页 → 选择清空（P0-2 口径裁定：翻译中不停任务，只清已选集）
 *
 * 运行：npm run verify（在仓库根目录）
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const REPO = path.resolve(import.meta.dirname, '..');
const EXT_DIR = path.join(REPO, 'extension', '.output', 'chrome-mv3');
const requireExt = createRequire(path.join(REPO, 'extension', 'package.json'));
const { chromium } = requireExt('playwright');

const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const MOCK_PORT = '5180';
const PAGE_PORT = '5199';
const COMIC_NAME = 'e2e验收';

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` —— ${detail}` : ''}`);
  if (!ok) failures += 1;
}
let failures = 0;

// ── 进程管理 ────────────────────────────────────────────────
// 证据截图统一落 `.temp-translate-test/verify/`（已 gitignore）—— 与 E9 的产物口径一致，
// 不再散进 /tmp（用户明确要求：测试产物集中一处，好找、也好清）。
const ARTIFACTS = path.join(REPO, '.temp-translate-test', 'verify');
fs.mkdirSync(ARTIFACTS, { recursive: true });
const SHOT_FINAL = path.join(ARTIFACTS, 'final.png');
const SHOT_FAIL = path.join(ARTIFACTS, 'fail.png');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-verify-'));
const mockRoot = path.join(tmp, 'Box 漫画');
/** mock 的任务清单落盘目录（`<MOCK_STATE_DIR>/tasks/<taskId>.json`）—— K2 方向取证要读它 */
const mockStateDir = path.join(tmp, 'state');
const procs = [];
function start(relScript, env) {
  const p = spawn(process.execPath, [path.join(REPO, relScript)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  p.stderr.on('data', (d) => process.stderr.write(`  [${path.basename(relScript)}] ${d}`));
  procs.push(p);
  return p;
}
function cleanup() {
  for (const p of procs) {
    try { p.kill('SIGKILL'); } catch { /* already dead */ }
  }
  // Chrome 退出有延迟，profile 目录短暂不可删 —— 重试几轮，删不掉就留着（在 /tmp 下）
  const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  for (let i = 0; i < 5; i++) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      return;
    } catch {
      sleepSync(600);
    }
  }
  console.log(`（提示：临时目录未能完全删除：${tmp}）`);
}

// ── 断言辅助 ────────────────────────────────────────────────
/** RGB → 色相（0–360） */
function hueOf(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  if (max === min) return -1; // 灰
  const d = max - min;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  h *= 60;
  return h < 0 ? h + 360 : h;
}

async function waitFor(fn, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let last;
  for (;;) {
    try {
      last = await fn();
      if (last) return last;
    } catch { /* retry */ }
    if (Date.now() > deadline) throw new Error(`等待超时：${label}`);
    await sleep(400);
  }
}

/** 递归列出目录下全部文件（相对 MOCK_ROOT） */
function walkRel(dir, base = dir) {
  let out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out = out.concat(walkRel(p, base));
    else out.push(path.relative(base, p));
  }
  return out;
}

// ══════════════════════════════════════════════════════════
let ctx = null;
let page = null;
const consoleLog = [];
try {
  // ── 启动 mock 服务 + 漫画页夹具（隔离目录，绝不污染仓库）──
  start('mock-service/src/server.mjs', {
    MOCK_PORT,
    MOCK_ROOT: mockRoot,
    MOCK_STATE_DIR: mockStateDir,
    MOCK_ITEM_MS: '120',
  });
  start('mock-service/src/page.mjs', { MOCK_PAGE_PORT: PAGE_PORT });

  const health = await waitFor(async () => {
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/api/v1/health`);
      const j = await r.json();
      return j.service === 'box-service' ? j : null; // §5.1：只认 service 字段，不看 200
    } catch { return null; }
  }, 10000, 'mock /health');
  check('A1 mock 健康检查 service=box-service', true, `port=${MOCK_PORT} version=${health.version}`);
  await fetch(`http://127.0.0.1:${PAGE_PORT}/`).catch(() => {});
  check('A2 漫画页夹具已就绪', true, `port=${PAGE_PORT}`);

  // ── 启动带扩展的浏览器 ──
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'profile'), {
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
  });
  // MV3 SW 冷启动极快时 waitForEvent 会错过事件 —— 轮询更稳
  let swSeen = false;
  for (let i = 0; i < 60; i++) {
    if (ctx.serviceWorkers().some((s) => s.url().startsWith('chrome-extension://'))) { swSeen = true; break; }
    await new Promise((r) => setTimeout(r, 500));
  }
  if (!swSeen) throw new Error('service worker 未启动（扩展加载失败？）');
  check('B1 扩展已加载（service worker 存在）', true);

  const page0 = await ctx.newPage();
  page = page0;
  const pageErrors = [];
  page.on('pageerror', (e) => pageErrors.push(String(e)));
  page.on('console', (m) => consoleLog.push(`[${m.type()}] ${m.text().slice(0, 220)}`));
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, { waitUntil: 'domcontentloaded' });

  // Playwright 的选择器可穿透 open shadow root。
  // 默认态是收起的悬浮球（《01》§6.1），先点开面板
  await page.locator('[data-testid="floating-ball"]').waitFor({ state: 'visible', timeout: 10000 });
  await page.locator('[data-testid="floating-ball"]').click();
  await waitFor(
    () => page.locator('[data-testid="miao-panel"]').isVisible().catch(() => false),
    15000,
    '面板渲染',
  );
  check('B2 面板已渲染（shadow DOM 内，点击悬浮球展开）', true);

  // ── 令牌配对（§8.1：X-Box-Token）──
  const tokenInput = page.locator('input[placeholder="64 位十六进制令牌"]');
  await tokenInput.waitFor({ state: 'visible', timeout: 8000 });
  await tokenInput.fill(TOKEN);
  await page.locator('button:has-text("保存")').first().click();
  await waitFor(async () => !(await tokenInput.isVisible().catch(() => true)), 10000, '令牌弹层关闭');
  check('C1 令牌已保存，配对弹层关闭', true);

  // ── 页面扫描 ──
  await waitFor(
    () => page.locator('[data-testid="thumb-cell"]').count().then((n) => n === 12),
    15000,
    '扫描到 12 张图',
  );
  check('C2 页面 12 张图全部进入网格', true);

  // ── 漫画名 ──
  await page.fill('#mt-comic-name', COMIC_NAME);
  const inputVal = await page.locator('#mt-comic-name').inputValue();
  const hintBefore = await page
    .locator('[data-testid="hint-row"]')
    .innerText()
    .catch(() => '(hint-row 不可见)');
  console.log(`  [诊断] 输入框值="${inputVal}" · hint-row="${hintBefore.trim().slice(0, 80)}"`);

  // ── 全选 → 计数三态 ink-2（§5.2 第一态）──
  await page.locator('button[aria-label="全选本页"]').click();
  const counter1 = await page.locator('[data-testid="selection-counter"]').innerText();
  check('D1 全选后计数 = 12', /12/.test(counter1), `text="${counter1.trim()}"`);

  // ── 翻译方向（ver2.1）：切到「英译中」—— 提交前的一次交互，方向必须随建单下发 ──
  // 该控件与「漫画名」同属建单参数，只应在选图态出现；这里同时守「可见」与「可切换」。
  const dirSeg = page.locator('[data-testid="direction-seg"]');
  await dirSeg.waitFor({ state: 'visible', timeout: 8000 });
  const dirBtnEn = dirSeg.locator('button:has-text("英译中")');
  const dirBtnJa = dirSeg.locator('button:has-text("日译中")');
  const jaBefore = await dirBtnJa.getAttribute('aria-pressed');
  await dirBtnEn.click();
  const enAfter = await dirBtnEn.getAttribute('aria-pressed');
  const jaAfter = await dirBtnJa.getAttribute('aria-pressed');
  check(
    'K1 方向分段控件可切换：默认日译中 → 点英译中后 en=true / ja=false',
    jaBefore === 'true' && enAfter === 'true' && jaAfter === 'false',
    `默认ja=${jaBefore} · 点击后 en=${enAfter} ja=${jaAfter}`,
  );

  // ── 无限滚动：追加 8 张 → 已选 12 不被误清（P0-2：URL 未变、无图离开 DOM）──
  await page.locator('button:has-text("追加 8 张")').click();
  await sleep(1500); // routeWatcher 400ms 聚合 + 判定窗口
  const counterG = await page.locator('[data-testid="selection-counter"]').innerText();
  check('G1 追加 8 张后已选仍为 12（选择不被误清）', /12/.test(counterG), `text="${counterG.trim()}"`);

  // ── 提交 → 等完成态 ──
  await page.locator('[data-testid="submit-button"]').click();
  await sleep(2500);
  {
    const hintAfter = await page
      .locator('[data-testid="hint-row"]')
      .innerText()
      .catch(() => '(hint-row 不可见)');
    let q = '(queue 请求失败)';
    try {
      const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/api/v1/queue`, {
        headers: { 'X-Box-Token': TOKEN },
      });
      q = JSON.stringify(await r.json()).slice(0, 220);
    } catch { /* keep default */ }
    console.log(`  [诊断] 提交后 hint-row="${hintAfter.trim().slice(0, 100)}"`);
    console.log(`  [诊断] mock /queue = ${q}`);
  }
  await waitFor(
    () => page.locator('[data-testid="toolbar-summary"]').isVisible().catch(() => false),
    60000,
    '任务完成态',
  );  const summary = await page.locator('[data-testid="toolbar-summary"]').innerText();
  check('D2 提交后到达完成态', true, `summary="${summary.trim()}"`);
  check('D3 全程无页面 JS 异常', pageErrors.length === 0, pageErrors.join(' | ').slice(0, 200));

  /*
   * ── K2：方向随建单下发取证（ver2.1）──
   *
   * 断言的是「插件选的英译中真的到了服务端」，因此不看面板、不看 store，直接读
   * mock 按任务落盘的清单（`<MOCK_STATE_DIR>/tasks/<taskId>.json`，字段 `lang`）。
   * 只看前端 UI 会被「切了但没下发」这种断链骗过 —— 那正是本组要防的静默失败。
   */
  {
    const tasksDir = path.join(mockStateDir, 'tasks');
    let lang = null;
    let scanned = 0;
    try {
      for (const f of fs.readdirSync(tasksDir).filter((n) => n.endsWith('.json'))) {
        scanned += 1;
        const t = JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8'));
        if (t.comicName === COMIC_NAME || t.normalizedComicName === COMIC_NAME) {
          lang = t.lang;
          break;
        }
      }
    } catch { /* 目录还没建 → lang 保持 null，断言会红 */ }
    check(
      'K2 方向随建单下发：服务端任务 lang = {from:"en",to:"zh"}',
      Boolean(lang) && lang.from === 'en' && lang.to === 'zh',
      `扫描 ${scanned} 个任务清单 · lang=${JSON.stringify(lang)}`,
    );
  }

  // ── 回写像素验证（P0-1 的结果面：页面图 = 译文）──
  // 只对 src 已替换为 blob: 的图断言译文色相；seq = 该图在 DOM（阅读顺序）中的位次。
  const sampled = await page.evaluate(() => {
    const imgs = [...document.querySelectorAll('img')].filter(
      (i) => i.naturalWidth > 0 && !i.src.startsWith('chrome-extension://'),
    );
    return imgs.map((img, idx) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d');
      g.drawImage(img, 0, 0);
      const d = g.getImageData(Math.floor(c.width / 2), Math.floor(c.height / 2), 1, 1).data;
      const max = Math.max(d[0], d[1], d[2]), min = Math.min(d[0], d[1], d[2]);
      let h = -1;
      if (max !== min) {
        const dd = max - min;
        h = max === d[0] ? ((d[1] - d[2]) / dd) % 6 : max === d[1] ? (d[2] - d[0]) / dd + 2 : (d[0] - d[1]) / dd + 4;
        h = (h * 60 + 360) % 360;
      }
      return { idx, isBlob: img.src.startsWith('blob:'), hue: Math.round(h) };
    });
  });
  const expectTranslated = (seq) => (seq * 47) % 360;
  const blobImgs = sampled.filter((s) => s.isBlob);
  let hueOk = 0;
  const hueDetails = [];
  for (const s of blobImgs) {
    const seq = s.idx + 1; // 提交时只选了前 12 张（阅读顺序 = DOM 顺序）
    const diff = Math.min(Math.abs(s.hue - expectTranslated(seq)), 360 - Math.abs(s.hue - expectTranslated(seq)));
    hueDetails.push(`#${seq}:${s.hue}°(期望${expectTranslated(seq)}°)`);
    if (diff <= 4) hueOk += 1;
  }
  check(
    'E1 回写像素 = 译文色相 (seq*47)%360',
    blobImgs.length === 12 && hueOk === 12,
    `${hueOk}/${blobImgs.length} 张命中 · ${hueDetails.join(' ')}`,
  );
  const blobCount = blobImgs.length;
  check('E2 页面 <img> 的 src 已替换为 blob: URL', blobCount === 12, `${blobCount}/${sampled.length}`);
  // 未勾选的第 13–20 张必须是原图色相（seq*37）—— 没有被误翻
  const untouched = sampled.filter((s) => !s.isBlob && s.idx >= 12);
  let untouchedOk = 0;
  for (const s of untouched) {
    const seq = s.idx + 1;
    const diff = Math.min(Math.abs(s.hue - ((seq * 37) % 360)), 360 - Math.abs(s.hue - ((seq * 37) % 360)));
    if (diff <= 4) untouchedOk += 1;
  }
  check(
    'E3 未勾选的图保持原图色相 (seq*37)%360（无误翻）',
    untouched.length > 0 && untouchedOk === untouched.length,
    `${untouchedOk}/${untouched.length}`,
  );

  // ── 落盘验证（§7）──
  const comicDir = fs.readdirSync(mockRoot).find((n) => n.normalize('NFKC') === COMIC_NAME);
  check('F1 落盘目录 <漫画名> 已创建', Boolean(comicDir), comicDir ?? '(无)');
  if (comicDir) {
    const files = walkRel(path.join(mockRoot, comicDir));
    const translated = files.filter((f) => /^\d{3}_translated\.png$/.test(path.basename(f)));
    const originals = files.filter((f) => /^\d{3}\.png$/.test(path.basename(f)));
    check('F2 12 份译文文件 NNN_translated.png', translated.length === 12, `${translated.length} 份`);
    check('F3 12 份原图文件 NNN.png', originals.length === 12, `${originals.length} 份`);
    const seqsOk = translated.every((f) => /^00[1-9]|01[0-2]_translated/.test(path.basename(f)));
    check('F4 序号 001–012 连续', seqsOk, translated.map((f) => path.basename(f)).sort().join(',').slice(0, 80));
  }

  // ── 完成态「继续翻一批」→ 回选择态 + 重扫（20 张）──
  await page.locator('button:has-text("继续翻一批")').click();
  await waitFor(async () => {
    const t = await page.locator('.mt-panel__pagehint').first().innerText();
    return /共 20 张/.test(t);
  }, 10000, '重扫到 20 张');
  const counter2 = await page.locator('[data-testid="selection-counter"]').innerText();
  check('H1 继续翻一批后网格更新到 20 张，已选清空', /0/.test(counter2) || !/\d+/.test(counter2.replace('0', '')), `text="${counter2.trim()}"`);

  // ── 全选 20 → 第二态 yellow（§5.2）──
  await page.locator('button[aria-label="全选本页"]').click();
  const counterEl = page.locator('[data-testid="selection-counter"]');
  const counter3 = await counterEl.innerText();
  const cls3 = await counterEl.getAttribute('class');
  check('H2 全选 20 张计数 = 20', /20/.test(counter3), `text="${counter3.trim()}"`);
  // 三态 token：<20 ink-2 / ≥20 且 ≤50 normal / >50 over-limit（error）。
  // ⚠️ D-07 已把**选择上限**从 20 抬到 50（20 与单批上限解耦）—— 因此 20 张是
  //    「正常区间」而不是「已达上限」，颜色钉在 normal；越限要到 51 张才成立（见 I 段）。
  check('H3 计数 = 20 时属正常区间（D-07 上限 50 · tone normal）', /mt-count--normal/.test(cls3 ?? ''), `class="${cls3}"`);

  /*
   * ── 选择上限（《01》§5.1）—— D-07 口径：上限已从 20 抬到 50 ──
   *
   * ⚠️ 本段旧断言写的是「第 21 张即越限、提交被硬拦」，在 D-07（上限 50）落地后
   *    **已失效**（21 张属正常区间，提交不再被拦、也就永远等不到超限弹层）。
   *    这里重写为当前口径的正向判据，并保留原覆盖点：软拦边界 + 提交硬拦 + 拦截时不发请求。
   *    做法：把素材堆到 52 张（>50），用「逐张 + 全选本页 + 翻页」凑到真越限。
   */
  // 追加 4 次（20 → 52，跨 3 页）后重扫
  await page.locator('button:has-text("追加 8 张")').click();
  await page.locator('button:has-text("追加 8 张")').click();
  await page.locator('button:has-text("追加 8 张")').click();
  await page.locator('button:has-text("追加 8 张")').click();
  await page.locator('button[aria-label="重新扫描本页图片"]').click();
  await waitFor(async () => {
    const t = await page.locator('.mt-panel__pagehint').first().innerText();
    return /共 52 张/.test(t);
  }, 10000, '重扫到 52 张');
  const counterKept = await counterEl.innerText();
  check('I0 重扫到 52 张（3 页）后已选 20 保留', /20/.test(counterKept), `text="${counterKept.trim()}"`);

  // 21 张：>20 但 ≤50 → 正常区间，**不**越限（守 D-07 的边界不是 20）
  await page.locator('button[aria-label="下一页"]').click();
  // 勾选层是 checkbox 按钮（cell 主体点击是放大预览），seq 21 = 第 2 页第一格
  await page.locator('button[aria-label="第 21 张，未选"]').click();
  const counter21 = await counterEl.innerText();
  const cls21 = await counterEl.getAttribute('class');
  check(
    'I1 第 21 张可勾选且不越限（tone normal · D-07 上限 50）',
    /21/.test(counter21) && /mt-count--normal/.test(cls21 ?? ''),
    `text="${counter21.trim()}" class="${cls21}"`,
  );

  // 凑到 52 张 → 真越限（>50）：第 2 页全选 → 40，翻第 3 页全选（12 张）→ 52
  await page.locator('button[aria-label="全选本页"]').click();
  await page.locator('button[aria-label="下一页"]').click();
  await page.locator('button[aria-label="全选本页"]').click();
  const counter4 = await counterEl.innerText();
  const cls4 = await counterEl.getAttribute('class');
  check(
    'I2 凑到 52 张（>50）时转 over-limit 色调',
    /52/.test(counter4) && /over-limit/.test(cls4 ?? ''),
    `text="${counter4.trim()}" class="${cls4}"`,
  );
  await page.locator('[data-testid="submit-button"]').click();
  await page.locator('[data-testid="over-limit-dialog"]').waitFor({ state: 'visible', timeout: 5000 });
  check('I3 越限被拦截：弹层出现', true);
  {
    const r = await fetch(`http://127.0.0.1:${MOCK_PORT}/api/v1/queue`, {
      headers: { 'X-Box-Token': TOKEN },
    });
    const q = await r.json();
    check('I4 拦截时不发网络请求（mock 队列为空）', q.running === null && q.queued.length === 0, JSON.stringify(q).slice(0, 120));
  }
  await page.locator('button:has-text("取消勾选（回到 50 张内）")').click();
  await waitFor(async () => /50/.test(await counterEl.innerText()), 5000, '裁剪回 50');
  check('I5 「裁剪到 50」动作生效', true);

  // ── SPA 换页 → 选择清空（P0-2 口径裁定）──
  await page.locator('button:has-text("SPA 换页")').click();
  await sleep(1800); // routeWatcher 400ms 聚合 + 清空渲染
  const counter5 = await page.locator('[data-testid="selection-counter"]').innerText().catch(() => '(计数器已隐藏)');
  check('J1 SPA 换页后已选清空（= 0）', /0/.test(counter5), `text="${counter5.trim()}"`);

  await page.screenshot({ path: SHOT_FINAL });
  check(`J1 最终截图已存 ${path.relative(REPO, SHOT_FINAL)}`, fs.existsSync(SHOT_FINAL) && fs.statSync(SHOT_FINAL).size > 0,
    `${fs.existsSync(SHOT_FINAL) ? fs.statSync(SHOT_FINAL).size : 0} B`);
} catch (err) {
  check('执行过程', false, String(err).slice(0, 300));
  // 失败诊断：面板状态 + 控制台 + 截图
  try {
    if (page) {
      await page.screenshot({ path: SHOT_FAIL });
      const dump = await page.evaluate(() => {
        const q = (sel) => document.querySelector(sel)?.textContent?.trim() ?? '(无)';
        return {
          提示行: q('[data-testid="hint-row"]'),
          计数: q('[data-testid="selection-counter"]'),
          工具条: q('[data-testid="toolbar-summary"]'),
          本页提示: q('.mt-panel__pagehint'),
        };
      });
      console.log('---- 面板状态 ----');
      for (const [k, v] of Object.entries(dump)) console.log(`  ${k}: ${v.slice(0, 160)}`);
    }
  } catch { /* 诊断失败不影响主流程 */ }
  console.log('---- 页面控制台（最近 25 条）----');
  for (const l of consoleLog.slice(-25)) console.log('  ' + l);
  console.log(`失败截图：${path.relative(REPO, SHOT_FAIL)}`);
} finally {
  try { if (ctx) await ctx.close(); } catch { /* already closed */ }
  cleanup();
}

// ── 汇总 ──
const pass = results.filter((r) => r.ok).length;
console.log(`\n===== 验收结果：${pass}/${results.length} 通过，${failures} 失败 =====`);
process.exit(failures > 0 ? 1 : 0);
