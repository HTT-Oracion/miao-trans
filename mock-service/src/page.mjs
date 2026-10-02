// 独立静态站点服务器（供 e2e 使用，与 box-service 无耦合）
// 默认 5199；提供漫画阅读页 + 按需生成的 PNG，覆盖三种 URL 变更类型。
import http from 'node:http';

import { makeSolidPng } from './png.mjs';

const DEFAULT_PORT = 5199;
const PORT_END = 5209;
const IMAGES_PER_PAGE = 12;
const APPEND_COUNT = 8;

function seqRangeForPage(page) {
  const from = (page - 1) * IMAGES_PER_PAGE + 1;
  return { from, to: from + IMAGES_PER_PAGE - 1 };
}

/** 每张图尺寸不同，便于验证「有没有串图」 */
function sizeForSeq(seq) {
  return { width: 800, height: 600 + (seq % 5) * 160 };
}

function imgTags(from, to) {
  const out = [];
  for (let seq = from; seq <= to; seq++) {
    const { width, height } = sizeForSeq(seq);
    out.push(
      `<figure class="page">` +
      `<img data-testid="page-img" data-seq="${seq}" src="/img/${String(seq).padStart(3, '0')}.png" ` +
      `width="${width}" height="${height}" alt="第 ${seq} 页">` +
      `<figcaption>seq=${seq}</figcaption></figure>`,
    );
  }
  return out.join('\n');
}

function html(page) {
  const { from, to } = seqRangeForPage(page);
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<title>喵译 mock 漫画阅读页 · 第 ${page} 页</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #f5f5f7; font: 14px/1.5 -apple-system, "PingFang SC", sans-serif; }
  header { position: sticky; top: 0; z-index: 10; background: #fff;
           border-bottom: 1px solid #e3e3e6; padding: 10px 16px; display: flex; gap: 8px; align-items: center; }
  header .meta { margin-left: auto; color: #666; font-variant-numeric: tabular-nums; }
  button { padding: 6px 12px; border: 1px solid #c9c9cf; border-radius: 6px; background: #fff; cursor: pointer; }
  button:hover { background: #f0f0f3; }
  main { padding: 24px 0 120px; }
  .page { margin: 0 auto 40px; width: 800px; background: #fff; box-shadow: 0 1px 4px rgba(0,0,0,.12); }
  .page img { display: block; }
  figcaption { padding: 4px 8px; color: #888; font-size: 12px; }
</style>
</head>
<body>
<header>
  <button id="btn-append" type="button">追加 ${APPEND_COUNT} 张</button>
  <button id="btn-spa" type="button">SPA 换页</button>
  <button id="btn-mpa" type="button">整页导航</button>
  <span class="meta" id="meta">page=${page} seq=${from}-${to}</span>
</header>
<main id="pages">
${imgTags(from, to)}
</main>
<script>
  const PER_PAGE = ${IMAGES_PER_PAGE};
  const APPEND = ${APPEND_COUNT};
  let page = ${page};
  let lastSeq = ${to};

  const meta = document.getElementById('meta');
  function refresh() {
    const imgs = document.querySelectorAll('[data-testid="page-img"]');
    meta.textContent = 'page=' + page + ' · ' + imgs.length + ' 张 · 末页 seq=' + lastSeq + ' · ' + location.pathname + location.search;
  }

  function makeFigure(seq) {
    const height = 600 + (seq % 5) * 160;
    const fig = document.createElement('figure');
    fig.className = 'page';
    const img = document.createElement('img');
    img.dataset.testid = 'page-img';
    img.dataset.seq = String(seq);
    img.src = '/img/' + String(seq).padStart(3, '0') + '.png';
    img.width = 800;
    img.height = height;
    img.alt = '第 ' + seq + ' 页';
    const cap = document.createElement('figcaption');
    cap.textContent = 'seq=' + seq;
    fig.appendChild(img);
    fig.appendChild(cap);
    return fig;
  }

  // ① 追加 8 张：不改变 URL（模拟无限滚动）
  document.getElementById('btn-append').addEventListener('click', () => {
    const main = document.getElementById('pages');
    for (let i = 0; i < APPEND; i++) {
      lastSeq += 1;
      main.appendChild(makeFigure(lastSeq));
    }
    refresh();
  });

  // ② SPA 换页：history.pushState 改 URL（模拟单页应用路由）
  document.getElementById('btn-spa').addEventListener('click', () => {
    page += 1;
    const from = (page - 1) * PER_PAGE + 1;
    const main = document.getElementById('pages');
    main.replaceChildren();
    for (let seq = from; seq < from + PER_PAGE; seq++) main.appendChild(makeFigure(seq));
    lastSeq = from + PER_PAGE - 1;
    history.pushState({ page }, '', '/?page=' + page);
    refresh();
  });

  // ③ 整页导航：真跳转（模拟多页应用）
  document.getElementById('btn-mpa').addEventListener('click', () => {
    location.href = '/?page=' + (page + 1);
  });

  window.addEventListener('popstate', () => refresh());
  document.querySelectorAll('[data-testid="page-img"]').forEach((img) => {
    if (!img.complete) img.addEventListener('load', refresh, { once: true });
  });
  refresh();
</script>
</body>
</html>
`;
}

function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');

  const imgMatch = /^\/img\/(\d{1,3})\.png$/.exec(url.pathname);
  if (imgMatch) {
    const seq = Number.parseInt(imgMatch[1], 10);
    const { width, height } = sizeForSeq(seq);
    const png = makeSolidPng(width, height, (seq * 37) % 360);
    res.writeHead(200, {
      'Content-Type': 'image/png',
      'Content-Length': png.length,
      'Cache-Control': 'no-store',
    });
    return res.end(png);
  }

  if (url.pathname === '/' || url.pathname === '/index.html') {
    const pageRaw = Number.parseInt(url.searchParams.get('page') || '1', 10);
    const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
    const body = Buffer.from(html(page), 'utf8');
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Content-Length': body.length,
      'Cache-Control': 'no-store',
    });
    return res.end(body);
  }

  const body = Buffer.from(JSON.stringify({ error: 'not found', path: url.pathname }), 'utf8');
  res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length });
  return res.end(body);
}

function listenOnce(port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handle);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

const explicit = process.env.MOCK_PAGE_PORT ? Number.parseInt(process.env.MOCK_PAGE_PORT, 10) : null;
const candidates = explicit ? [explicit] : Array.from({ length: PORT_END - DEFAULT_PORT + 1 }, (_, i) => DEFAULT_PORT + i);

let started = null;
let lastErr = null;
for (const port of candidates) {
  try {
    started = { server: await listenOnce(port), port };
    break;
  } catch (err) {
    if (err && err.code === 'EADDRINUSE') { lastErr = err; continue; }
    throw err;
  }
}
if (!started) {
  throw new Error(`端口 ${candidates.join('–')} 全部被占用，页面站点启动失败：${lastErr && lastErr.message}`);
}

console.log('[mock-page] 漫画阅读页已启动');
console.log(`[mock-page] 地址：http://127.0.0.1:${started.port}/`);
console.log(`[mock-page] 图片：http://127.0.0.1:${started.port}/img/001.png`);
console.log(`[mock-page] 覆盖 ①整页导航 /?page=2 ②SPA pushState ③追加 8 张（不改 URL）`);

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    started.server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
