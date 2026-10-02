/**
 * 面板视觉探针：多视口尺寸截图，定位「面板显示不全」。
 * 用法：node e2e/visual-probe.mjs [viewport]  （如 1280x800 / 1440x900）
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const EXT = path.resolve(REPO, 'extension', '.output', 'chrome-mv3');
const PAGE_PORT = 5199;
const MOCK_PORT = 5180;
const TOKEN = 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90';
const OUT = '/tmp/miao-visual';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-visual-'));
const procs = [];
function cleanup() {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* dead */ } }
  for (let i = 0; i < 4; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); return; } catch { /* retry */ }
    const until = Date.now() + 500;
    while (Date.now() < until) { /* 同步等待 */ }
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

try {
  // mock + 页面夹具（隔离目录）
  const root = path.join(tmp, 'Box 漫画');
  const stateDir = path.join(tmp, 'state');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  const mock = spawn('node', ['mock-service/src/server.mjs'], {
    cwd: REPO, env: { ...process.env, MOCK_PORT: String(MOCK_PORT), MOCK_ROOT: root, MOCK_STATE_DIR: stateDir, MOCK_ITEM_MS: '400' }, stdio: 'pipe' },
  );
  procs.push(mock);
  const pageF = spawn('node', ['mock-service/src/page.mjs'], { cwd: REPO, env: { ...process.env, PAGE_PORT: String(PAGE_PORT) }, stdio: 'pipe' });
  procs.push(pageF);
  await sleep(1500);

  const viewports = process.argv[2] ? [process.argv[2]] : ['1280x800', '1440x900', '1280x660'];
  for (const vp of viewports) {
    const [w, h] = vp.split('x').map(Number);
    const ctx = await chromium.launchPersistentContext(path.join(tmp, `prof-${vp}`), {
      channel: 'chromium', headless: true, viewport: { width: w, height: h },
      args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
    });
    // 等 SW 就绪
    let bg = ctx.serviceWorkers()[0] ?? await ctx.waitForEvent('serviceworker', { timeout: 15000 }).catch(() => null);
    if (!bg) throw new Error(`${vp}: SW 未启动`);
    const page = await ctx.newPage();
    await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, { waitUntil: 'domcontentloaded' });
    await sleep(1200);

    // 默认态：应为悬浮球
    await page.screenshot({ path: `${OUT}/default-${vp}.png` });

    // 展开面板
    await page.locator('[data-testid="floating-ball"]').click();
    await sleep(800);

    // 令牌配对走 UI（与真实用户一致）
    const tokenInput = page.locator('input[placeholder="64 位十六进制令牌"]');
    if (await tokenInput.isVisible().catch(() => false)) {
      await tokenInput.fill(TOKEN);
      await page.locator('button:has-text("保存")').first().click();
      await sleep(1500);
    }

    await page.screenshot({ path: `${OUT}/panel-${vp}.png` });

    // 测量面板实际几何 vs 视口（host = miao-trans-panel，内容在其 shadowRoot 内）
    const geo = await page.evaluate(() => {
      const host = document.querySelector('miao-trans-panel');
      const panel = host?.shadowRoot?.querySelector('.mt-panel') ?? null;
      if (!panel) return null;
      const r = panel.getBoundingClientRect();
      return { top: r.top, bottom: r.bottom, left: r.left, right: r.right, w: r.width, h: r.height, vh: innerHeight, vw: innerWidth, overflowBottom: r.bottom > innerHeight + 1, overflowRight: r.right > innerWidth + 1 };
    });
    console.log(`[${vp}] panel geo =`, JSON.stringify(geo));

    // 收起按钮是否真的能收起
    const collapseBtn = page.locator('button[aria-label="收起面板"]');
    if (await collapseBtn.count()) {
      await collapseBtn.click();
      await sleep(400);
      const stillOpen = await page.evaluate(() => {
        const host = document.querySelector('miao-trans-panel');
        return !!host?.shadowRoot?.querySelector('.mt-panel');
      });
      console.log(`[${vp}] 收起按钮 → 面板已关闭: ${!stillOpen}`);
      if (!stillOpen) {
        await page.screenshot({ path: `${OUT}/collapsed-${vp}.png` });
      }
    } else {
      console.log(`[${vp}] 未找到收起按钮`);
    }
    await ctx.close();
  }
  console.log('截图目录:', OUT);
} catch (err) {
  console.error('FAIL:', err);
  process.exitCode = 1;
} finally {
  await cleanup();
}
