// 任务 / 批次 / 单图三层状态 + 串行 FIFO 队列 + 落盘 + eta
// 契约依据：§3 数据模型、§4 状态机、§5.2–5.7、§7 落盘、§8.2 安全
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import {
  BATCH_LIMIT, ETA_SAMPLE_WINDOW, MAX_SEQ, FILE_NAME_RE, ORIGINAL_SCAN_RE,
  TRANSLATED_SCAN_RE, TASKS_STATE_DIR, IDEMPOTENCY_FILE,
  assertInsideRoot, canonicalize, config, seq3,
} from './config.mjs';
import { ApiError } from './errors.mjs';
import { sniffImageType, readImageSize } from './image.mjs';
import { hueForSeq, makeSolidPng } from './png.mjs';
import { isSafeDirName } from './names.mjs';
import { writeSseEvent } from './sse.mjs';

const TASK_TERMINAL = new Set(['done', 'partial_failed', 'failed', 'canceled']);
const ITEM_TERMINAL = new Set(['success', 'failed', 'skipped']);
const MAX_ATTEMPTS = 2; // 首次 + 1 次重试（契约 §4.2「重试 N 次后失败」）
const MAX_EVENT_LOG = 20000;

/**
 * 允许降级为 `saved:false` 的**落盘/资源**错误（契约 §4.2「落盘失败不阻断主路径」）。
 *  · ENOSPC/EDQUOT/EROFS/EMFILE/ENFILE：磁盘满 / 配额 / 只读 / 句柄耗尽。
 *  · EEXIST：`wx` 独占写命中已存在文件——这是「文件已存在」这类**落盘失败**，
 *    正是 §7.4 幂等续做关掉开关（MOCK_SKIP_EXISTING=0）后要反向演练的旧行为。
 * 其余错误——特别是路径/安全类异常（§8.2 校验点 2 抛出的 ApiError PERMISSION_DENIED）——
 * 必须向上抛，绝不能静默变成 `success` 让任务走到 `done`。
 */
const DEGRADABLE_WRITE_ERRNOS = new Set(['ENOSPC', 'EDQUOT', 'EROFS', 'EMFILE', 'ENFILE', 'EEXIST']);

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

function ulid() {
  let ts = Date.now();
  const time = new Array(10);
  for (let i = 9; i >= 0; i--) {
    time[i] = CROCKFORD[ts % 32];
    ts = Math.floor(ts / 32);
  }
  const rnd = crypto.randomBytes(16);
  let tail = '';
  for (let i = 0; i < 16; i++) tail += CROCKFORD[rnd[i] % 32];
  return time.join('') + tail;
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const nowIso = () => new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');

export class Store {
  /** @param {string} rootDir 落盘根目录（已校验） */
  constructor(rootDir) {
    this.root = validateAndPrepare(rootDir);
    /** @type {Map<string, any>} taskId → task */
    this.tasks = new Map();
    /** @type {any[]} 等待执行的 task（不含当前运行中的） */
    this.queue = [];
    /** taskId:seq → Buffer，上传的原图字节（内存暂存，落盘时消费） */
    this.blobs = new Map();
    /** 近 N 张已完成 item 的耗时（毫秒），用于 eta */
    this.durations = [];
    this.eventSeq = 0;
    this.currentTaskId = null;
    this._loopActive = false;
    /** idempotencyKey → { taskId, batchIndex, at } */
    this.idempotency = new Map();
    this.startedAt = nowIso();
  }

  // ---------------------------------------------------------------- 启动恢复

  init() {
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    fs.mkdirSync(TASKS_STATE_DIR, { recursive: true, mode: 0o700 });
    try {
      const raw = JSON.parse(fs.readFileSync(IDEMPOTENCY_FILE, 'utf8'));
      for (const [k, v] of Object.entries(raw || {})) this.idempotency.set(k, v);
    } catch { /* 首次启动无文件 */ }

    let restored = 0;
    let aborted = 0;
    let files = [];
    try {
      files = fs.readdirSync(TASKS_STATE_DIR).filter((f) => f.endsWith('.json'));
    } catch { /* ignore */ }

    for (const f of files) {
      try {
        const task = JSON.parse(fs.readFileSync(path.join(TASKS_STATE_DIR, f), 'utf8'));
        if (!task || !task.taskId) continue;
        task.events = [];
        task.clients = new Set();
        task.cancelRequested = false;
        if (!TASK_TERMINAL.has(task.status)) {
          // 重启后内存中的原图字节已丢失，无法续做：按失败收尾（见交付说明中的歧义处置）
          for (const batch of task.batches || []) {
            for (const item of batch.items || []) {
              if (!ITEM_TERMINAL.has(item.status)) {
                item.status = 'failed';
                item.reason = 'service_restarted';
              }
            }
          }
          task.status = 'failed';
          aborted++;
          this._persistNow(task);
        }
        this.tasks.set(task.taskId, task);
        restored++;
      } catch { /* 单个任务文件损坏则跳过 */ }
    }
    return { restored, aborted };
  }

  // ---------------------------------------------------------------- 查询工具

  getTask(taskId) {
    return this.tasks.get(taskId) || null;
  }

  mustTask(taskId) {
    const task = this.getTask(taskId);
    if (!task) throw new ApiError('TASK_NOT_FOUND', `任务不存在：${taskId}`, { taskId });
    return task;
  }

  currentTask() {
    return this.currentTaskId ? this.tasks.get(this.currentTaskId) : null;
  }

  allItems(task) {
    return task.batches.flatMap((b) => b.items);
  }

  pendingCount(task) {
    return this.allItems(task).filter((i) => i.status === 'pending').length;
  }

  taskDir(task) {
    return path.join(this.root, task.dirName);
  }

  // ---------------------------------------------------------------- 创建/追加

  /**
   * POST /tasks
   * @param {object} input { payload, images:[{filename,data}], imageOrder }
   */
  createTask({ payload, images, imageOrder }) {
    const key = payload && payload.idempotencyKey;
    const replay = this._idempotencyHit(key);
    if (replay) {
      const task = this.mustTask(replay.taskId);
      return { task, replay: true };
    }

    const comicName = payload.comicName;
    const dirName = payload.__normalizedName; // 由 server 层规范化后注入
    const seqFrom = this._nextSeqFor(dirName);
    const count = images.length;
    this._assertSeqRange(seqFrom, count, dirName);

    const items = this._buildItems(seqFrom, images, imageOrder);
    const task = {
      taskId: `tsk_${ulid()}`,
      comicName,
      normalizedComicName: dirName,
      dirName,
      outputDir: path.join(this.root, dirName),
      status: 'queued',
      queuePosition: 0,
      lang: (payload && payload.lang) || { from: 'ja', to: 'zh' },
      translator: (payload && payload.translator) || 'sakura',
      clientTaskRef: (payload && payload.clientTaskRef) || null,
      idempotencyKey: key || null,
      createdAt: nowIso(),
      finishedAt: null,
      batches: [{
        batchIndex: 1,
        count,
        seqFrom,
        seqTo: seqFrom + count - 1,
        status: 'queued',
        idempotencyKey: key || null,
        items,
      }],
      events: [],
      clients: new Set(),
      cancelRequested: false,
    };
    for (const item of items) this.blobs.set(`${task.taskId}:${item.seq}`, item.__bytes);
    for (const item of items) delete item.__bytes;

    this.tasks.set(task.taskId, task);
    if (key) this._rememberIdempotency(key, task.taskId, 1);
    this._persistNow(task);
    this._enqueueOrStart(task);
    return { task, replay: false };
  }

  /** POST /tasks/{taskId}/batches */
  appendBatch(taskId, { payload, images, imageOrder }) {
    const task = this.mustTask(taskId);
    if (TASK_TERMINAL.has(task.status)) {
      throw new ApiError('TASK_NOT_APPENDABLE',
        `任务已处于终态 ${task.status}，无法追加批次`, { taskId, status: task.status });
    }
    const key = payload && payload.idempotencyKey;
    const replay = this._idempotencyHit(key);
    if (replay && replay.taskId === taskId) {
      return { task, replay: true };
    }

    const lastBatch = task.batches[task.batches.length - 1];
    // B(n+1).seqFrom 恒等于 B(n).seqTo + 1
    const seqFrom = lastBatch.seqTo + 1;
    const count = images.length;
    this._assertSeqRange(seqFrom, count, task.dirName);

    const items = this._buildItems(seqFrom, images, imageOrder);
    const batchIndex = task.batches.length + 1;
    task.batches.push({
      batchIndex,
      count,
      seqFrom,
      seqTo: seqFrom + count - 1,
      status: 'queued',
      idempotencyKey: key || null,
      items,
    });
    for (const item of items) this.blobs.set(`${task.taskId}:${item.seq}`, item.__bytes);
    for (const item of items) delete item.__bytes;

    if (key) this._rememberIdempotency(key, task.taskId, batchIndex);
    this._persistNow(task);
    this._emitBatchStatus(task, task.batches[batchIndex - 1]);
    return { task, replay: false };
  }

  _idempotencyHit(key) {
    if (!key) return null;
    const rec = this.idempotency.get(key);
    if (!rec) return null;
    if (Date.now() - rec.at > 24 * 3600 * 1000) {
      this.idempotency.delete(key);
      return null;
    }
    return rec;
  }

  _rememberIdempotency(key, taskId, batchIndex) {
    this.idempotency.set(key, { taskId, batchIndex, at: Date.now() });
    try {
      const obj = {};
      for (const [k, v] of this.idempotency) obj[k] = v;
      fs.writeFileSync(IDEMPOTENCY_FILE, JSON.stringify(obj, null, 2));
    } catch { /* ignore */ }
  }

  _buildItems(seqFrom, images, imageOrder) {
    const ordered = orderImages(images, imageOrder);
    const items = [];
    for (let i = 0; i < ordered.length; i++) {
      const img = ordered[i];
      const bytes = img.data;
      const ext = sniffImageType(bytes);
      if (!ext || bytes.length === 0) {
        throw new ApiError('INVALID_IMAGE', '图片 0 字节或无法解码（嗅探失败）', {
          index: i, filename: img.filename || null, bytes: bytes.length,
        });
      }
      items.push({
        seq: seqFrom + i,
        ext,
        byteSize: bytes.length,
        status: 'pending',
        saved: false,
        outputFile: null,
        originalFile: null,
        sha256: null,
        durationMs: null,
        retryCount: 0,
        reason: null,
        __bytes: bytes,
      });
    }
    return items;
  }

  _assertSeqRange(seqFrom, count, dirName) {
    if (seqFrom + count - 1 > MAX_SEQ) {
      throw new ApiError('SEQUENCE_OVERFLOW',
        `该漫画名页数已达上限（${MAX_SEQ}），请另存为新目录`,
        { limit: MAX_SEQ, seqFrom, seqTo: seqFrom + count - 1, normalizedComicName: dirName });
    }
  }

  /** nextSeq = max(目录内 ^(\d{3})\.(png|jpg|jpeg|webp)$ 的 N) + 1 */
  _nextSeqFor(dirName) {
    let diskMax = 0;
    const dir = path.join(this.root, dirName);
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = ORIGINAL_SCAN_RE.exec(f);
        if (m) diskMax = Math.max(diskMax, Number(m[1]));
      }
    } catch { /* 目录不存在 → 1 */ }

    // 已创建但尚未落盘的任务同样占用序号（避免同目录多个排队任务重号）
    let reserved = 0;
    for (const t of this.tasks.values()) {
      if (t.dirName !== dirName) continue;
      if (TASK_TERMINAL.has(t.status)) continue;
      const last = t.batches.length ? t.batches[t.batches.length - 1].seqTo : 0;
      reserved = Math.max(reserved, last);
    }
    return Math.max(diskMax, reserved) + 1;
  }

  // ---------------------------------------------------------------- 队列调度

  _enqueueOrStart(task) {
    const idle = !this.currentTaskId && this.queue.length === 0;
    if (idle) {
      // 创建即判定：立刻 running，queuePosition 0
      task.status = 'running';
      task.queuePosition = 0;
      this.currentTaskId = task.taskId;
      this._emitTaskStatus(task);
      this._persistNow(task);
      this._runTask(task)
        .catch(() => { /* 内部已兜底 */ })
        .finally(() => {
          // 仅当仍在跑自己时才清空，避免把已被 _runLoop 接手的后继任务误清
          if (this.currentTaskId === task.taskId) this.currentTaskId = null;
          this._runLoop();
        });
    } else {
      task.status = 'queued';
      this.queue.push(task);
      task.queuePosition = this.queue.length;
      this._emitTaskStatus(task);
      this._persistNow(task);
      this._runLoop();
    }
  }

  async _runLoop() {
    if (this._loopActive) return;
    this._loopActive = true;
    try {
      // 串行铁律：同一时刻只跑一个 Task（Task 是调度单位，Batch 不参与调度）
      while (this.currentTaskId === null && this.queue.length > 0) {
        const task = this.queue.shift();
        if (!task || task.status !== 'queued') continue;
        task.status = 'running';
        task.queuePosition = 0;
        this.currentTaskId = task.taskId;
        this._reindexQueue();
        this._emitTaskStatus(task);
        await this._runTask(task);
        this.currentTaskId = null;
      }
    } finally {
      this._loopActive = false;
    }
  }

  _reindexQueue() {
    this.queue.forEach((t, i) => { t.queuePosition = i + 1; });
  }

  async _runTask(task) {
    try {
      this._syncBatchStatuses(task);
      for (;;) {
        if (task.cancelRequested) break;
        const found = this._nextPendingItem(task);
        if (!found) break;
        await this._processItem(task, found.batch, found.item);
      }
      if (task.cancelRequested) {
        this._skipAllPending(task, 'canceled');
        this._finalize(task, 'canceled');
      } else {
        this._finalize(task, endStatusOf(this.allItems(task)));
      }
    } catch (err) {
      task.lastError = String((err && err.message) || err);
      // 正在处理中的 item 不能留在 translating（否则任务终态里挂着一个假「进行中」）
      for (const batch of task.batches) {
        for (const item of batch.items) {
          if (item.status === 'translating') {
            item.status = 'failed';
            item.saved = false;
            item.reason = 'internal_error';
            this._emitItemStatus(task, batch, item);
          }
        }
      }
      this._skipAllPending(task, 'internal_error');
      this._finalize(task, 'failed');
    }
  }

  _nextPendingItem(task) {
    for (const batch of task.batches) {
      for (const item of batch.items) {
        if (item.status === 'pending') return { batch, item };
      }
    }
    return null;
  }

  // ---------------------------------------------------------------- 单图处理

  async _processItem(task, batch, item) {
    const dir = this.taskDir(task);

    // 幂等续做：NNN_translated.* 已存在 → skipped(already_exists)，序号不变
    if (config.skipExisting && this._translatedExists(dir, item.seq)) {
      item.status = 'skipped';
      item.reason = 'already_exists';
      item.saved = true;
      item.outputFile = this._findTranslatedName(dir, item.seq);
      this._emitItemStatus(task, batch, item);
      this._syncBatchStatuses(task);
      await this._persist(task);
      return;
    }

    item.status = 'translating';
    this._emitItemStatus(task, batch, item);
    this._syncBatchStatuses(task);

    const t0 = Date.now();
    const forceFail = config.failSeqs.has(item.seq) ||
      (config.itemFailRate > 0 && Math.random() < config.itemFailRate);

    let attempt = 0;
    for (;;) {
      attempt++;
      const jitter = 0.8 + Math.random() * 0.4; // ±20%
      await sleep(Math.max(1, Math.round(config.itemMs * jitter)));
      if (forceFail && attempt < MAX_ATTEMPTS) continue;
      break;
    }

    if (forceFail) {
      item.status = 'failed';
      item.retryCount = attempt - 1;
      item.reason = config.failSeqs.has(item.seq) ? 'injected_failure' : 'random_failure';
      item.durationMs = Date.now() - t0;
      this._recordDuration(item.durationMs);
      this._emitItemStatus(task, batch, item);
      this._syncBatchStatuses(task);
      await this._persist(task);
      return;
    }

    // 合成译文并落盘。只有真正的落盘/资源错误才降级为 saved:false 且不阻断主路径
    // （§4.2「落盘失败不阻断主路径」）；其余错误（尤其是 §8.2 安全/路径类 ApiError）向上抛。
    try {
      await this._writeItem(task, item);
      item.saved = true;
    } catch (err) {
      const degradable = !(err instanceof ApiError) && DEGRADABLE_WRITE_ERRNOS.has(err && err.code);
      if (!degradable) throw err;
      item.saved = false;
      item.reason = err.code === 'ENOSPC' ? 'disk_full' : `write_failed:${err.code}`;
    }
    item.status = 'success';
    item.durationMs = Date.now() - t0;
    this._recordDuration(item.durationMs);
    this._emitItemStatus(task, batch, item);
    this._syncBatchStatuses(task);
    await this._persist(task);
  }

  _translatedExists(dir, seq) {
    return this._findTranslatedName(dir, seq) !== null;
  }

  _findTranslatedName(dir, seq) {
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = TRANSLATED_SCAN_RE.exec(f);
        if (m && Number(m[1]) === seq) return f;
      }
    } catch { /* 目录不存在 */ }
    return null;
  }

  /** 落盘：惰性 mkdir + 三次安全校验 + 独占写入 */
  async _writeItem(task, item) {
    if (!isSafeDirName(task.dirName)) {
      throw new ApiError('PERMISSION_DENIED', '漫画名含路径成分，拒绝落盘', { dirName: task.dirName });
    }
    if (config.diskFull) {
      // 演练用：强制落盘失败（结论见 §2.2 DISK_FULL / §4.2 saved:false）
      const err = new Error('ENOSPC: no space left on device（MOCK_DISK_FULL 演练）');
      err.code = 'ENOSPC';
      throw err;
    }
    const dir = this.taskDir(task);
    const original = `${seq3(item.seq)}.${item.ext}`;
    const translated = `${seq3(item.seq)}_translated.${item.ext}`;
    if (!FILE_NAME_RE.test(original) || !FILE_NAME_RE.test(translated)) {
      throw new ApiError('PERMISSION_DENIED', '服务端生成的文件名不合法', { original, translated });
    }
    // 校验点 3：拼接后前缀（创建目录前）
    assertInsideRoot(this.root, path.join(dir, original));
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 }); // 目录惰性创建
    assertInsideRoot(this.root, path.join(dir, original)); // 校验点 3：打开文件前

    const bytes = this.blobs.get(`${task.taskId}:${item.seq}`);
    if (!bytes) throw new Error('原图字节已丢失（服务可能重启过）');

    fs.writeFileSync(path.join(dir, original), bytes, { flag: 'wx', mode: 0o600 });
    item.originalFile = original;

    const size = readImageSize(bytes, item.ext) || { width: 400, height: 600 };
    const png = makeSolidPng(size.width, size.height, hueForSeq(item.seq));
    fs.writeFileSync(path.join(dir, translated), png, { flag: 'wx', mode: 0o600 });
    item.outputFile = translated;
    item.sha256 = sha256(png);
    this.blobs.delete(`${task.taskId}:${item.seq}`);
  }

  // ---------------------------------------------------------------- 终态

  _skipAllPending(task, reason) {
    for (const batch of task.batches) {
      for (const item of batch.items) {
        if (item.status === 'pending') {
          item.status = 'skipped';
          item.reason = reason;
          this._emitItemStatus(task, batch, item);
        }
      }
    }
    this._syncBatchStatuses(task);
  }

  _finalize(task, status) {
    task.status = status;
    task.finishedAt = nowIso();
    task.queuePosition = 0;
    const idx = this.queue.indexOf(task);
    if (idx >= 0) this.queue.splice(idx, 1);
    // 移出队列后必须重排名次，否则余下任务的 queuePosition 与 GET /queue 的 position 打架（§5.7）
    this._reindexQueue();
    this._syncBatchStatuses(task);
    this._emitTaskStatus(task);
    this._persistNow(task);
    if (task._settleResolve) {
      task._settleResolve();
      task._settleResolve = null;
    }
  }

  _settled(task, timeoutMs) {
    if (TASK_TERMINAL.has(task.status)) return Promise.resolve();
    if (!task._settlePromise) {
      task._settlePromise = new Promise((resolve) => { task._settleResolve = resolve; });
    }
    let timer = null;
    return Promise.race([
      task._settlePromise,
      new Promise((resolve) => { timer = setTimeout(resolve, timeoutMs); }),
    ]).finally(() => { if (timer) clearTimeout(timer); });
  }

  /** POST /tasks/{taskId}/cancel（§5.6） */
  async cancelTask(taskId) {
    const task = this.mustTask(taskId);
    if (TASK_TERMINAL.has(task.status)) {
      throw new ApiError('TASK_NOT_CANCELABLE',
        `任务已处于终态 ${task.status}，无法取消`, { taskId, status: task.status });
    }
    task.cancelRequested = true;

    if (task.status === 'queued') {
      // 未开始：无文件、无目录产生；队列余下不受影响
      this._skipAllPending(task, 'canceled');
      this._finalize(task, 'canceled');
      return this._cancelResult(task);
    }
    // 正在 running：等当前张跑完（不中断 sidecar）
    await this._settled(task, 30000);
    if (!TASK_TERMINAL.has(task.status)) {
      this._skipAllPending(task, 'canceled');
      this._finalize(task, 'canceled');
    }
    return this._cancelResult(task);
  }

  _cancelResult(task) {
    const keptItems = this.allItems(task).filter((i) => i.status === 'success' && i.saved).length;
    return {
      taskId: task.taskId,
      status: 'canceled',
      keptItems,
      outputDir: task.outputDir,
    };
  }

  // ---------------------------------------------------------------- 视图

  /** §5.2 / §5.3 的创建与追加响应 */
  createView(task) {
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      normalizedComicName: task.normalizedComicName,
      outputDir: task.outputDir,
      status: task.status,
      queuePosition: task.queuePosition,
      batches: task.batches.map(batchBrief),
      eta: this.etaFor(task),
      createdAt: task.createdAt,
    };
  }

  /** §5.4 的任务详情 */
  detailView(task, { itemsFrom, itemsTo } = {}) {
    const items = this.allItems(task).filter((i) => {
      if (itemsFrom !== undefined && i.seq < itemsFrom) return false;
      if (itemsTo !== undefined && i.seq > itemsTo) return false;
      return true;
    });
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      normalizedComicName: task.normalizedComicName,
      outputDir: task.outputDir,
      status: task.status,
      queuePosition: task.queuePosition,
      progress: this.progressOf(task),
      batches: task.batches.map(batchBrief),
      items: items.map(itemBrief),
      eta: this.etaFor(task),
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
    };
  }

  progressOf(task) {
    const items = this.allItems(task);
    const done = items.filter((i) => i.status === 'success' || i.status === 'skipped').length;
    const failed = items.filter((i) => i.status === 'failed').length;
    const cur = items.find((i) => i.status === 'translating');
    return { total: items.length, done, failed, current: cur ? cur.seq : 0 };
  }

  /** §5.7 队列快照（排队位次与 eta 的唯一来源） */
  queueSnapshot() {
    const running = this.currentTask();
    if (process.env.MOCK_DEBUG) {
      console.error('[debug] queueSnapshot', 'currentTaskId=', this.currentTaskId,
        'running=', running && running.comicName, 'queue=', this.queue.map((t) => t.comicName),
        'tasks=', [...this.tasks.keys()].length);
    }
    return {
      running: running ? {
        taskId: running.taskId,
        comicName: running.comicName,
        progress: (() => { const p = this.progressOf(running); return { done: p.done, total: p.total }; })(),
      } : null,
      queued: this.queue.map((t, i) => ({
        taskId: t.taskId,
        comicName: t.comicName,
        position: i + 1,
        imageCount: this.allItems(t).length,
        etaSeconds: this.etaSecondsFor(t),
      })),
      updatedAt: nowIso(),
    };
  }

  // ---------------------------------------------------------------- eta

  _recordDuration(ms) {
    if (!Number.isFinite(ms)) return;
    this.durations.push(ms);
    if (this.durations.length > ETA_SAMPLE_WINDOW) this.durations.shift();
  }

  _avgDuration() {
    if (this.durations.length === 0) return null;
    return this.durations.reduce((a, b) => a + b, 0) / this.durations.length;
  }

  /** 前方剩余总张数（见交付说明的 eta 口径裁决） */
  aheadCountFor(task) {
    if (task.status === 'running' || task.queuePosition === 0) return this.pendingCount(task);
    let n = 0;
    const running = this.currentTask();
    if (running && running.taskId !== task.taskId) n += this.pendingCount(running);
    for (const t of this.queue) {
      if (t.taskId === task.taskId) break;
      n += this.pendingCount(t);
    }
    return n;
  }

  /** §5.2 的 eta 对象；MOCK_ETA_NULL=1 时恒为 null */
  etaFor(task) {
    if (config.etaNull) return null;
    const avg = this._avgDuration();
    if (avg === null) {
      // 无历史样本（首跑）：仍是区间
      return { minSeconds: 60, maxSeconds: 180, text: '预计 1–3 分钟' };
    }
    const ahead = this.aheadCountFor(task);
    const base = (avg * ahead) / 1000;
    const min = Math.max(1, Math.round(base * 0.8));
    const max = Math.max(min + 1, Math.round(base * 1.5));
    return { minSeconds: min, maxSeconds: max, text: formatEtaText(min, max) };
  }

  /** §5.7 的 etaSeconds；无样本时同样返回 1–3 分钟区间 */
  etaSecondsFor(task) {
    if (config.etaNull) return null;
    const eta = this.etaFor(task);
    return { min: eta.minSeconds, max: eta.maxSeconds, text: eta.text };
  }

  // ---------------------------------------------------------------- 事件

  _emit(task, event, data) {
    const rec = { id: ++this.eventSeq, event, data };
    task.events.push(rec);
    if (task.events.length > MAX_EVENT_LOG) task.events.splice(0, task.events.length - MAX_EVENT_LOG);
    for (const res of task.clients) {
      if (!writeSseEvent(res, rec)) task.clients.delete(res);
    }
    this.lastEventAt = Date.now();
    return rec;
  }

  _emitTaskStatus(task) {
    this._emit(task, 'task.status', {
      taskId: task.taskId,
      status: task.status,
      queuePosition: task.queuePosition,
    });
  }

  _emitBatchStatus(task, batch) {
    this._emit(task, 'batch.status', {
      taskId: task.taskId,
      batchIndex: batch.batchIndex,
      status: batch.status,
      seqFrom: batch.seqFrom,
      seqTo: batch.seqTo,
    });
  }

  _emitItemStatus(task, batch, item) {
    this._emit(task, 'item.status', {
      taskId: task.taskId,
      batchIndex: batch.batchIndex,
      seq: item.seq,
      status: item.status,
      saved: item.saved,
      outputFile: item.outputFile,
      durationMs: item.durationMs,
    });
  }

  /** 心跳：不进入事件日志，只发给当前订阅者（id 仍递增，保证 Last-Event-ID 语义） */
  broadcastHeartbeat() {
    const ts = nowIso();
    for (const task of this.tasks.values()) {
      if (task.clients.size === 0) continue;
      const rec = { id: ++this.eventSeq, event: 'heartbeat', data: { ts } };
      for (const res of task.clients) {
        if (!writeSseEvent(res, rec)) task.clients.delete(res);
      }
    }
  }

  /** SSE 订阅：先按 Last-Event-ID 重放，再挂上实时推送 */
  subscribe(taskId, res, lastEventId) {
    const task = this.mustTask(taskId);
    const last = Number.isFinite(lastEventId) ? lastEventId : -1;
    for (const rec of task.events) {
      if (rec.id > last) writeSseEvent(res, rec);
    }
    task.clients.add(res);
    return () => { task.clients.delete(res); };
  }

  // ---------------------------------------------------------------- 状态同步

  _syncBatchStatuses(task) {
    for (const batch of task.batches) {
      const next = batchStatusOf(task, batch);
      if (batch.status !== next) {
        batch.status = next;
        this._emitBatchStatus(task, batch);
      }
    }
  }

  // ---------------------------------------------------------------- 持久化

  serialize(task) {
    return {
      taskId: task.taskId,
      comicName: task.comicName,
      normalizedComicName: task.normalizedComicName,
      dirName: task.dirName,
      outputDir: task.outputDir,
      status: task.status,
      lang: task.lang,
      translator: task.translator,
      clientTaskRef: task.clientTaskRef,
      idempotencyKey: task.idempotencyKey,
      createdAt: task.createdAt,
      finishedAt: task.finishedAt,
      finalProgress: this.progressOf(task),
      batches: task.batches.map((b) => ({
        batchIndex: b.batchIndex,
        count: b.count,
        seqFrom: b.seqFrom,
        seqTo: b.seqTo,
        status: b.status,
        idempotencyKey: b.idempotencyKey,
        items: b.items.map((i) => ({
          seq: i.seq,
          ext: i.ext,
          byteSize: i.byteSize,
          status: i.status,
          saved: i.saved,
          originalFile: i.originalFile,
          outputFile: i.outputFile,
          sha256: i.sha256,
          durationMs: i.durationMs,
          retryCount: i.retryCount,
          reason: i.reason,
        })),
      })),
    };
  }

  _persistNow(task) {
    try {
      fs.mkdirSync(TASKS_STATE_DIR, { recursive: true, mode: 0o700 });
      const file = path.join(TASKS_STATE_DIR, `${task.taskId}.json`);
      fs.writeFileSync(file, JSON.stringify(this.serialize(task), null, 2), { mode: 0o600 });
    } catch { /* 任务清单写入失败不影响主路径 */ }
  }

  async _persist(task) {
    this._persistNow(task);
  }
}

// ------------------------------------------------------------------ 纯函数

function batchBrief(b) {
  return {
    batchIndex: b.batchIndex,
    count: b.count,
    seqFrom: b.seqFrom,
    seqTo: b.seqTo,
    status: b.status,
  };
}

function itemBrief(i) {
  return {
    seq: i.seq,
    status: i.status,
    saved: i.saved,
    outputFile: i.outputFile,
    durationMs: i.durationMs,
    retryCount: i.retryCount,
    reason: i.reason,
    sha256: i.sha256,
  };
}

export function endStatusOf(items) {
  const success = items.filter((i) => i.status === 'success' || i.status === 'skipped').length;
  const failed = items.filter((i) => i.status === 'failed').length;
  if (failed === 0) return 'done';
  if (success > 0) return 'partial_failed';
  return 'failed';
}

function batchStatusOf(task, batch) {
  const st = batch.items.map((i) => i.status);
  if (task.status === 'canceled' &&
      st.some((s, idx) => s === 'skipped' && batch.items[idx].reason === 'canceled')) {
    return 'canceled';
  }
  if (st.every((s) => s === 'pending')) return 'queued';
  if (st.some((s) => s === 'pending' || s === 'translating')) return 'running';
  const ok = st.filter((s) => s === 'success' || s === 'skipped').length;
  const bad = st.filter((s) => s === 'failed').length;
  if (bad === 0) return 'done';
  if (ok === 0) return 'failed';
  return 'partial_failed';
}

export function formatEtaText(minSeconds, maxSeconds) {
  if (maxSeconds < 60) return `预计 ${minSeconds}–${maxSeconds} 秒`;
  const m1 = Math.max(1, Math.floor(minSeconds / 60));
  const m2 = Math.max(m1 + 1, Math.ceil(maxSeconds / 60));
  return `预计 ${m1}–${m2} 分钟`;
}

/** imageOrder[] 显式顺序兜底：支持「原始 filename」或「1 起序号」两种写法 */
export function orderImages(images, imageOrder) {
  if (!imageOrder || imageOrder.length === 0) return images;
  const byName = new Map();
  images.forEach((img, i) => {
    if (img.filename && !byName.has(img.filename)) byName.set(img.filename, i);
    if (!byName.has(String(i + 1))) byName.set(String(i + 1), i);
  });
  const picked = new Set();
  const out = [];
  for (const key of imageOrder) {
    const idx = byName.get(String(key).trim());
    if (idx === undefined || picked.has(idx)) continue;
    picked.add(idx);
    out.push(images[idx]);
  }
  images.forEach((img, i) => { if (!picked.has(i)) out.push(img); });
  return out;
}

function validateAndPrepare(dir) {
  // 启动时校验一次由 server 层通过 validateRoot 完成；此处只做规范化兜底
  return canonicalize(dir);
}

export { BATCH_LIMIT, MAX_SEQ };
