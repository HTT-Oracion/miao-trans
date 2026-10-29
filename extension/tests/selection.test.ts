/**
 * 单元测试 —— 选图/提交规则、分层拦截与三条 P0 硬规则。
 * 依据：《01》§5.1 / §5.2 / §5.3 / §6.3 / §6.7 / §7，《03》§4.3 / §4.4 / §5.7。
 */

import { describe, expect, it } from 'vitest';
import { BATCH_LIMIT, SELECT_LIMIT } from '../src/types/contract';
import {
  LEAVE_DOM_CLEAR_THRESHOLD,
  canWriteBack,
  computeSelectionCounter,
  countLeftDom,
  decideSubmit,
  onRouteChangePlan,
  sameImageUrl,
  shouldClearSelection,
  thumbStatusOf,
} from '../src/selection/rules';
import {
  CAPABILITIES,
  CLIENT_STATES,
  cancelConfirmCopy,
  clientStateFromTaskStatus,
  hintRowFor,
  isActive,
  isTerminal,
  receiptFor,
  splitCount,
} from '../src/domain/clientState';

describe('《01》§5.2 计数三态', () => {
  it('≤49：ink-2 色 + 「已选 6 张 · 分布于 1 页」', () => {
    const c = computeSelectionCounter(6, 1);
    expect(c.tone).toBe('normal');
    expect(c.token).toBe('ink-2');
    expect(c.text).toBe('已选 6 张 · 分布于 1 页');
  });

  it('=50：yellow 色 + 「已选 50 张 · 已达选择上限 · 分布于 3 页」', () => {
    const c = computeSelectionCounter(50, 3);
    expect(c.tone).toBe('at-limit');
    expect(c.token).toBe('yellow');
    expect(c.text).toBe('已选 50 张 · 已达选择上限 · 分布于 3 页');
  });

  it('>50：error 色 + 「已选 51 张 · 超出上限 1 张 · 分布于 3 页」', () => {
    const c = computeSelectionCounter(51, 3);
    expect(c.tone).toBe('over-limit');
    expect(c.token).toBe('error');
    expect(c.text).toBe('已选 51 张 · 超出上限 1 张 · 分布于 3 页');
    expect(c.overflow).toBe(1);
  });

  /*
   * ⚠️ 选择上限 50 > 每页 20 格之后，「分布于 N 页」从锦上添花变成**必要信息** ——
   * 用户得知道还得再翻几页。这一条钉住"三档都带页数"：退回只在 ≤19 档显示即变红。
   */
  it('**三档都必须带「分布于 N 页」**（选满 50 必然跨页）', () => {
    for (const [n, pages] of [[6, 1], [50, 3], [51, 3]] as const) {
      expect(computeSelectionCounter(n, pages).text).toContain(`分布于 ${pages} 页`);
    }
  });

  it('**不使用 pink**：pink 是主强调色，用于超限会让「可点的」与「出错的」同色', () => {
    for (const n of [0, 49, 50, 51, 31]) {
      expect(computeSelectionCounter(n, 1).token).not.toBe('pink');
    }
  });

  it('49 → 50 → 51 逐档换色（这是分层拦截的可观测形态）', () => {
    expect(computeSelectionCounter(49, 1).token).toBe('ink-2');
    expect(computeSelectionCounter(50, 1).token).toBe('yellow');
    expect(computeSelectionCounter(51, 1).token).toBe('error');
  });
});

describe('《01》§5.1 分层拦截', () => {
  it('选择阶段是软的：第 51 张**仍然允许勾选**', async () => {
    const { canSelectMore } = await import('../src/selection/rules');
    expect(canSelectMore()).toBe(true);
  });

  it('提交阶段是硬的：51 张被拦截，且只给一个动作、不发网络请求', () => {
    const d = decideSubmit({ selectedCount: 51, comicNameOk: true });
    expect(d.kind).toBe('block');
    if (d.kind === 'block') {
      expect(d.reason).toBe('over-limit');
      expect(d.message).toBe('已超出选择上限 1 张');
      // 'batch'（分批提交）已按《01》§5.1 拍板从用户可选项里删掉 —— 切批是内部行为
      expect(d.actions.map((a) => a.id)).toEqual(['trim']);
    }
  });

  it('恰好 50 张放行（选择上限）；**并且 20 张也必须放行**（单批上限不是选择上限）', () => {
    expect(decideSubmit({ selectedCount: SELECT_LIMIT, comicNameOk: true }).kind).toBe('allow');
    expect(decideSubmit({ selectedCount: BATCH_LIMIT, comicNameOk: true }).kind).toBe('allow');
  });

  it('20–50 这一段是**正常区间**：直接提交，既不拦也不出现「分批」字样', () => {
    for (const n of [20, 21, 40, 50]) {
      const d = decideSubmit({ selectedCount: n, comicNameOk: true });
      expect(d.kind, `${n} 张应当放行`).toBe('allow');
    }
  });

  it('未选任何图 → 阻断', () => {
    expect(decideSubmit({ selectedCount: 0, comicNameOk: true }).kind).toBe('block');
  });

  it('漫画名未填 → 阻断（漫画名是任务的唯一标识）', () => {
    const d = decideSubmit({ selectedCount: 3, comicNameOk: false });
    expect(d.kind).toBe('block');
    if (d.kind === 'block') expect(d.reason).toBe('name-missing');
  });
});

describe('《01》§6.4 P0-1 回写前校验', () => {
  const expected = 'https://cdn.example.com/comic/003.png';

  it('连接在 + URL 一致 → 允许回写', () => {
    expect(canWriteBack({ isConnected: true, currentSrc: expected, expectedUrl: expected }).ok).toBe(true);
  });

  it('元素已离开 DOM → 拒绝，理由 left-dom', () => {
    const r = canWriteBack({ isConnected: false, currentSrc: expected, expectedUrl: expected });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('left-dom');
  });

  it('**`currentSrc` 变了 → 拒绝**，理由 src-mismatch（这是防译文串图的关键分支）', () => {
    const r = canWriteBack({
      isConnected: true,
      currentSrc: 'https://cdn.example.com/comic/014.png',
      expectedUrl: expected,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('src-mismatch');
  });

  it('currentSrc 为空（尚未加载）→ 拒绝，不猜', () => {
    expect(canWriteBack({ isConnected: true, currentSrc: '', expectedUrl: expected }).ok).toBe(false);
  });

  it('**同源下**相对路径与绝对路径视为同一张图（按页面 base 解析）', () => {
    const base = 'https://cdn.example.com/comic/ch01/';
    // 页面里写 src="/comic/003.png"，currentSrc 被补成绝对路径
    expect(sameImageUrl('/comic/003.png', 'https://cdn.example.com/comic/003.png', base)).toBe(
      true,
    );
    // 相对当前目录的写法
    expect(sameImageUrl('003.png', 'https://cdn.example.com/comic/ch01/003.png', base)).toBe(true);
  });

  it('**跨站不得判等** —— 从严，错杀优于串图', () => {
    // 无法得知基址时，相对 vs 绝对必须判不等
    expect(sameImageUrl('/comic/003.png', 'https://cdn.example.com/comic/003.png')).toBe(false);
    expect(sameImageUrl('https://evil.example.com/comic/003.png', 'https://cdn.example.com/comic/003.png')).toBe(false);
    // 反证：若按 pathname 宽松匹配，上面两条会被误判为相等 → P0-1 失效
    expect(sameImageUrl('https://a.example.com/1.png', 'https://b.example.com/1.png')).toBe(false);
  });

  it('空串永不判等（原 `a === b` 短路会让两个空串「相等」）', () => {
    expect(sameImageUrl('', '')).toBe(false);
    expect(sameImageUrl('https://a.com/1.png', '')).toBe(false);
  });

  it('查询串/片段不同 → 不等（防止站点换图后误判为同一张）', () => {
    expect(sameImageUrl('https://a.com/1.png?v=1', 'https://a.com/1.png?v=2')).toBe(false);
    expect(sameImageUrl('https://a.com/1.png', 'https://a.com/2.png')).toBe(false);
  });
});

describe('《01》§6.4 P0-2 清空判据（覆盖无限滚动）', () => {
  it('URL 变化 → 清空，理由 url-changed', () => {
    const r = shouldClearSelection({ urlChanged: true, selectedCount: 5, leftDomCount: 0 });
    expect(r).toEqual({ clear: true, reason: 'url-changed' });
  });

  it('**URL 不变但 >60% 已选图离开 DOM → 清空**（类型 ③ 的唯一通道）', () => {
    const r = shouldClearSelection({ urlChanged: false, selectedCount: 10, leftDomCount: 7 });
    expect(r.clear).toBe(true);
    expect(r.reason).toBe('left-dom');
  });

  it('恰好 60% 不清空（判据是「超过」60%，不是「达到」）', () => {
    expect(shouldClearSelection({ urlChanged: false, selectedCount: 10, leftDomCount: 6 }).clear).toBe(false);
  });

  it('无限滚动新增图片但已选图都还在 → 不清空（不能把用户刚勾的选择误清）', () => {
    expect(shouldClearSelection({ urlChanged: false, selectedCount: 8, leftDomCount: 0 }).clear).toBe(false);
  });

  it('没有任何已选 → 不清空', () => {
    expect(shouldClearSelection({ urlChanged: false, selectedCount: 0, leftDomCount: 0 }).clear).toBe(false);
  });

  it('阈值常量就是 0.6', () => {
    expect(LEAVE_DOM_CLEAR_THRESHOLD).toBe(0.6);
  });

  it('countLeftDom 统计离开 DOM 的已选图', () => {
    expect(countLeftDom([{ isConnected: true }, { isConnected: false }, { isConnected: false }])).toBe(2);
  });
});

describe('《01》§6.4 口径冲突裁定：翻译中切页不停任务', () => {
  it('切页只清空未提交的已选集，**绝不取消已提交任务**', () => {
    const plan = onRouteChangePlan({
      hasRunningTask: true,
      urlChanged: true,
      selectedCount: 12,
      leftDomCount: 12,
    });
    expect(plan.clearSelection).toBe(true);
    expect(plan.cancelTask).toBe(false);
  });

  it('条件不满足时两者都不触发', () => {
    const plan = onRouteChangePlan({
      hasRunningTask: true,
      urlChanged: false,
      selectedCount: 12,
      leftDomCount: 1,
    });
    expect(plan.clearSelection).toBe(false);
    expect(plan.cancelTask).toBe(false);
  });
});

describe('《01》§6.3 L4 状态点映射', () => {
  it('契约 item 级没有 partial，但设计稿 L4 预留了 warning 档', () => {
    // saved:false（落盘失败不阻断主路径）是 item 级唯一「成功但不完整」的情形
    expect(thumbStatusOf({ status: 'success', saved: false })).toBe('warning');
    expect(thumbStatusOf({ status: 'success', saved: true })).toBe('success');
  });

  it('其余状态一一对应；skipped 视为未开始（不显示状态点）', () => {
    expect(thumbStatusOf({ status: 'translating' })).toBe('translating');
    expect(thumbStatusOf({ status: 'failed' })).toBe('failed');
    expect(thumbStatusOf({ status: 'pending' })).toBe('pending');
    expect(thumbStatusOf({ status: 'skipped' })).toBe('idle');
    expect(thumbStatusOf(undefined)).toBe('idle');
  });
});

describe('《03》§4.3 客户端 8 态', () => {
  it('状态数就是 8 个，且「服务未就绪」不在其中', () => {
    expect(CLIENT_STATES).toHaveLength(8);
    expect(CLIENT_STATES as readonly string[]).not.toContain('service_unready');
  });

  it('服务端状态 → 客户端状态一一映射', () => {
    expect(clientStateFromTaskStatus('queued')).toBe('queued');
    expect(clientStateFromTaskStatus('running')).toBe('running');
    expect(clientStateFromTaskStatus('done')).toBe('done');
    expect(clientStateFromTaskStatus('partial_failed')).toBe('partial_failed');
    expect(clientStateFromTaskStatus('failed')).toBe('failed');
    expect(clientStateFromTaskStatus('canceled')).toBe('canceled');
  });

  it('终态 / 进行中的判定', () => {
    expect(isTerminal('done')).toBe(true);
    expect(isTerminal('canceled')).toBe(true);
    expect(isTerminal('running')).toBe(false);
    expect(isActive('queued')).toBe(true);
    expect(isActive('running')).toBe(true);
    expect(isActive('idle')).toBe(false);
  });
});

describe('《03》§4.4 + 《01》§7 逐态能力表', () => {
  it('queued：可继续勾选（只是「下一批」候选集），但不可改漫画名', () => {
    expect(CAPABILITIES.queued.select).toBe(true);
    expect(CAPABILITIES.queued.comicName).toBe(false);
  });

  it('queued 的「打开目录」置灰 —— 目录**惰性创建**，此时不存在', () => {
    expect(CAPABILITIES.queued.openDir).toBe(false);
    expect(CAPABILITIES.running.openDir).toBe(true);
  });

  /*
   * 导出只看「有没有选中/提交过的图」，不看「译没译完」——
   * 没译的页导出原图（服务端已落盘），`onExport` 会如实报「N 张尚无译文」。
   * 只有 submitting / running 落盘未完时禁用。
   */
  it('导出不要求「已翻译」：idle / done / failed 可用，submitting / running 禁用', () => {
    expect(CAPABILITIES.idle.export).toBe(true);
    expect(CAPABILITIES.done.export).toBe(true);
    expect(CAPABILITIES.failed.export).toBe(true);
    expect(CAPABILITIES.submitting.export).toBe(false);
    expect(CAPABILITIES.running.export).toBe(false);
  });

  it('running：不可改选、不可改漫画名，但可滚动与 hover 预览', () => {
    expect(CAPABILITIES.running.select).toBe(false);
    expect(CAPABILITIES.running.comicName).toBe(false);
    expect(CAPABILITIES.running.browse).toBe(true);
    expect(CAPABILITIES.running.hoverPreview).toBe(true);
  });

  it('单图「定位图片」在**任何**面板状态都可点（纯定位、不改数据）', () => {
    for (const s of CLIENT_STATES) {
      expect(CAPABILITIES[s].locateImage, `${s} 的定位图片应为可用`).toBe(true);
    }
  });

  it('「继续翻一批」只在终态可用', () => {
    expect(CAPABILITIES.idle.continueNextBatch).toBe(false);
    expect(CAPABILITIES.queued.continueNextBatch).toBe(false);
    expect(CAPABILITIES.done.continueNextBatch).toBe(true);
  });
});

describe('《03》§4.4 取消确认规则', () => {
  it('queued 一次确认，且文案不含「已翻译」', () => {
    const c = cancelConfirmCopy('queued', 0);
    expect(c?.times).toBe(1);
    expect(c?.description).not.toContain('已翻译的');
  });

  it('running **二次确认**，文案必须包含「已翻译的 N 张会保留」', () => {
    const c = cancelConfirmCopy('running', 7);
    expect(c?.times).toBe(2);
    expect(c?.description).toContain('已翻译的 7 张会保留');
  });

  it('终态不可取消', () => {
    expect(cancelConfirmCopy('done', 20)).toBeNull();
    expect(cancelConfirmCopy('idle', 0)).toBeNull();
  });
});

describe('《01》§7 / §7.1 文案规范', () => {
  it('提示行只在 queued / running 出现 24px 魔法阵（它俩是全局状态的常驻载体）', () => {
    expect(hintRowFor({ state: 'queued' }).magicCircle).toBe(true);
    expect(hintRowFor({ state: 'running' }).magicCircle).toBe(true);
    expect(hintRowFor({ state: 'idle' }).magicCircle).toBe(false);
    expect(hintRowFor({ state: 'done' }).magicCircle).toBe(false);
  });

  it('running 时魔法阵旋转、并带结构化计数（供 UI 拆两个文本节点）', () => {
    const h = hintRowFor({ state: 'running', done: 3, total: 20 });
    expect(h.spin).toBe(true);
    expect(h.count).toEqual({ numeric: '3 / 20', unit: ' 张' });
  });

  it('`N / M` 计数**拆两个文本节点**（数字 Inter Medium、中文 Noto Sans SC）', () => {
    const c = splitCount(18, 20);
    expect(c.numeric).toBe('18 / 20');
    expect(c.unit).toBe(' 张');
  });

  it('eta 只透传服务端字符串，客户端**不拼接数字**', () => {
    const h = hintRowFor({
      state: 'queued',
      queueText: '排队 · 第 2 位',
      etaText: '预计 2–4 分钟',
    });
    expect(h.text).toBe('排队 · 第 2 位 · 预计 2–4 分钟');
    expect(h.action).toBe('cancel-queue');
  });

  it('服务端没给 eta 时不编造数字', () => {
    const h = hintRowFor({ state: 'queued', queueText: '排队 · 第 2 位', etaText: null });
    expect(h.text).toBe('排队 · 第 2 位');
    expect(h.text).not.toMatch(/\d+\s*(分钟|秒)/);
  });

  it('回执：done 给「已保存到 漫画库 / X /」+ 打开目录', () => {
    const r = receiptFor({ state: 'done', comicName: '第12话 · 学园祭', done: 20, total: 20 });
    expect(r?.kind).toBe('success');
    expect(r?.comicName).toBe('第12话 · 学园祭');
    expect(r?.action?.id).toBe('open-dir');
  });

  it('回执：partial_failed 转 warning 且只重试失败项', () => {
    const r = receiptFor({ state: 'partial_failed', done: 18, total: 20, failed: 2 });
    expect(r?.kind).toBe('warning');
    expect(r?.title).toBe('18 / 20 · 2 张失败');
    expect(r?.action?.label).toBe('重试失败项');
  });

  it('回执：canceled 显示保留量（已落盘内容保留）', () => {
    const r = receiptFor({ state: 'canceled', keptItems: 7 });
    expect(r?.title).toBe('已取消 · 保留 7 张已翻译');
  });
});
