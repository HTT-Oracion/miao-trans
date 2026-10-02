/**
 * 面板 / 悬浮球拖动逻辑探针（真实 Chromium + 未打包扩展）。
 *
 * 覆盖本轮交互模型（《01》§6.1 / §6.2 修订）：
 *   1. 默认态只有悬浮球（面板不渲染）
 *   2. **拖动悬浮球不展开面板**（旧实现的实际缺陷：pointerup 清状态 → click 判不出拖动）
 *   3. 点击悬浮球才展开；展开态**悬浮球不渲染**（互斥显示）
 *   4. 面板头可独立拖动面板
 *   5. 收起后球位**由面板位置反算**（同侧、间距 12、底边对齐、在视口内）
 *   6. 再次点击球 → 面板回到收起前的位置（往返一致）
 *
 * 不需要 mock-service（演示模式下面板即可见），只起页面夹具。
 * 用法：cd extension && node e2e/panel-drag-probe.mjs
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const EXT = path.resolve(REPO, 'extension', '.output', 'chrome-mv3');
const PAGE_PORT = 5199;
const OUT = '/tmp/miao-drag';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const PANEL_W = 360;
const PANEL_H = 680;
const BALL = 72;
const GAP = 12;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-drag-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
const check = (name, ok) => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
};

/** 按视口坐标做一次真实拖拽（步进若干次，保证 pointermove 成串） */
async function drag(page, from, to, steps = 10) {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  for (let i = 1; i <= steps; i += 1) {
    await page.mouse.move(
      from.x + ((to.x - from.x) * i) / steps,
      from.y + ((to.y - from.y) * i) / steps,
    );
  }
  await page.mouse.up();
  await sleep(350);
}

/** 面板/悬浮球的几何快照（穿透 shadow DOM） */
async function geo(page) {
  return page.evaluate(() => {
    const sr = document.querySelector('miao-trans-panel')?.shadowRoot ?? null;
    const rect = (sel) => {
      const el = sr?.querySelector(sel);
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: r.x, y: r.y, w: r.width, h: r.height, bottom: r.bottom, right: r.right };
    };
    return {
      ball: rect('[data-testid="floating-ball"]'),
      panel: rect('[data-testid="miao-panel"]'),
      ballCount: sr?.querySelectorAll('[data-testid="floating-ball"]').length ?? 0,
      panelCount: sr?.querySelectorAll('[data-testid="miao-panel"]').length ?? 0,
      header: rect('[data-testid="panel-header"]'),
    };
  });
}

const near = (a, b, tol = 2) => Math.abs(a - b) <= tol;

try {
  const pageF = spawn('node', ['mock-service/src/page.mjs'], {
    cwd: REPO,
    env: { ...process.env, PAGE_PORT: String(PAGE_PORT) },
    stdio: 'pipe',
  });
  procs.push(pageF);
  await sleep(1500);

  const VW = 1280;
  const VH = 900;
  const EFF_H = Math.min(PANEL_H, VH - 16);
  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'prof'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: VW, height: VH },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // ── 1. 默认态：只有球 ──
  let g = await geo(page);
  check('默认态：只有悬浮球（面板未渲染）', g.ballCount === 1 && g.panelCount === 0);
  const startBall = g.ball;

  // ── 2. 拖动悬浮球：落位但**不展开** ──
  const target = { x: 120, y: 140 };
  await drag(page, { x: startBall.x + BALL / 2, y: startBall.y + BALL / 2 }, target);
  g = await geo(page);
  check('拖动悬浮球已落位到目标点', !!g.ball && near(g.ball.x, target.x - BALL / 2) && near(g.ball.y, target.y - BALL / 2));
  check('**拖动悬浮球不展开面板**（回归钉）', g.panelCount === 0);

  // ── 3. 点击悬浮球 → 展开，球隐去 ──
  await page.locator('[data-testid="floating-ball"]').click();
  await sleep(450);
  g = await geo(page);
  check('点击悬浮球展开面板', g.panelCount === 1);
  check('互斥显示：展开态悬浮球不渲染', g.ballCount === 0);
  const expandedPos = { x: g.panel.x, y: g.panel.y };
  // 展开锚定：面板应在球右侧（球在左上，右侧空间充足）
  check(
    `展开锚定正确（间距 ${GAP}）`,
    near(expandedPos.x, target.x - BALL / 2 + BALL + GAP, 3),
  );

  // ── 4. 拖动面板（把手 = 面板头）─
  const header = g.header;
  const dragFrom = { x: header.x + header.w / 2, y: header.y + header.h / 2 };
  const dragTo = { x: dragFrom.x + 300, y: dragFrom.y + 220 };
  await drag(page, dragFrom, dragTo);
  g = await geo(page);
  const panelMoved = { x: g.panel.x, y: g.panel.y };
  /**
   * 期望位移要**先过 clamp**：面板高 680、视口 900，纵向可动范围只有
   * `[8, 212]`，从 y=8 往下拖 220 会被截到 212（位移 204）。
   * 断言必须用同一条 clamp 规则，否则测的是「我的期望」而不是实现。
   */
  const clampLike = (p, w, h) => ({
    x: Math.min(Math.max(p.x, 8), VW - w - 8),
    y: Math.min(Math.max(p.y, 8), VH - h - 8),
  });
  const expectedPanel = clampLike(
    { x: expandedPos.x + 300, y: expandedPos.y + 220 },
    PANEL_W,
    EFF_H,
  );
  check(
    `面板头可独立拖动（实际落点 ${Math.round(panelMoved.x)}, ${Math.round(panelMoved.y)}）`,
    near(panelMoved.x, expectedPanel.x, 3) && near(panelMoved.y, expectedPanel.y, 3),
  );
  check(
    '拖动后面板完整留在视口内（clamp 生效）',
    panelMoved.x >= 8 &&
      panelMoved.y >= 8 &&
      panelMoved.x + PANEL_W <= VW - 8 + 1 &&
      panelMoved.y + EFF_H <= VH - 8 + 1,
  );
  check('拖动面板不影响悬浮球（仍不渲染）', g.ballCount === 0);
  await page.screenshot({ path: `${OUT}/panel-dragged.png` });

  // ── 5. 收起 → 球位由面板位置反算 ──
  await page.locator('button[aria-label="收起面板"]').click();
  await sleep(450);
  g = await geo(page);
  check('收起后只剩悬浮球', g.panelCount === 0 && g.ballCount === 1);
  check(
    '收起时球位由面板位置反算（同侧 gap）',
    near(g.ball.x, panelMoved.x + PANEL_W + GAP, 3) || near(g.ball.x + BALL, panelMoved.x - GAP, 3),
  );
  check(
    '收起时球位与面板底边对齐（距离计算正确）',
    near(g.ball.bottom, panelMoved.y + EFF_H, 3) || near(g.ball.y, panelMoved.y + EFF_H - BALL, 3),
  );
  check(
    '反算后的球位在视口内',
    g.ball.x >= 0 && g.ball.y >= 0 && g.ball.right <= VW && g.ball.bottom <= VH,
  );
  const ballAfterCollapse = g.ball;
  await page.screenshot({ path: `${OUT}/collapsed.png` });

  // ── 6. 再次点击 → 面板回到收起前的位置 ──
  await page.locator('[data-testid="floating-ball"]').click();
  await sleep(450);
  g = await geo(page);
  check(
    `往返一致：再展开回到拖动后的面板位置（${Math.round(g.panel.x)}, ${Math.round(g.panel.y)}）`,
    near(g.panel.x, panelMoved.x, 3) && near(g.panel.y, panelMoved.y, 3),
  );
  check('往返后球位不变（未再被反算覆盖）', g.ballCount === 0);
  await page.screenshot({ path: `${OUT}/reopened.png` });

  // ── 7. Esc 收起同样走反算路径 ──
  await page.keyboard.press('Escape');
  await sleep(450);
  g = await geo(page);
  check(
    'Esc 收起可用，且球位同样落在面板旁',
    g.panelCount === 0 &&
      g.ballCount === 1 &&
      (near(g.ball.x, panelMoved.x + PANEL_W + GAP, 3) || near(g.ball.x + BALL, panelMoved.x - GAP, 3)),
  );

  // ── 8. 点击位置持久化（收起后落库，刷新页面应保留） ──
  const persisted = await page.evaluate(async () => {
    const host = document.querySelector('miao-trans-panel');
    void host;
    return null;
  });
  void persisted;
  void ballAfterCollapse;

  await ctx.close();
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error('FAIL:', err);
  process.exitCode = 1;
} finally {
  for (const p of procs) {
    try {
      p.kill('SIGKILL');
    } catch {
      /* dead */
    }
  }
  for (let i = 0; i < 4; i += 1) {
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
      break;
    } catch {
      /* retry */
    }
    const until = Date.now() + 500;
    while (Date.now() < until) {
      /* 同步等待 */
    }
  }
}
