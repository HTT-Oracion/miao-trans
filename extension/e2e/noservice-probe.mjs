/**
 * 「无服务」路径探针 —— **不启动 mock-service**（只起页面夹具）。
 *
 * 存在意义：ver1.0 的演示旁路 `DEMO_BYPASS_SERVICE_READY` 会在探测不到服务时强行
 * 放开渲染门控，把这条路径整体遮住。S8/P-4 删除旁路后它重新可达 ——
 * 本探针就是它的回归钉：**没有探针等于没验证**。
 *
 * 断言（分母写死于 TOTAL）：
 *   1. 默认态是悬浮球；点击后展开面板
 *   2. 探测不到服务 → 渲染「服务未就绪」浮层（`data-testid=service-not-ready`）
 *   3. **不是**「引擎准备中」浮层（`data-testid=engine-preparing`）
 *   4. 浮层标题 = 「本地翻译服务未运行」（与「正在准备翻译引擎…」分属两态）
 *   5. 头徽标 = 「服务未就绪」（不是「引擎准备中」/「服务已就绪」）
 *   6. 主按钮 = 「重试连接」；且**不存在**名为「启动 Box」的按钮
 *      （首版不实现 box:// 唤起 —— 不给「一键启动」的幻觉可用动作；
 *       actionLabel 口径见 `domain/clientState.SERVICE_NOT_READY`
 *       + `.specConflict` P2-03）
 *   7. 令牌配对引导仍在（P0-3 保留行为）→ 关闭它之后浮层仍应存在
 *
 * 证伪：把 P-4 的旁路语义加回去（探测不到时强制 `ready=true`）→ 第 2 / 5 条必失败。
 * （已实测，见交付报告。）
 *
 * 说明（避免误读）：background 的 `SERVICE_DISCOVER` 在「未发现服务」时返回
 * `ok({ready:false, hasToken:false})`，面板侧走 `serviceDiscovered({ready:false})`
 * → `servicePhase='absent'`；这与 `sendBg` 抛错时的 `serviceLost()` 落到**同一个**
 * 渲染态（「服务未就绪」浮层）。
 *
 * 用法：npm run build && cd extension && node e2e/noservice-probe.mjs
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

/** 分母：本探针应执行的断言条数（写死；少一条即失败） */
const TOTAL = 10;

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-nosvc-'));
const procs = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let failed = 0;
let ran = 0;
function check(name, ok) {
  ran += 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}`);
  if (!ok) failed += 1;
}

try {
  // **刻意不起 mock-service** —— 模拟「后端完全没做 / Box 没启动」
  const pageF = spawn('node', ['mock-service/src/page.mjs'], {
    cwd: REPO,
    env: { ...process.env, PAGE_PORT: String(PAGE_PORT) },
    stdio: 'pipe',
  });
  procs.push(pageF);
  await sleep(1500);

  const ctx = await chromium.launchPersistentContext(path.join(tmp, 'prof'), {
    channel: 'chromium',
    headless: true,
    viewport: { width: 1280, height: 900 },
    args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run'],
  });
  const page = await ctx.newPage();
  await page.goto(`http://127.0.0.1:${PAGE_PORT}/`, { waitUntil: 'domcontentloaded' });
  await sleep(1500);

  // ── 1. 默认态：悬浮球 ──
  const ballVisible = await page
    .locator('[data-testid="floating-ball"]')
    .isVisible()
    .catch(() => false);
  check('默认态为悬浮球', ballVisible);

  await page.locator('[data-testid="floating-ball"]').click();
  await sleep(900);

  const snap = () =>
    page.evaluate(() => {
      const sr = document.querySelector('miao-trans-panel')?.shadowRoot ?? null;
      const txt = (sel) => sr?.querySelector(sel)?.textContent?.trim() ?? null;
      const overlay = sr?.querySelector('[data-testid="service-not-ready"]');
      return {
        panel: !!sr?.querySelector('.mt-panel'),
        notReady: !!overlay,
        preparing: !!sr?.querySelector('[data-testid="engine-preparing"]'),
        overlayTitle: overlay?.querySelector('h4')?.textContent?.trim() ?? null,
        badge: txt('.mt-panel__service'),
        overlayButtons: [...(overlay?.querySelectorAll('.mt-overlay__actions button') ?? [])].map((b) =>
          b.textContent.trim(),
        ),
        tokenDialog: !!sr?.querySelector('input[placeholder="64 位十六进制令牌"]'),
      };
    });

  const s1 = await snap();
  check('点击悬浮球后面板已展开', s1.panel);
  check('渲染「服务未就绪」浮层（data-testid=service-not-ready）', s1.notReady);
  check('**不是**「引擎准备中」浮层（两态不得混用）', !s1.preparing);
  check(`浮层标题 = 本地翻译服务未运行（实际 ${s1.overlayTitle}）`, s1.overlayTitle === '本地翻译服务未运行');
  check(`头徽标 = 服务未就绪（实际 ${s1.badge}）`, s1.badge === '服务未就绪');
  check(
    `主按钮 = 重试连接，且无「启动 Box」按钮（实际 ${JSON.stringify(s1.overlayButtons)}）`,
    s1.overlayButtons.includes('重试连接') && !s1.overlayButtons.includes('启动 Box'),
  );
  check('令牌配对引导仍在（P0-3 保留行为）', s1.tokenDialog);
  await page.screenshot({ path: `${OUT}/not-ready.png` });

  // ── 关闭配对引导后，未就绪浮层必须仍在（不是被引导盖住） ──
  if (s1.tokenDialog) {
    await page.getByRole('button', { name: '稍后' }).click();
    await sleep(400);
  }
  const s2 = await snap();
  check('关闭配对引导后浮层仍在，且仍未就绪', s2.notReady && !s2.preparing);
  check('关闭配对引导后头徽标仍为「服务未就绪」', s2.badge === '服务未就绪');

  await page.screenshot({ path: `${OUT}/final.png` });
  await ctx.close();

  // ── 分母钉死（这一条本身不计入 ran） ──
  if (ran === TOTAL) {
    console.log(`PASS  分母：应执行 ${TOTAL} 条断言，实执行 ${ran} 条`);
  } else {
    console.log(`FAIL  分母：应执行 ${TOTAL} 条断言，实执行 ${ran} 条`);
    failed += 1;
  }
  console.log(failed === 0 ? `\n全部通过（${ran}/${TOTAL}）` : `\n${failed} 项失败（${ran}/${TOTAL}）`);
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
  for (let i = 0; i < 4; i++) {
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
