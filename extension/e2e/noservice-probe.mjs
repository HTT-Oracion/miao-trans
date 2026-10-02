/**
 * 一次性探针：**完全不启动 mock-service**，验证演示开关放开 serviceReady 后
 * 面板整体可见（无「服务未就绪」浮层、扫描/选择可用、头徽标显示已就绪）。
 * 验证完即删。
 */
import { chromium } from 'playwright';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const EXT = path.resolve(REPO, 'extension', '.output', 'chrome-mv3');
const PAGE_PORT = 5199;
const OUT = '/tmp/miao-noservice';
fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-nosvc-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
function check(name, ok) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

try {
  // 只起页面夹具，不起 mock —— 模拟「后端完全没做」
  const pageF = spawn('node', ['mock-service/src/page.mjs'], {
    cwd: REPO, env: { ...process.env, PAGE_PORT: String(PAGE_PORT) }, stdio: 'pipe',
  });
  procs.push(pageF);
  await sleep(1500);

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'prof'), {
    channel: 'chromium', headless: true, viewport: { width: 1280, height: 800 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // 默认悬浮球
  const ballVisible = await page.locator('[data-testid="floating-ball"]').isVisible().catch(() => false);
  check('默认态为悬浮球', ballVisible);

  // 展开面板
  await page.locator('[data-testid="floating-ball"]').click();
  await sleep(800);

  const state = await page.evaluate(() => {
    const host = document.querySelector('miao-trans-panel');
    const sr = host?.shadowRoot;
    return {
      panel: !!sr?.querySelector('.mt-panel'),
      overlay: !!sr?.querySelector('[data-testid="service-not-ready"]'),
      badge: sr?.querySelector('.mt-panel__service')?.textContent ?? null,
      tokenDialogInput: !!sr?.querySelector('input[placeholder="64 位十六进制令牌"]'),
      thumbs: sr?.querySelectorAll('[data-testid="thumb-cell"]').length ?? 0,
      counter: sr?.querySelector('[data-testid="selection-counter"]')?.textContent ?? null,
    };
  });
  check('面板展开', state.panel);
  check('无「服务未就绪」浮层', !state.overlay);
  check('无自动弹出的配对引导', !state.tokenDialogInput);
  check('头徽标 = 服务已就绪', state.badge === '服务已就绪');
  let thumbs = state.thumbs;
  for (let i = 0; i < 30 && thumbs === 0; i += 1) {
    await sleep(500);
    thumbs = await page.evaluate(
      () => document.querySelector('miao-trans-panel')?.shadowRoot?.querySelectorAll('[data-testid="thumb-cell"]').length ?? 0,
    );
  }
  check('网格扫描到缩略图（夹具页 12 张）', thumbs === 12);

  await page.screenshot({ path: `${OUT}/panel.png` });

  // 勾选第一张 → 计数变化（点击勾选框按钮，Playwright 选择器自动穿透 shadow DOM）
  await page.locator('button[aria-label="第 1 张，未选"]').click();
  await sleep(500);
  const counter2 = await page.evaluate(() => {
    const sr = document.querySelector('miao-trans-panel')?.shadowRoot;
    return {
      counter: sr?.querySelector('[data-testid="selection-counter"]')?.textContent ?? null,
      hint: sr?.querySelector('.mt-panel__hintrow')?.textContent ?? '',
    };
  });
  check(`勾选后计数联动（${counter2.counter}）`, /已选\s*1/.test(counter2.counter ?? ''));

  // 收起 → 悬浮球（不丢状态），再展开 → 计数仍在
  await page.locator('button[aria-label="收起面板"]').click();
  await sleep(400);
  await page.locator('[data-testid="floating-ball"]').click();
  await sleep(600);
  const counter3 = await page.evaluate(
    () => document.querySelector('miao-trans-panel')?.shadowRoot?.querySelector('[data-testid="selection-counter"]')?.textContent ?? null,
  );
  check(`收起再展开不丢状态（${counter3}）`, /已选\s*1/.test(counter3 ?? ''));

  await page.screenshot({ path: `${OUT}/final.png` });
  await ctx.close();
  console.log(failed === 0 ? '\n全部通过' : `\n${failed} 项失败`);
  if (failed > 0) process.exitCode = 1;
} catch (err) {
  console.error('FAIL:', err);
  process.exitCode = 1;
} finally {
  for (const p of procs) { try { p.kill('SIGKILL'); } catch { /* dead */ } }
  for (let i = 0; i < 4; i++) {
    try { fs.rmSync(tmp, { recursive: true, force: true }); break; } catch { /* retry */ }
    const until = Date.now() + 500;
    while (Date.now() < until) { /* 同步等待 */ }
  }
}
