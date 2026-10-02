// box-service（mock）HTTP 入口
// 契约依据：§1 拓扑与端口、§2 通用约定、§5 端点、§8 安全
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';

import {
  API_VERSION, BASE_PATH, BATCH_LIMIT, ORIGINAL_SCAN_RE, ROOT_DIR,
  SERVICE_NAME, SERVICE_VERSION, TASKS_STATE_DIR, TRANSLATED_SCAN_RE,
  assertInsideRoot, config, validateRoot,
} from './config.mjs';
import { ApiError, errorEnvelope, permissionDenied } from './errors.mjs';
import { allFieldStrings, firstField, groupParts, parseMultipart } from './multipart.mjs';
import { normalizeComicName, isSafeDirName } from './names.mjs';
import { Store } from './store.mjs';
import { HEARTBEAT_MS, SSE_HEADERS, writeComment } from './sse.mjs';

const MAX_BODY = 256 * 1024 * 1024; // 20 张高分辨率原图的宽松上限
const MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

// ------------------------------------------------------------------ 启动准备

// 落盘根目录：启动时校验一次（契约 §8.2 校验点 1）
const rootCanonical = validateRoot(ROOT_DIR);
const store = new Store(rootCanonical);
const restore = store.init();
store.startedAt = new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
const bootedAt = Date.now();

// 模拟 sidecar 状态
const sidecarReadyMs = Number(process.env.MOCK_SIDECAR_START_MS || 0);
function sidecarState() {
  if (config.sidecarDown) return 'down';
  if (Date.now() - bootedAt < sidecarReadyMs) return 'starting';
  return 'running';
}

const serverLog = (msg) => console.log(`[box-service] ${msg}`);
const securityLog = (msg) => console.warn(`[box-service][security] ${msg}`);

/** sidecar 未就绪 → 503 UNAVAILABLE（契约 §2.2） */
function assertSidecarReady() {
  const state = sidecarState();
  if (state !== 'running') {
    throw new ApiError('UNAVAILABLE', `翻译引擎（sidecar）未就绪：state=${state}`,
      { sidecar: { state, port: config.sidecarPort } });
  }
}

// ------------------------------------------------------------------ CORS / 鉴权

/**
 * Origin 白名单：chrome-extension://* 或 null（Box 桌面端）
 * @returns {{ok:boolean, allow:string|null}}
 */
function checkOrigin(originHeader) {
  if (originHeader === undefined || originHeader === null || String(originHeader).trim() === '') {
    return { ok: true, allow: null };
  }
  const o = String(originHeader).trim();
  if (o === 'null') return { ok: true, allow: 'null' };
  if (/^chrome-extension:\/\/[A-Za-z0-9._-]+$/.test(o)) return { ok: true, allow: o };
  return { ok: false, allow: null };
}

function corsHeaders(allow) {
  const h = {
    Vary: 'Origin',
    'Access-Control-Allow-Headers': 'X-Box-Token, X-Box-Client',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Max-Age': '600',
  };
  // 绝不返回 `*`；无 Origin 时不带此头
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
}

function tokenMatches(provided) {
  if (typeof provided !== 'string' || provided.length === 0) return false;
  const a = Buffer.from(provided, 'utf8');
  const b = Buffer.from(config.token, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function sendJson(res, status, body, cors) {
  const buf = Buffer.from(JSON.stringify(body), 'utf8');
  res.writeHead(status, {
    ...cors,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': buf.length,
  });
  res.end(buf);
}

function sendError(res, err, cors) {
  const { status, body } = errorEnvelope(err);
  if (!(err instanceof ApiError)) {
    console.error('[box-service] 未预期错误：', err);
  }
  sendJson(res, status, body, cors);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) {
      throw new ApiError('INVALID_IMAGE', '请求体过大', { limitBytes: MAX_BODY });
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// ------------------------------------------------------------------ 端点实现

function healthView() {
  const state = sidecarState();
  const status = state === 'running' ? 'ok' : (state === 'starting' ? 'starting' : 'degraded');
  return {
    status,
    service: SERVICE_NAME,
    version: SERVICE_VERSION,
    apiVersion: API_VERSION,
    sidecar: { state, port: config.sidecarPort },
    startedAt: store.startedAt,
  };
}

/** 解析 multipart 表单：payload + images[] + imageOrder[] */
function parseUploadRequest(req, body) {
  const ct = req.headers['content-type'] || '';
  if (!/multipart\/form-data/i.test(ct)) {
    throw new ApiError('INVALID_IMAGE', 'Content-Type 必须是 multipart/form-data', { contentType: ct });
  }
  const parts = parseMultipart(body, ct);
  if (parts === null) {
    throw new ApiError('INVALID_IMAGE', 'multipart 缺少 boundary', {});
  }
  const { fields, files } = groupParts(parts);
  const images = (files.get('images') || []).map((p) => ({
    filename: p.filename,
    contentType: p.contentType,
    data: p.data,
  }));

  if (images.length === 0) {
    throw new ApiError('INVALID_IMAGE', 'images[] 缺失或为空（至少需要 1 张图片）', { submitted: 0 });
  }
  if (images.length > BATCH_LIMIT) {
    throw new ApiError('BATCH_LIMIT_EXCEEDED',
      `单次最多提交 ${BATCH_LIMIT} 张，当前 ${images.length} 张`,
      { limit: BATCH_LIMIT, submitted: images.length });
  }

  let payload = {};
  // `payload` 既可能是普通字段（推荐），也可能被客户端当文件 part 上传，两者都接受
  let rawPayload = firstField(fields, 'payload');
  if (rawPayload === null) {
    const asFile = files.get('payload');
    if (asFile && asFile.length > 0) rawPayload = asFile[0].data.toString('utf8');
  }
  if (rawPayload !== null && rawPayload !== undefined && rawPayload.trim() !== '') {
    try {
      payload = JSON.parse(rawPayload);
    } catch {
      payload = {};
    }
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) payload = {};
  return { payload, images, imageOrder: allFieldStrings(fields, 'imageOrder') };
}

function handleCreateTask(req, res, cors) {
  return readBody(req).then((body) => {
    assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    const norm = normalizeComicName(payload.comicName);
    if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
    payload.__normalizedName = norm.name;

    const { task, replay } = store.createTask({ payload, images, imageOrder });
    const view = store.createView(task);
    // IDEMPOTENT_REPLAY：HTTP 200 + 完整 Task 对象（不返回 error 信封）
    if (replay) view.idempotentReplay = true;
    sendJson(res, replay ? 200 : 201, view, cors);
  });
}

function handleAppendBatch(req, res, cors, taskId) {
  return readBody(req).then((body) => {
    assertSidecarReady();
    const { payload, images, imageOrder } = parseUploadRequest(req, body);
    const { task, replay } = store.appendBatch(taskId, { payload, images, imageOrder });
    const view = store.createView(task);
    if (replay) view.idempotentReplay = true;
    sendJson(res, 200, view, cors);
  });
}

function handleTaskDetail(req, res, cors, taskId, url) {
  const task = store.mustTask(taskId);
  const from = url.searchParams.get('itemsFrom');
  const to = url.searchParams.get('itemsTo');
  const opts = {};
  if (from !== null) opts.itemsFrom = Number.parseInt(from, 10);
  if (to !== null) opts.itemsTo = Number.parseInt(to, 10);
  sendJson(res, 200, store.detailView(task, opts), cors);
}

function handleSse(req, res, cors, taskId) {
  store.mustTask(taskId); // 先抛 404，再升级为事件流
  const headerId = req.headers['last-event-id'];
  const url = new URL(req.url, 'http://127.0.0.1');
  const rawId = headerId !== undefined ? headerId : url.searchParams.get('lastEventId');
  const lastEventId = rawId === null || rawId === undefined ? -1 : Number.parseInt(String(rawId), 10);

  res.writeHead(200, { ...cors, ...SSE_HEADERS });
  res.socket?.setNoDelay?.(true);
  res.socket?.setTimeout?.(0);
  writeComment(res, 'connected');
  const unsubscribe = store.subscribe(taskId, res, Number.isFinite(lastEventId) ? lastEventId : -1);

  const cleanup = () => unsubscribe();
  req.on('close', cleanup);
  res.on('close', cleanup);
  res.on('error', cleanup);
}

async function handleCancel(req, res, cors, taskId) {
  const result = await store.cancelTask(taskId);
  sendJson(res, 200, result, cors);
}

function handleQueue(req, res, cors) {
  sendJson(res, 200, store.queueSnapshot(), cors);
}

// ------------------------------------------------------------------ 库与导出

function scanLibrary() {
  const root = store.root;
  const comics = [];
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch { /* 根目录不存在 → 空库 */ }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const originals = new Set();
    const translated = new Set();
    let modifiedMs = 0;
    try {
      for (const f of fs.readdirSync(dir)) {
        let m = ORIGINAL_SCAN_RE.exec(f);
        if (m) originals.add(Number(m[1]));
        m = TRANSLATED_SCAN_RE.exec(f);
        if (m) translated.add(Number(m[1]));
      }
      modifiedMs = fs.statSync(dir).mtimeMs;
    } catch { /* ignore */ }
    const seqMax = originals.size ? Math.max(...originals) : 0;
    comics.push({
      comicName: entry.name,
      dirName: entry.name,
      outputDir: dir,
      imageCount: originals.size,
      translatedCount: translated.size,
      seqMax,
      nextSeq: seqMax + 1,
      modifiedAt: modifiedMs ? new Date(modifiedMs).toISOString().replace(/\.\d{3}Z$/, 'Z') : null,
    });
  }
  comics.sort((a, b) => a.comicName.localeCompare(b.comicName, 'zh-Hans-CN'));
  return {
    root,
    count: comics.length,
    comics,
    updatedAt: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
  };
}

/** 解析并校验漫画目录（路径越界 → 403 + 安全日志） */
function resolveComicDir(rawName) {
  const norm = normalizeComicName(rawName);
  if (!norm.ok) throw new ApiError(norm.code, norm.message, norm.details);
  if (!isSafeDirName(norm.name)) {
    securityLog(`拒绝路径越界的漫画名：${JSON.stringify(rawName)}`);
    throw permissionDenied();
  }
  const dir = path.join(store.root, norm.name);
  try {
    assertInsideRoot(store.root, path.join(dir, 'x.png'));
  } catch {
    securityLog(`拼接后前缀校验失败：${dir}（root=${store.root}）`);
    throw permissionDenied();
  }
  return { name: norm.name, dir };
}

function findFile(dir, seq, variant) {
  const wantTranslated = variant === 'translated';
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return null;
  }
  for (const f of names) {
    const m = wantTranslated ? TRANSLATED_SCAN_RE.exec(f) : ORIGINAL_SCAN_RE.exec(f);
    if (m && Number(m[1]) === seq) return f;
  }
  return null;
}

function handleLibraryFile(req, res, cors, rawName, seqText, url) {
  const { dir } = resolveComicDir(rawName);
  const seq = Number.parseInt(seqText, 10);
  if (!Number.isFinite(seq) || seq < 1 || seq > 999) {
    throw new ApiError('INVALID_IMAGE', 'seq 必须是 1–999 的整数', { seq: seqText });
  }
  const variant = url.searchParams.get('variant') || 'translated';
  if (!['original', 'translated'].includes(variant)) {
    throw new ApiError('INVALID_IMAGE', 'variant 只能是 original 或 translated', { variant });
  }
  const name = findFile(dir, seq, variant);
  if (!name) {
    throw new ApiError('TASK_NOT_FOUND', '漫画库中找不到该文件', {
      comicName: path.basename(dir), seq, variant, root: store.root,
    });
  }
  const file = path.join(dir, name);
  try {
    assertInsideRoot(store.root, file); // 打开文件前再校验一次（防 TOCTOU）
  } catch {
    securityLog(`文件读取越界：${file}`);
    throw permissionDenied();
  }
  const ext = name.split('.').pop().toLowerCase();
  const stat = fs.statSync(file);
  res.writeHead(200, {
    ...cors,
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Content-Disposition': `inline; filename="${name}"`,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(file).pipe(res);
}

function handleReveal(req, res, cors, rawName) {
  const { dir, name } = resolveComicDir(rawName);
  if (!fs.existsSync(dir)) {
    throw new ApiError('TASK_NOT_FOUND', '漫画目录不存在', { comicName: name, outputDir: dir });
  }
  // mock 不真的打开系统文件管理器，但必须完成路径校验
  sendJson(res, 200, { ok: true, path: dir, comicName: name }, cors);
}

// ------------------------------------------------------------------ 路由

function splitPath(pathname) {
  return pathname.split('/').filter((s) => s.length > 0).map((s) => {
    try { return decodeURIComponent(s); } catch { return s; }
  });
}

function route(req, res, cors, url) {
  const seg = splitPath(url.pathname);
  const method = req.method || 'GET';

  // GET /health —— 唯一免鉴权
  if (seg.length === 3 && seg[0] === 'api' && seg[1] === API_VERSION && seg[2] === 'health' && method === 'GET') {
    return sendJson(res, 200, healthView(), cors);
  }
  // 兼容 /api/v1 之外的健康探测
  if (seg.length === 1 && seg[0] === 'health' && method === 'GET') {
    return sendJson(res, 200, healthView(), cors);
  }

  if (seg[0] !== 'api' || seg[1] !== API_VERSION) {
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  const p = seg.slice(2);

  // /tasks
  if (p.length === 1 && p[0] === 'tasks') {
    if (method === 'POST') return handleCreateTask(req, res, cors);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  // /tasks/{taskId}
  if (p.length === 2 && p[0] === 'tasks') {
    if (method === 'GET') return handleTaskDetail(req, res, cors, p[1], url);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }
  // /tasks/{taskId}/batches | events | cancel
  if (p.length === 3 && p[0] === 'tasks') {
    if (p[2] === 'batches' && method === 'POST') return handleAppendBatch(req, res, cors, p[1]);
    if (p[2] === 'events' && method === 'GET') return handleSse(req, res, cors, p[1]);
    if (p[2] === 'cancel' && method === 'POST') return handleCancel(req, res, cors, p[1]);
    throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
  }

  // /queue
  if (p.length === 1 && p[0] === 'queue' && method === 'GET') {
    return handleQueue(req, res, cors);
  }

  // /library
  if (p.length === 1 && p[0] === 'library' && method === 'GET') {
    return sendJson(res, 200, scanLibrary(), cors);
  }
  // /library/{comicName}/files/{seq}
  if (p.length === 4 && p[0] === 'library' && p[2] === 'files' && method === 'GET') {
    return handleLibraryFile(req, res, cors, p[1], p[3], url);
  }
  // /library/{comicName}/reveal
  if (p.length === 3 && p[0] === 'library' && p[2] === 'reveal' && method === 'POST') {
    return handleReveal(req, res, cors, p[1]);
  }

  throw new ApiError('TASK_NOT_FOUND', `未知端点：${method} ${url.pathname}`, { path: url.pathname });
}

// ------------------------------------------------------------------ 请求入口

function createHandler() {
  return async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const origin = checkOrigin(req.headers.origin);
    const cors = corsHeaders(origin.allow);
    const client = req.headers['x-box-client'] || '-';
    const isHealth = /^\/(api\/v1\/)?health$/.test(url.pathname);

    try {
      // 1) Origin 校验（含 Origin 才校验）
      if (!origin.ok) {
        securityLog(`Origin 拒绝：${req.headers.origin}；${req.method} ${url.pathname}；client=${client}`);
        throw permissionDenied();
      }
      // 2) CORS 预检：multipart/form-data 属简单请求不触发预检，预检不作为安全边界
      if (req.method === 'OPTIONS') {
        res.writeHead(204, cors);
        return res.end();
      }
      // 3) 鉴权（/health 豁免）
      if (!isHealth && !tokenMatches(req.headers['x-box-token'])) {
        securityLog(`令牌校验失败：${req.method} ${url.pathname}；client=${client}`);
        throw permissionDenied();
      }
      return await route(req, res, cors, url);
    } catch (err) {
      if (res.headersSent) {
        try { res.end(); } catch { /* ignore */ }
        console.error('[box-service] 响应已开始后出错：', err);
        return;
      }
      return sendError(res, err, cors);
    }
  };
}

// ------------------------------------------------------------------ 监听

function listenOnce(handler, port) {
  return new Promise((resolve, reject) => {
    const server = http.createServer(handler);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve(server);
    });
  });
}

/** §1：默认 5180；被占时在 5180–5190 内探测；全段被占则启动失败 */
async function listenWithProbe(handler) {
  const candidates = config.explicitPort !== null
    ? [config.explicitPort]
    : Array.from({ length: config.portEnd - config.portStart + 1 }, (_, i) => config.portStart + i);

  let lastErr = null;
  for (const port of candidates) {
    try {
      const server = await listenOnce(handler, port);
      return { server, port };
    } catch (err) {
      if (err && err.code === 'EADDRINUSE') {
        serverLog(`端口 ${port} 被占用，尝试下一个…`);
        lastErr = err;
        continue;
      }
      throw err;
    }
  }
  const range = config.explicitPort !== null
    ? `${config.explicitPort}（MOCK_PORT 指定）`
    : `${config.portStart}–${config.portEnd}`;
  throw new Error(
    `端口 ${range} 全部被占用，box-service 启动失败（不静默换到段外）。最后错误：${lastErr && lastErr.message}`);
}

const { server, port } = await listenWithProbe(createHandler());
store.port = port;

const heartbeatTimer = setInterval(() => store.broadcastHeartbeat(), HEARTBEAT_MS);
heartbeatTimer.unref?.();

serverLog('================ mock box-service 已启动 ================');
serverLog(`监听地址   : http://127.0.0.1:${port}${BASE_PATH}`);
serverLog(`令牌       : ${config.token}`);
serverLog(`落盘根目录 : ${store.root}`);
serverLog(`状态目录   : ${TASKS_STATE_DIR}`);
serverLog(`sidecar    : 模拟 port=${config.sidecarPort} state=${sidecarState()}`);
serverLog(`item 耗时  : ${config.itemMs}ms（±20% 抖动）`);
serverLog(`可选项     : ETA_NULL=${config.etaNull} SKIP_EXISTING=${config.skipExisting} `
  + `FAIL_SEQ=[${[...config.failSeqs].join(',')}] ITEM_FAIL_RATE=${config.itemFailRate}`);
if (restore.restored > 0) {
  serverLog(`任务清单恢复：${restore.restored} 个（其中 ${restore.aborted} 个非终态任务已按 failed 收尾）`);
}
serverLog('=========================================================');

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    serverLog(`收到 ${sig}，关闭中…`);
    clearInterval(heartbeatTimer);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 500).unref();
  });
}
