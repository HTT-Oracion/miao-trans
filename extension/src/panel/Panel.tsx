/**
 * 展开面板 —— 《01》§6.2 ~ §6.7 的几何与分区，逐值为准。
 *
 * ```
 * 面板头(56) → 漫画名行(52) → 提示行(48) → 工具条(44)
 *          → 网格区(395) → 本页提示行(24) → 分隔线(1) → 底栏(60)
 *          合计 680 × 360
 * ```
 *
 * 提示行是 48 而不是 100：原稿算成 100 会让网格区被高估 52px，
 * 第 16–20 张被推到底栏之外（本迭代统一为 48，七屏一致）。
 */

import { useSelector } from 'react-redux';
import type { Dispatch, UnknownAction } from '@reduxjs/toolkit';
import { Input } from 'antd';

import { GRID, MORE_MENU, PANEL } from '../theme/tokens';
import {
  capabilitiesOf,
  cancelConfirmCopy,
  ENGINE_PREPARING,
  preparingSubline,
  serviceOverlayFor,
  showsSlowFirstImageHint,
  SLOW_FIRST_IMAGE_HINT,
  type ClientState,
  type ServicePhase,
} from '../domain/clientState';
import { pagesWithSelection } from '../store/translation/selectionSlice';
import {
  selectBatch,
  selectComicNameCheck,
  selectCounter,
  selectHintRow,
  selectInlineHint,
  selectOutputPathPreview,
  selectReceipt,
  selectSubmitDecision,
  thumbStatusOfSeq,
  type RootState,
} from '../store/translation';
import { batchActions } from '../store/translation/batchSlice';
import { registry } from '../store/registry';
import { resolveLocateTarget } from '../content/writeback';
import { MagicCircle } from './MagicCircle';
import { ThumbCell } from './ThumbCell';
import { IconChevronLeft, IconChevronRight, IconClose, IconEdit, IconRefresh } from './icons';
import { usePanelController } from './controller';
import { logoUrl } from './assets';

export interface PanelProps {
  dispatch: Dispatch<UnknownAction>;
  serviceReady: boolean;
  /**
   * 服务就绪阶段（ver2.0）—— 浮层按「未就绪 / 准备中」两态分流（《01》§4.4 判据）。
   * 与 `serviceReady` 并存：`preparing` 时进程仍在（`serviceReady` 保持 true），
   * 但引擎未就绪，必须渲染「准备中」而非「服务已就绪」。
   */
  servicePhase: ServicePhase;
  /** 服务端 progress 换算的比例（仅用于悬浮球；面板内不出现该数字以外的派生值） */
  progressRatio: number;
  /** 收起面板为悬浮球（真源在 PanelRoot.Dock）—— 收起时球位按面板位置反算 */
  onCollapse: () => void;
  /**
   * 面板拖动（本轮新增：面板与悬浮球各自独立拖动）。
   * 把手是**面板头**：整面板拖动会与缩略图勾选 / 文本选择打架。
   */
  dragging: boolean;
  onHeaderPointerDown: (e: React.PointerEvent) => void;
  onHeaderPointerMove: (e: React.PointerEvent) => void;
  onHeaderPointerUp: (e: React.PointerEvent) => void;
}

export function Panel({
  dispatch,
  serviceReady,
  servicePhase,
  progressRatio,
  onCollapse,
  dragging,
  onHeaderPointerDown,
  onHeaderPointerMove,
  onHeaderPointerUp,
}: PanelProps) {
  const batch = useSelector(selectBatch);
  const counter = useSelector(selectCounter);
  const inlineHint = useSelector(selectInlineHint);
  const decision = useSelector(selectSubmitDecision);
  const hint = useSelector(selectHintRow);
  const receipt = useSelector(selectReceipt);
  const pathPreview = useSelector(selectOutputPathPreview);
  const nameCheck = useSelector(selectComicNameCheck);
  const items = useSelector((s: RootState) => s.item.bySeq);
  const selectedKeys = useSelector((s: RootState) => s.selection.selectedKeys);
  const pagesWithSel = useSelector((s: RootState) => pagesWithSelection(s.selection));
  const failedSeqs = useSelector((s: RootState) => s.batch.failedSeqs);
  const lastEventId = useSelector((s: RootState) => s.batch.lastEventId);
  const eventsConnected = useSelector((s: RootState) => s.batch.eventsConnected);

  const ctl = usePanelController(dispatch, {
    selectedKeys,
    failedSeqs,
    clientState: batch.state,
    lastEventId,
    eventsConnected,
    comicName: batch.comicName,
  });
  const caps = capabilitiesOf(batch.state);
  const state: ClientState = batch.state;

  /** 两态浮层文案：`ready` → null（无浮层）；`absent` → 服务未就绪；`preparing` → 引擎准备中 */
  const overlayCopy = serviceOverlayFor(servicePhase);
  const preparing = servicePhase === 'preparing';
  /** 准备中浮层的**阶段副行**（《01》§4.1）——取不到阶段时为 null（不猜） */
  const preparingSub = preparingSubline(batch.enginePreparingState);
  /**
   * 《01》§4.2 / 《04》§5.3：「首张稍慢，后续加快」只在 `running` 且**当前正在处理第 1 张**
   * 时出现（判据取服务端 `progress.current === 1`），第 2 张起消失。
   */
  const showSlowFirst = showsSlowFirstImageHint({ state: batch.state, current: batch.progress?.current });
  /** 面板头徽标三值 —— 进程维度（已就绪 / 未就绪）与引擎维度（准备中）分开表达 */
  const serviceBadge = preparing ? '引擎准备中' : serviceReady ? '服务已就绪' : '服务未就绪';
  const serviceBadgeKind = preparing ? 'preparing' : serviceReady ? 'ok' : 'down';

  const selecting = state === 'idle';
  const showSelectionToolbar = selecting;
  const cancelCopy = cancelConfirmCopy(state, batch.progress?.done ?? 0);

  return (
    <div
      className={['mt-panel', dragging ? 'mt-panel--dragging' : ''].filter(Boolean).join(' ')}
      style={{ width: PANEL.width, height: PANEL.height, borderRadius: PANEL.radius }}
      data-testid="miao-panel"
      data-state={state}
    >
      {/* ── 面板头 56（同时是拖动把手 —— 抓手见 .mt-panel__header 的 cursor） ── */}
      <header
        className="mt-panel__header"
        style={{ height: PANEL.header }}
        data-testid="panel-header"
        onPointerDown={onHeaderPointerDown}
        onPointerMove={onHeaderPointerMove}
        onPointerUp={onHeaderPointerUp}
      >
        <img className="mt-panel__logo" src={logoUrl(28)} alt="" width={28} height={28} />
        <div className="mt-panel__titles">
          <strong className="mt-panel__title">喵译</strong>
          <span className="mt-panel__subtitle">漫画就地翻译</span>
        </div>
        <span className={`mt-panel__service mt-panel__service--${serviceBadgeKind}`}>
          {serviceBadge}
        </span>
        <button type="button" className="mt-iconbtn" aria-label="收起面板" onClick={onCollapse}>
          <IconClose size={14} />
        </button>
      </header>

      {/* ── 顶部进度条（《03》§4.3：running 态「顶部进度条 + 单图遮罩」） ── */}
      {(state === 'running' || state === 'submitting') && (
        <div className="mt-progressbar" data-testid="top-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100}>
          <span className="mt-progressbar__fill" style={{ width: `${Math.round(progressRatio * 100)}%` }} />
        </div>
      )}

      {/*
        ── 「首张稍慢，后续加快」（《01》§4.2 / 《04》§5.3 / 《09》L4）──
        仅 `running` 且当前为第 1 张时出现，第 2 张起消失；属**预期行为**，
        用常规辅助文案色（不得做成错误 / 警告样式）。
        面板几何钉死 680（七屏一致），而网格区是**唯一可收缩分区**（一收缩就会
        裁掉第 4 行缩略图并出现滚动条），因此这一行不参与流式布局，浮在网格区
        顶部内边距上 —— 不挤压任何分区，实现「全局进度条下方一行辅助文案」。
      */}
      {showSlowFirst && (
        <div
          className="mt-slowfirst"
          data-testid="slow-first-hint"
          style={{ top: PANEL.header + 2 + PANEL.nameRow + PANEL.hintRow + PANEL.toolbar }}
        >
          {SLOW_FIRST_IMAGE_HINT}
        </div>
      )}

      {/* ── 漫画名行 52 ── */}
      <section className="mt-panel__namerow" style={{ height: PANEL.nameRow }}>
        <label className="mt-fieldlabel" htmlFor="mt-comic-name">
          漫画名<span className="mt-required">*</span>
        </label>
        <div className="mt-fieldwrap">
          <Input
            id="mt-comic-name"
            size="small"
            className={[
              'mt-input',
              nameCheck.ok ? '' : 'mt-input--invalid',
              selecting ? '' : 'mt-input--readonly',
            ]
              .filter(Boolean)
              .join(' ')}
            value={batch.comicName}
            readOnly={!caps.comicName}
            placeholder="例：第12话 · 学园祭"
            status={nameCheck.ok ? undefined : 'error'}
            onChange={(e) => dispatch(batchActions.comicNameChanged(e.target.value))}
            suffix={caps.comicName ? undefined : <IconEdit size={16} />}
          />
          <div className="mt-pathpreview" title={pathPreview}>
            → {pathPreview}
          </div>
          {!nameCheck.ok && nameCheck.message && <div className="mt-inlineerror">{nameCheck.message}</div>}
        </div>
      </section>

      {/* ── 提示行 48 ── */}
      <section className="mt-panel__hintrow" style={{ height: PANEL.hintRow }} data-testid="hint-row">
        {/* 《01》§4.1：准备中态的提示行左侧同样用 24px 小魔法阵（沿 ver1.0 全局状态标识） */}
        {(hint.magicCircle || preparing) && (
          <MagicCircle size={24} spin={hint.spin} />
        )}
        <div className="mt-hinttext">
          {hint.count ? (
            <>
              {/* 《01》§7.1：「N / M」拆两个文本节点，避免 Inter 无中文字形导致字重跳变 */}
              <span className="mt-num">{hint.count.numeric}</span>
              <span className="mt-cjk">{hint.count.unit}</span>
            </>
          ) : (
            <span
              className="mt-cjk"
              data-testid={preparing ? 'engine-preparing-hint' : undefined}
            >
              {/* 《01》§4.1：准备中态提示行文案「正在准备翻译引擎…」（逐字，不得改写） */}
              {hint.text || (preparing ? ENGINE_PREPARING.title : '') || (ctl.notice ?? '')}
            </span>
          )}
        </div>
        {hint.action && cancelCopy && (
          <button
            type="button"
            className="mt-linkbtn"
            data-testid="cancel-action"
            onClick={() => {
              // 确认规则（《03》§4.4）：queued 一次确认；running 二次确认
              if (cancelCopy.times === 1) void ctl.onConfirmCancel();
              else ctl.setCancelOpen(true);
            }}
          >
            {hint.action === 'cancel-queue' ? '取消排队' : '取消翻译'}
          </button>
        )}
      </section>

      {/* ── 工具条 44 ── */}
      <section className="mt-panel__toolbar" style={{ height: PANEL.toolbar }}>
        {showSelectionToolbar ? (
          <>
            <button
              type="button"
              className="mt-checkbox-line"
              onClick={() => ctl.onSelectAllPage()}
              aria-label="全选本页"
            >
              <span className="mt-checkbox-line__box" />
              <span className="mt-cjk">全选本页</span>
            </button>
            <span className={`mt-count mt-count--${counter.tone}`} data-testid="selection-counter">
              {counter.text}
            </span>
            <div className="mt-toolbar__actions">
              {inlineHint && <span className="mt-inlinehint">{inlineHint}</span>}
              <button type="button" className="mt-iconbtn" aria-label="重新扫描本页图片" onClick={() => void ctl.onRescan()}>
                <IconRefresh size={16} />
              </button>
              <button type="button" className="mt-iconbtn" aria-label="清除已选" onClick={() => ctl.onClearSelection()}>
                <IconClose size={14} />
              </button>
            </div>
          </>
        ) : (
          <>
            {/* 完成态工具条整条替换，**去掉全选与清除**（《01》§6.6 / P1-07） */}
            <span className="mt-summary" data-testid="toolbar-summary">
              {receipt ? receipt.title : '任务进行中'}
            </span>
            <div className="mt-toolbar__actions">
              <button
                type="button"
                className="mt-primarybtn mt-primarybtn--sm"
                disabled={!caps.openDir}
                onClick={() => void ctl.onRevealDir()}
              >
                打开目录
              </button>
            </div>
          </>
        )}
      </section>

      {/* ── 网格区 395（内边距 16 → 可用 328×363） ── */}
      <section className="mt-panel__grid" style={{ height: PANEL.grid }} data-testid="thumb-grid">
        <div
          className="mt-grid"
          style={{
            gridTemplateColumns: `repeat(${GRID.cols}, ${GRID.cellW}px)`,
            gridAutoRows: `${GRID.cellH}px`,
            gap: GRID.gap,
          }}
        >
          {ctl.pageImages.map((img, i) => {
            const seq = (ctl.page - 1) * GRID.perPage + i + 1;
            return (
              <ThumbCell
                key={img.key}
                seq={seq}
                previewUrl={img.fetchUrl}
                selected={selectedKeys.includes(img.key)}
                page={registryPage(img.key)}
                status={thumbStatusOfSeq(items, seq)}
                selectable={caps.select}
                locateAvailable={!!registryElementConnected(img.key)}
                onToggle={() => ctl.onToggleSelect(img.key)}
                onExpand={() => ctl.setPreviewKey(img.key)}
                onLocate={() => ctl.onLocate(img.key)}
                menuOpen={ctl.menuKey === img.key}
                onRequestMenuOpen={() => ctl.setMenuKey(img.key)}
                onRequestMenuClose={() => ctl.setMenuKey(null)}
              />
            );
          })}
          {ctl.pageImages.length === 0 && (
            <div className="mt-empty">
              <MagicCircle size={48} />
              <span className="mt-cjk">本页未扫描到漫画图片</span>
            </div>
          )}
        </div>
      </section>

      {/* ── 本页提示行 24 ── */}
      <div className="mt-panel__pagehint" style={{ height: PANEL.pageHint }}>
        <span className="mt-cjk">
          本页 {ctl.pageImages.length} 张 · 全页共 {ctl.allImages.length} 张
        </span>
        {ctl.notice && <span className="mt-pagehint__notice">{ctl.notice}</span>}
      </div>

      {/* ── 分隔线 1 ── */}
      <div className="mt-panel__divider" style={{ height: PANEL.divider }} />

      {/* ── 底栏 60 ── */}
      <footer className="mt-panel__footer" style={{ height: PANEL.footer }}>
        <div className="mt-pager">
          <button
            type="button"
            className="mt-iconbtn"
            aria-label="上一页"
            disabled={ctl.page <= 1}
            onClick={() => ctl.setPage(Math.max(1, ctl.page - 1))}
          >
            <IconChevronLeft size={16} />
          </button>
          <span className="mt-pager__label">
            <span className="mt-num">{ctl.page}</span>
            <span className="mt-cjk"> / </span>
            <span className="mt-num">{ctl.totalPages}</span>
          </span>
          <button
            type="button"
            className="mt-iconbtn"
            aria-label="下一页"
            disabled={ctl.page >= ctl.totalPages}
            onClick={() => ctl.setPage(Math.min(ctl.totalPages, ctl.page + 1))}
          >
            <IconChevronRight size={16} />
          </button>
          {/* 分页器每页右上 8×8 粉点：标识该页有已选项（《01》§6.4） */}
          <div className="mt-pager__dots" aria-hidden="true">
            {Array.from({ length: ctl.totalPages }).map((_, i) => (
              <span key={i} className={pagesWithSel.has(i + 1) ? 'mt-dot mt-dot--on' : 'mt-dot'} />
            ))}
          </div>
        </div>

        <div className="mt-footer__actions">
          <button
            type="button"
            className="mt-ghostbtn"
            data-testid="export-button"
            disabled={!caps.export || ctl.exporting}
            onClick={() => void ctl.onExport()}
          >
            {ctl.exporting ? '导出中…' : '导出'}
          </button>

          {selecting || state === 'submitting' ? (
            <>
              <button type="button" className="mt-ghostbtn" onClick={onCollapse}>
                取消
              </button>
              <button
                type="button"
                className="mt-primarybtn"
                data-testid="submit-button"
                /**
                 * disabled 口径（《01》§5.1）：empty / name-missing 直接锁死（没有可做的
                 * 动作）；**over-limit 不锁** —— 硬拦的定义是「拦截网络请求 + 给出两个
                 * 动作」，把按钮 disabled 会让裁剪/分批弹层永远不可达（e2e 实测发现的
                 * 缺陷）。点击由 onSubmit 转为打开超限弹层，同样不发任何请求。
                 */
                disabled={ctl.busy || (decision.kind === 'block' && decision.reason !== 'over-limit')}
                onClick={() => void ctl.onSubmit()}
              >
                {state === 'submitting' ? '提交中…' : decision.kind === 'block' && decision.reason === 'over-limit' ? '超出上限' : '确定'}
              </button>
            </>
          ) : (
            <button
              type="button"
              className="mt-primarybtn"
              disabled={!caps.continueNextBatch}
              onClick={() => ctl.onContinueNextBatch()}
            >
              继续翻一批
            </button>
          )}
        </div>
      </footer>

      {/* ── 浮层：服务未就绪 / 引擎准备中（两态，不得混用 ——《01》§4.4 判据） ── */}
      {overlayCopy && (
        <div
          className="mt-overlay"
          data-testid={preparing ? 'engine-preparing' : 'service-not-ready'}
          data-phase={overlayCopy.phase}
        >
          <div className="mt-overlay__card">
            <img src={logoUrl(20)} alt="" width={20} height={20} />
            <h4>{overlayCopy.title}</h4>
            {/*
              「准备中」的副行必须按**引擎阶段**走（《01》§4.1：「副行按阶段显示
              『正在准备翻译模型』/『正在预热』」）；取不到阶段就不渲染副行，**不猜**。
            */}
            {preparing ? (
              preparingSub && (
                <p className="mt-overlay__hint" data-testid="engine-preparing-subline">
                  {preparingSub}
                </p>
              )
            ) : (
              <p className="mt-overlay__hint">
                请在 Box 中启动本地翻译服务后重试。首版不支持协议唤起，需要你手动打开 Box。
              </p>
            )}
            <div className="mt-overlay__actions">
              {/*
                按钮名取 `actionLabel` 而非 `primary`：未就绪态的规格名为「启动 Box」，
                但首版不实现 box:// 唤起（P2-03，见 SERVICE_NOT_READY.specConflict），
                故实际渲染为「重试连接」；准备中态则只有「重试」（§4.4：无「启动 Box」）。
              */}
              <button type="button" className="mt-primarybtn" onClick={() => void ctl.onRetryService()}>
                {overlayCopy.actionLabel}
              </button>
              {/* 配对令牌是「进程在但令牌无效」的补救入口；准备中态进程已在，此入口不适用 */}
              {overlayCopy.phase === 'absent' && (
                <button type="button" className="mt-ghostbtn" onClick={() => ctl.setTokenDialogOpen(true)}>
                  配对令牌
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ── 浮层：令牌配对 ── */}
      {ctl.tokenDialogOpen && (
        <div className="mt-overlay">
          <div className="mt-overlay__card">
            <h4>配对令牌</h4>
            <p className="mt-overlay__hint">Box 设置 → 本地服务 → 显示令牌，粘贴到这里。</p>
            <Input.Password
              size="small"
              value={ctl.tokenInput}
              placeholder="64 位十六进制令牌"
              onChange={(e) => ctl.setTokenInput(e.target.value)}
            />
            <div className="mt-overlay__actions">
              <button type="button" className="mt-primarybtn" onClick={() => void ctl.onSaveToken()}>
                保存
              </button>
              <button type="button" className="mt-ghostbtn" onClick={() => ctl.setTokenDialogOpen(false)}>
                稍后
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 浮层：超限拦截（两个动作，不发网络请求） ── */}
      {ctl.overLimitOpen && decision.kind === 'block' && decision.reason === 'over-limit' && (
        <div className="mt-overlay" data-testid="over-limit-dialog">
          <div className="mt-overlay__card">
            <h4>{decision.message}</h4>
            <p className="mt-overlay__hint">
              最多可选 50 张。提交后服务端按每批 20 张自动排队、序号连续 —— 不需要你分批。
            </p>
            <div className="mt-overlay__actions mt-overlay__actions--stack">
              {decision.actions.map((a) => (
                <button
                  key={a.id}
                  type="button"
                  className="mt-ghostbtn"
                  onClick={() => void ctl.onOverLimitAction(a.id)}
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ── 浮层：取消确认（running 时文案必须含「已翻译的 N 张会保留」） ── */}
      {ctl.cancelOpen && cancelCopy && (
        <div className="mt-overlay" data-testid="cancel-dialog">
          <div className="mt-overlay__card">
            <h4>{cancelCopy.title}</h4>
            <p className="mt-overlay__hint">{cancelCopy.description.replace(/\*\*/g, '')}</p>
            <div className="mt-overlay__actions">
              <button type="button" className="mt-primarybtn" onClick={() => void ctl.onConfirmCancel()}>
                {cancelCopy.confirmText}
              </button>
              <button type="button" className="mt-ghostbtn" onClick={() => ctl.setCancelOpen(false)}>
                继续翻译
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── 浮层：放大预览（四角展开按钮的落点） ── */}
      {ctl.previewKey && (
        <div className="mt-overlay mt-overlay--dim" onClick={() => ctl.setPreviewKey(null)}>
          <div className="mt-lightbox" onClick={(e) => e.stopPropagation()}>
            <img src={previewUrlOf(ctl.previewKey) ?? ''} alt="放大预览" />
            <button type="button" className="mt-iconbtn mt-lightbox__close" aria-label="关闭预览" onClick={() => ctl.setPreviewKey(null)}>
              <IconClose size={14} />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────── 小组件辅助 ───────────────────────────

/** 菜单几何常量在 ThumbCell 内使用；此处仅导出供测试引用，避免误删 */
export const MENU_GEOMETRY = MORE_MENU;

/** 缩略图归属的面板页码（注册表是页码的唯一来源） */
function registryPage(key: string): number {
  return registry.pageOfKey(key);
}

/**
 * 「定位图片」可用性的判据 —— 与 `onLocate` **必须同一套**，否则会出现
 * 「按钮可点但点下去说已离开」或「明明能定位却置灰」。
 *
 * 因此这里复用 `resolveLocateTarget` 的两级兜底：元素引用失效时，
 * 按 `expectedUrl` 重新找一次，找得到就仍可点。
 */
function registryElementConnected(key: string): boolean {
  return resolveLocateTarget(registry.elementOf(key), registry.get(key)?.expectedUrl) !== null;
}

/** 放大预览的图片地址 */
function previewUrlOf(key: string): string | null {
  return registry.get(key)?.fetchUrl ?? null;
}
