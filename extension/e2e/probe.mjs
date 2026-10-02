/**
 * 探针：确认「本机 Chrome + 加载未打包扩展 + 穿透 shadow DOM」这条路走得通。
 * 只在搭 harness 阶段用，验证通过后由 acceptance.mjs 取代。
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { chromium } from 'playwright';

const REPO = path.resolve(import.meta.dirname, '..', '..');
const EXT_DIR = path.resolve(REPO, 'extension', '.output', 'chrome-mv3');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'miao-probe-'));
const procs = [];
function start(script, env) {
  const p = spawn(process.execPath, [path.join(REPO, script)], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  procs.push(p);
  return p;
}

function cleanup() {
  for (const p of procs) {
    try { p.kill('SIGKILL'); } catch { /* ignore */ }
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

try {
  console.log('EXT_DIR =', EXT_DIR, fs.existsSync(EXT_DIR) ? '(存在)' : '(缺失!)');

  start('mock-service/src/server.mjs', {
    MOCK_PORT: '5180',
    MOCK_ROOT: path.join(tmp, 'Box 漫画'),
    MOCK_STATE_DIR: path.join(tmp, 'state'),
    MOCK_ITEM_MS: '300',
  });
  start('mock-service/src/page.mjs', { MOCK_PAGE_PORT: '5199' });
  await sleep(1500);

  const health = await fetch('http://127.0.0.1:5180/api/v1/health').then((r) => r.json());
  console.log('health =', JSON.stringify(health).slice(0, 120));

  const userDataDir = path.join(tmp, 'chrome-profile');
  const ctx = await chromium.launchPersistentContext(userDataDir, {
    // 关键：本机 Chrome ≥137 禁用了 --load-extension；Playwright 自带 Chromium
    // 需显式 channel: 'chromium'（新 headless = 完整浏览器，支持扩展；
    // 默认的 chromium-headless-shell 不支持）。
    channel: 'chromium',
    headless: true,
    args: [
      `--disable-extensions-except=${EXT_DIR}`,
      `--load-extension=${EXT_DIR}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=DisableLoadExtensionCommandLineSwitch',
    ],
  });

  let sw = ctx.serviceWorkers()[0];
  if (!sw) {
    console.log('等待 service worker…');
    sw = await ctx.waitForEvent('serviceworker', { timeout: 15000 });
  }
  console.log('service worker =', sw?.url());

  const page = await ctx.newPage();
  page.on('console', (m) => console.log('  [page]', m.type(), m.text().slice(0, 200)));
  await page.goto('http://127.0.0.1:5199/', { waitUntil: 'domcontentloaded' });
  await sleep(2500);

  const hostCount = await page.evaluate(() => document.querySelectorAll('miao-trans-panel').length);
  console.log('shadow host <miao-trans-panel> 数量 =', hostCount);

  const shadowInfo = await page.evaluate(() => {
    const host = document.querySelector('miao-trans-panel');
    if (!host) return null;
    const sr = host.shadowRoot;
    return {
      hasShadowRoot: Boolean(sr),
      mode: sr ? 'open' : 'closed(或未挂载)',
      innerKeys: sr ? Object.keys(sr.querySelectorAll('*')).length : 0,
      innerCount: sr ? sr.querySelectorAll('*').length : 0,
      ball: sr ? sr.querySelectorAll('[data-testid="floating-ball"]').length : 0,
      panel: sr ? sr.querySelectorAll('[data-testid="miao-panel"]').length : 0,
    };
  });
  console.log('shadow =', JSON.stringify(shadowInfo));

  // Playwright 的 CSS 引擎能自动穿透 open shadow root
  const ballViaLocator = await page.locator('[data-testid="floating-ball"]').count();
  const panelViaLocator = await page.locator('[data-testid="miao-panel"]').count();
  console.log('locator 命中: ball =', ballViaLocator, 'panel =', panelViaLocator);

  await page.screenshot({ path: path.join(REPO, 'e2e', 'probe-shot.png'), fullPage: false });
  console.log('截图已存 e2e/probe-shot.png');

  await ctx.close();
} catch (err) {
  console.error('探针失败：', err);
  process.exitCode = 1;
} finally {
  cleanup();
}
