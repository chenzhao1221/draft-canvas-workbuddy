import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from 'react';
import type { DraftComment, DraftSessionController, DraftState, HostAdapter, SelectionRange, SessionSnapshot } from '@draft-canvas/core';
import { NoticeList, StatusBanners, parseDismissedBanners, type DismissibleBanner } from './Banners';
import { DraftEditor } from './DraftEditor';
import { I18nContext, createI18n, parseLocale, resolveLocale, useI18n, type Locale, type MessageKey } from './i18n';
import { PanelIcon } from './icons';
import { MergeCompare } from './MergeCompare';
import { ReviewView } from './ReviewView';
import { CommentPopover } from './CommentPopover';
import { StagingBar } from './StagingBar';
import { bannerStyle, styles } from './styles';
import {
  EDITOR_FONTS,
  MAX_FONT_SIZE,
  MIN_FONT_SIZE,
  clampFontSize,
  parseTextStyle,
  textStyleVariables,
  type TextStyle,
} from './textStyle';
import { useDraftSession } from './useDraftSession';

/** Props of the panel (ADAPTER_INTERFACE section 14.1). */
export interface DraftCanvasPanelProps {
  adapter: HostAdapter;
  /** false while the panel is hidden; undefined counts as visible. */
  active?: boolean;
  /**
   * Text for the "how to open this panel" hint on hosts without `canAutoOpenPanel`. Pass a map to give one
   * text per language; the panel shows the one for the language in use.
   */
  openHint?: string | Partial<Record<Locale, string>>;
  /**
   * Optional CSS custom properties applied to the panel root, for example `{ '--dc-accent': '#7c3aed' }`.
   * See `styles.ts` for the names. The UI package does not read any host theme API.
   */
  cssVariables?: Record<string, string>;
  /**
   * Language the host reports, as a BCP 47 tag, for example `zh-CN`. It ranks below the user's own choice
   * (`storedLocale` and the header toggle) and above the browser language. See `resolveLocale` in `i18n.ts`.
   */
  locale?: string;
  /** The language the user chose earlier with the header toggle; read once, when the panel mounts. */
  storedLocale?: string | null;
  /** Called when the user picks a language with the header toggle, so the host can persist it. */
  onLocaleChange?: (locale: Locale) => void;
  /** The text size and font the user chose earlier (JSON from `serializeTextStyle`); read once, on mount. */
  storedTextStyle?: string | null;
  /** Called when the user changes the text size or font, so the host can persist it. */
  onTextStyleChange?: (style: TextStyle) => void;
  /**
   * `false` when the host knows new replies will not reach the panel (for Kiro Crew: the chat events
   * permission is not granted). The panel then shows a warning. `undefined` counts as true.
   */
  liveUpdates?: boolean;
  /** Re-read the current chat this often while visible, in ms (safety net for lost pushes). Off when absent. */
  refreshIntervalMs?: number;
  /** Banners the user closed earlier (JSON array from `onDismissedBannersChange`); read once, on mount. */
  storedDismissedBanners?: string | null;
  /** Called with the JSON array of closed banners, so the host can persist it. */
  onDismissedBannersChange?: (json: string) => void;
  /** Returns the host's diagnostic log; when given, the header shows a "Diagnostics" button. */
  diagnostics?: () => string;
  /**
   * Extra buttons the host puts at the right end of the header, before the settings gear (for example
   * collapse and fullscreen in the WorkBuddy widget). Use `iconButtonStyle` and `PanelIcon` to match.
   */
  headerActions?: ReactNode;
}

/** What the user is looking at for one draft. Not part of the session, so it lives in the panel. */
interface DraftView {
  /** Version shown read-only; null follows the latest version. */
  version: number | null;
  compare: { a: number; b: number } | null;
  showChanges: boolean;
  previewHidden: boolean;
}

const DEFAULT_VIEW: DraftView = { version: null, compare: null, showChanges: false, previewHidden: false };

const STATUS_KEY: Record<DraftState['status'], MessageKey | null> = {
  clean: null,
  dirty: 'status.dirty',
  staged: 'status.staged',
  'staged-stale': 'status.staged-stale',
  sent: 'status.sent',
  'stale-base': 'status.stale-base',
};

const STALE_KEY: Record<NonNullable<DraftState['staleReason']>, MessageKey> = {
  base_missing: 'stale.base_missing',
  base_changed: 'stale.base_changed',
  newer_version: 'stale.newer_version',
};

/** Badge colour per status: edits not yet sent stand out, sent ones stay neutral. */
const STATUS_TONE: Partial<Record<DraftState['status'], CSSProperties>> = {
  dirty: styles.badgeWarning,
  'staged-stale': styles.badgeWarning,
  'stale-base': styles.badgeDanger,
};

function sameRange(a: SelectionRange | null, b: SelectionRange | null): boolean {
  if (a === null || b === null) return a === b;
  return (
    a.startLine === b.startLine &&
    a.startOffset === b.startOffset &&
    a.endLine === b.endLine &&
    a.endOffset === b.endOffset
  );
}

function draftLabel(draft: DraftState): string {
  return draft.title !== undefined && draft.title !== '' ? draft.title : draft.draftId;
}

/** Language names are written in their own language so they stay readable in either table. */
const LANGUAGE_CHOICES: ReadonlyArray<{ locale: Locale; label: string; lang: string }> = [
  { locale: 'en', label: 'English', lang: 'en' },
  { locale: 'zh-CN', label: '中文', lang: 'zh-CN' },
];

/** Two-button language switch at the top of the panel. */
function LanguageToggle({ current, onChoose }: { current: Locale; onChoose: (locale: Locale) => void }): ReactElement {
  const { t } = useI18n();
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }} role="group" aria-label={t('lang.label')} data-testid="language-toggle">
      {LANGUAGE_CHOICES.map((choice) => (
        <button
          key={choice.locale}
          type="button"
          lang={choice.lang}
          style={{ ...styles.chip, ...(current === choice.locale ? styles.chipSelected : {}) }}
          aria-pressed={current === choice.locale}
          onClick={() => onChoose(choice.locale)}
        >
          {choice.label}
        </button>
      ))}
    </div>
  );
}

/** A− / size / A+ and a font menu for the draft text. */
function TextStyleControls({ value, onChange }: { value: TextStyle; onChange: (next: TextStyle) => void }): ReactElement {
  const { t } = useI18n();
  const atMin = value.size <= MIN_FONT_SIZE;
  const atMax = value.size >= MAX_FONT_SIZE;
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 4 }} role="group" aria-label={t('text.label')} data-testid="text-style">
      <button
        type="button"
        style={{ ...styles.buttonSmall, ...(atMin ? styles.buttonDisabled : {}) }}
        disabled={atMin}
        aria-label={t('text.smaller')}
        title={t('text.smaller')}
        onClick={() => onChange({ ...value, size: clampFontSize(value.size - 1) })}
      >
        A−
      </button>
      <span style={styles.muted} data-testid="text-size">
        {t('text.size', { n: value.size })}
      </span>
      <button
        type="button"
        style={{ ...styles.buttonSmall, ...(atMax ? styles.buttonDisabled : {}) }}
        disabled={atMax}
        aria-label={t('text.larger')}
        title={t('text.larger')}
        onClick={() => onChange({ ...value, size: clampFontSize(value.size + 1) })}
      >
        A+
      </button>
      <select
        style={styles.select}
        aria-label={t('text.font')}
        data-testid="text-font"
        value={value.font}
        onChange={(e) => {
          const font = EDITOR_FONTS.find((f) => f === e.target.value);
          if (font !== undefined) onChange({ ...value, font });
        }}
      >
        {EDITOR_FONTS.map((font) => (
          <option key={font} value={font}>
            {t(`font.${font}`)}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * The gear at the right end of the header. Text size, font, language and diagnostics are set once and
 * rarely touched, so they live in this menu instead of taking a row of their own above the draft.
 */
function SettingsMenu({ children }: { children: ReactNode }): ReactElement {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const box = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (!open) return undefined;
    const onPointer = (event: MouseEvent): void => {
      if (box.current !== null && event.target instanceof Node && !box.current.contains(event.target)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);
  return (
    <div ref={box} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        type="button"
        style={{ ...styles.iconButton, ...(open ? { color: 'var(--dc-accent, #4567AA)' } : {}) }}
        aria-label={t('settings.button')}
        title={t('settings.button')}
        aria-haspopup="true"
        aria-expanded={open}
        data-testid="settings-button"
        onClick={() => setOpen((value) => !value)}
      >
        <PanelIcon name="settings" />
      </button>
      {open ? (
        <div style={styles.menu} role="group" aria-label={t('settings.button')} data-testid="settings-menu">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function EmptyState({ openHint, phase }: { openHint: string | undefined; phase: SessionSnapshot['phase'] }): ReactElement {
  const { t } = useI18n();
  return (
    <div style={{ ...styles.box, ...styles.muted }} data-testid="empty-state">
      <div style={styles.title}>{phase === 'ready' ? t('empty.noDrafts') : t('empty.waiting')}</div>
      <div>{t('empty.ask')}</div>
      <div>{t('empty.skill')}</div>
      {openHint !== undefined && openHint !== '' ? <div>{openHint}</div> : null}
    </div>
  );
}

interface DraftBodyProps {
  controller: DraftSessionController;
  snapshot: SessionSnapshot;
  draft: DraftState;
  view: DraftView;
  setView: (patch: Partial<DraftView>) => void;
  selection: SelectionRange | null;
  onSelectionChange: (range: SelectionRange | null) => void;
  comments: readonly DraftComment[];
  onAddComment: (comment: DraftComment) => void;
  onRemoveComment: (index: number) => void;
  onSent: () => void;
  /** Host buttons and the settings gear, shown at the right end of the header. */
  toolbar: ReactNode;
}

/** Header, pager and the main area (editor, preview, compare or review) of the selected draft. */
function DraftBody({
  controller,
  snapshot,
  draft,
  view,
  setView,
  selection,
  onSelectionChange,
  comments,
  onAddComment,
  onRemoveComment,
  onSent,
  toolbar,
}: DraftBodyProps): ReactElement {
  const { t } = useI18n();
  // Bumped after a comment is added, so the editor drops the selection and the comment box closes.
  const [clearSelectionSignal, setClearSelectionSignal] = useState(0);
  const addComment = useCallback(
    (comment: DraftComment) => {
      onAddComment(comment);
      setClearSelectionSignal((n) => n + 1);
    },
    [onAddComment],
  );
  /**
   * The comment box opens when the user *finishes* selecting, not while they drag: a timer opened it
   * mid-drag whenever the pointer paused, and each mount took height from the editor and made the
   * selection jump. `onSelectionCommit` fires on mouse up / shift+arrow / touch end.
   */
  const [settledSelection, setSettledSelection] = useState<SelectionRange | null>(null);
  useEffect(() => {
    if (selection === null) setSettledSelection(null);
  }, [selection]);

  const total = draft.versions.length;
  const latest = draft.versions[total - 1];
  const shownN = view.version ?? total;
  const olderShown = total > 0 && shownN < total;
  const previewVisible = draft.preview !== undefined && snapshot.active && !view.previewHidden;
  const statusKey = STATUS_KEY[draft.status];
  const statusLabel = statusKey === null ? null : t(statusKey);
  const working = draft.workingCopy;

  const onEdit = useCallback(
    (text: string) => {
      controller.edit(draft.draftId, text);
    },
    [controller, draft.draftId],
  );

  const goto = (n: number): void => setView({ version: n >= total ? null : Math.max(1, n), compare: null, showChanges: false });
  const compare = view.compare;
  const compareA = compare !== null ? draft.versions[compare.a - 1] : undefined;
  const compareB = compare !== null ? draft.versions[compare.b - 1] : undefined;

  const header = (
    <div style={styles.row}>
      <span style={styles.title}>{draftLabel(draft)}</span>
      {total > 0 ? (
        <>
          <button
            type="button"
            style={{ ...styles.arrowButton, ...(shownN <= 1 ? styles.buttonDisabled : {}) }}
            disabled={shownN <= 1}
            aria-label={t('version.prev')}
            onClick={() => goto(shownN - 1)}
          >
            ‹
          </button>
          <span data-testid="version-label">{t('version.label', { n: shownN, total })}</span>
          <button
            type="button"
            style={{ ...styles.arrowButton, ...(!olderShown ? styles.buttonDisabled : {}) }}
            disabled={!olderShown}
            aria-label={t('version.next')}
            onClick={() => goto(shownN + 1)}
          >
            ›
          </button>
          {olderShown ? (
            <button type="button" style={styles.buttonSmall} onClick={() => goto(total)}>
              {t('version.latest')}
            </button>
          ) : null}
          {total >= 2 ? (
            <button
              type="button"
              style={styles.buttonSmall}
              aria-pressed={compare !== null}
              onClick={() =>
                setView({
                  compare: compare !== null ? null : { a: Math.max(1, total - 1), b: total },
                  showChanges: false,
                })
              }
            >
              {compare !== null ? t('compare.close') : t('compare.open')}
            </button>
          ) : null}
        </>
      ) : null}
      <span style={styles.spacer} />
      {draft.preview !== undefined && snapshot.active ? (
        <span style={{ ...styles.badge, ...styles.badgeStreaming }} data-testid="streaming-badge">
          {draft.preview.closed ? t('badge.received') : t('badge.streaming')}
        </span>
      ) : null}
      {statusLabel !== null ? (
        <span style={{ ...styles.badge, ...(STATUS_TONE[draft.status] ?? {}) }} data-testid="status-badge">
          {draft.status === 'dirty' || draft.status === 'staged-stale' ? (
            <span aria-hidden="true" style={{ width: 6, height: 6, borderRadius: 3, background: 'currentColor' }} />
          ) : null}
          {statusLabel}
        </span>
      ) : null}
      {toolbar}
    </div>
  );

  const compareControls =
    compare !== null ? (
      <div style={styles.row}>
        <label style={styles.muted}>
          {t('compare.from')}{' '}
          <select
            style={styles.select}
            value={compare.a}
            onChange={(e) => setView({ compare: { a: Number(e.target.value), b: compare.b } })}
          >
            {draft.versions.map((v) => (
              <option key={v.n} value={v.n}>
                v{v.n}
              </option>
            ))}
          </select>
        </label>
        <label style={styles.muted}>
          {t('compare.to')}{' '}
          <select
            style={styles.select}
            value={compare.b}
            onChange={(e) => setView({ compare: { a: compare.a, b: Number(e.target.value) } })}
          >
            {draft.versions.map((v) => (
              <option key={v.n} value={v.n}>
                v{v.n}
              </option>
            ))}
          </select>
        </label>
      </div>
    ) : null;

  const staleBanner =
    draft.status === 'stale-base' && draft.staleReason !== undefined ? (
      <div style={bannerStyle('warning')} role="alert">
        <span style={styles.spacer}>{t(STALE_KEY[draft.staleReason])}</span>
        <button type="button" style={styles.buttonSmall} onClick={() => controller.openReview(draft.draftId)}>
          {t('stale.reviewLatest')}
        </button>
        <button type="button" style={styles.buttonSmall} onClick={() => controller.discardChanges(draft.draftId)}>
          {t('stale.discard')}
        </button>
      </div>
    ) : null;

  let main: ReactElement;
  let canRewrite = false;
  if (draft.review !== undefined) {
    const review = draft.review;
    main = (
      <ReviewView
        review={review}
        onDecision={(i, d) => controller.setReviewDecision(draft.draftId, i, d)}
        onDecideAll={(d) => controller.setAllReviewDecisions(draft.draftId, d)}
        onDone={() => controller.finishReview(draft.draftId)}
        onCancel={() => controller.cancelReview(draft.draftId)}
      />
    );
  } else if (compare !== null && compareA !== undefined && compareB !== undefined) {
    main = (
      <MergeCompare
        left={compareA.body}
        right={compareB.body}
        leftLabel={`v${compareA.n}`}
        rightLabel={`v${compareB.n}`}
        lang={draft.lang}
      />
    );
  } else if (view.showChanges && working !== undefined && latest !== undefined) {
    const base = draft.versions[working.baseVersion - 1] ?? latest;
    main = (
      <MergeCompare
        left={base.body}
        right={working.text}
        leftLabel={t('view.agentVersion', { n: base.n })}
        rightLabel={t('view.yourChanges')}
        lang={draft.lang}
      />
    );
  } else if (draft.preview !== undefined && previewVisible) {
    main = (
      <DraftEditor
        docKey={`${draft.draftId}:preview:${draft.preview.messageId}`}
        text={draft.preview.body}
        readOnly
        lang={draft.preview.lang}
        label={t('view.streamingPreview')}
      />
    );
  } else if (latest !== undefined && olderShown) {
    const shown = draft.versions[shownN - 1] ?? latest;
    main = (
      <DraftEditor
        docKey={`${draft.draftId}:v${shown.n}:readonly`}
        text={shown.body}
        readOnly
        lang={shown.lang}
        label={t('view.versionReadOnly', { n: shown.n })}
      />
    );
  } else if (latest !== undefined) {
    canRewrite = draft.editable;
    main = (
      <DraftEditor
        docKey={`${draft.draftId}:v${latest.n}`}
        text={working?.text ?? latest.body}
        readOnly={!draft.editable}
        lang={latest.lang}
        label={t('view.latestVersion', { title: draftLabel(draft) })}
        onChange={onEdit}
        onSelectionChange={onSelectionChange}
        onSelectionCommit={setSettledSelection}
        clearSelectionSignal={clearSelectionSignal}
        revealRange={canRewrite && settledSelection !== null && draft.review === undefined ? settledSelection : null}
      />
    );
  } else {
    main = <div style={{ ...styles.box, ...styles.muted }}>{t('draft.waitingFinish')}</div>;
  }

  const showSelection = canRewrite && settledSelection !== null && draft.review === undefined;

  return (
    <>
      {header}
      {compareControls}
      {draft.preview !== undefined && snapshot.active && total > 0 ? (
        <div style={styles.row}>
          <span style={styles.muted}>{previewVisible ? t('incoming.showing') : t('incoming.arriving')}</span>
          <button type="button" style={styles.buttonSmall} onClick={() => setView({ previewHidden: !view.previewHidden })}>
            {previewVisible ? t('incoming.showCurrent') : t('incoming.showIncoming')}
          </button>
        </div>
      ) : null}
      {staleBanner}
      {main}
      {showSelection && settledSelection !== null ? (
        <CommentPopover draft={draft} range={settledSelection} mode={snapshot.rewrite} onAdd={addComment} />
      ) : null}
      {latest !== undefined && draft.review === undefined ? (
        <StagingBar
          controller={controller}
          drafts={snapshot.drafts}
          selected={draft}
          showingChanges={view.showChanges}
          onToggleShowChanges={() => setView({ showChanges: !view.showChanges, compare: null })}
          comments={comments}
          onRemoveComment={onRemoveComment}
          onSent={onSent}
        />
      ) : null}
    </>
  );
}

/**
 * The Draft Canvas side panel (ADAPTER_INTERFACE section 14.1, design section 6). It owns one
 * `DraftSessionController` for `adapter` and renders its snapshots: banners, draft list, version
 * pager, editor, staging bar, rewrite popover, per-hunk review and notices.
 *
 * Visibility (REQ-16): `active === false` hides the panel (`display: none`) but keeps it mounted so the
 * editor state survives. The controller stops publishing and omits streaming previews while hidden; the
 * panel starts no timers or animations, and the controller catches up once when it becomes visible.
 * `active === undefined` counts as visible.
 *
 * Language (see `resolveLocale`): the user's toggle choice, then `locale`, then a Chinese browser or
 * document language, then English. The header toggle switches between English and Chinese.
 */
export function DraftCanvasPanel({
  adapter,
  active,
  openHint: openHintProp,
  cssVariables,
  locale,
  storedLocale,
  onLocaleChange,
  storedTextStyle,
  onTextStyleChange,
  liveUpdates,
  refreshIntervalMs,
  storedDismissedBanners,
  onDismissedBannersChange,
  diagnostics,
  headerActions,
}: DraftCanvasPanelProps): ReactElement {
  const { controller, snapshot } = useDraftSession(adapter, active, refreshIntervalMs);
  const [dismissedBanners, setDismissedBanners] = useState(() => parseDismissedBanners(storedDismissedBanners));
  const dismissBanner = useCallback(
    (banner: DismissibleBanner) => {
      setDismissedBanners((current) => {
        const next = new Set(current);
        next.add(banner);
        onDismissedBannersChange?.(JSON.stringify([...next]));
        return next;
      });
    },
    [onDismissedBannersChange],
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [views, setViews] = useState<Record<string, DraftView>>({});
  const [selection, setSelection] = useState<SelectionRange | null>(null);
  const [comments, setComments] = useState<DraftComment[]>([]);
  const addComment = useCallback((comment: DraftComment) => setComments((all) => [...all, comment]), []);
  const removeComment = useCallback((index: number) => setComments((all) => all.filter((_, i) => i !== index)), []);
  const clearComments = useCallback(() => setComments([]), []);
  // Comments belong to one chat's drafts.
  const sessionKey = snapshot?.session?.sessionId ?? null;
  useEffect(() => {
    setComments([]);
  }, [sessionKey]);
  // The user's explicit choice; it wins until they change it.
  const [chosen, setChosen] = useState<Locale | null>(() => parseLocale(storedLocale));
  const i18n = useMemo(
    () => createI18n(resolveLocale({ stored: chosen, ...(locale !== undefined ? { preferred: locale } : {}) })),
    [chosen, locale],
  );
  const openHint = typeof openHintProp === 'object' ? openHintProp[i18n.locale] : openHintProp;
  const chooseLocale = useCallback(
    (next: Locale) => {
      setChosen(next);
      onLocaleChange?.(next);
    },
    [onLocaleChange],
  );
  const languageToggle = <LanguageToggle current={i18n.locale} onChoose={chooseLocale} />;
  const [textStyle, setTextStyle] = useState<TextStyle>(() => parseTextStyle(storedTextStyle ?? null));
  const changeTextStyle = useCallback(
    (next: TextStyle) => {
      setTextStyle(next);
      onTextStyleChange?.(next);
    },
    [onTextStyleChange],
  );
  const [diagText, setDiagText] = useState<string | null>(null);
  const toolbar = (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 2, marginLeft: 'auto' }} data-testid="panel-toolbar">
      {headerActions}
      <SettingsMenu>
        <TextStyleControls value={textStyle} onChange={changeTextStyle} />
        {languageToggle}
        {diagnostics !== undefined ? (
          <button
            type="button"
            style={styles.buttonSmall}
            data-testid="diagnostics-button"
            onClick={() => setDiagText((open) => (open === null ? diagnostics() : null))}
          >
            {i18n.t('diag.button')}
          </button>
        ) : null}
      </SettingsMenu>
    </span>
  );
  /** The toolbar alone, for the states without a draft header to sit in. */
  const toolbarRow = <div style={{ ...styles.row, justifyContent: 'flex-end' }}>{toolbar}</div>;
  const diagBox =
    diagText !== null && diagnostics !== undefined ? (
        <div style={styles.box} data-testid="diagnostics">
          <div style={styles.row}>
            <span style={styles.sectionTitle}>{i18n.t('diag.title')}</span>
            <span style={styles.spacer} />
            <button type="button" style={styles.buttonSmall} onClick={() => setDiagText(diagnostics())}>
              {i18n.t('diag.refresh')}
            </button>
            <button
              type="button"
              style={styles.buttonSmall}
              onClick={() => void navigator.clipboard?.writeText(diagText).catch(() => undefined)}
            >
              {i18n.t('diag.copy')}
            </button>
            <button type="button" style={styles.buttonGhost} aria-label={i18n.t('action.dismiss')} onClick={() => setDiagText(null)}>
              ×
            </button>
          </div>
          <textarea readOnly style={{ ...styles.textarea, minHeight: 200, fontFamily: 'ui-monospace, Consolas, monospace', fontSize: 12 }} value={diagText} />
        </div>
      ) : null;

  const rootStyle = useMemo<CSSProperties>(
    () => ({
      ...styles.root,
      ...(cssVariables as CSSProperties | undefined),
      ...(textStyleVariables(textStyle) as CSSProperties),
      ...(active === false ? styles.hidden : {}),
    }),
    [cssVariables, active, textStyle],
  );

  const onSelectionChange = useCallback((range: SelectionRange | null) => {
    setSelection((current) => (sameRange(current, range) ? current : range));
  }, []);


  const { t } = i18n;

  if (controller === null || snapshot === null) {
    return (
      <I18nContext.Provider value={i18n}>
        <div style={rootStyle} data-testid="draft-canvas-panel" lang={i18n.locale}>
          {toolbarRow}
          {diagBox}
          <div style={styles.muted}>{t('panel.starting')}</div>
        </div>
      </I18nContext.Provider>
    );
  }

  const drafts = snapshot.drafts;
  const selected = drafts.find((d) => d.draftId === selectedId) ?? drafts[drafts.length - 1];
  const view = selected !== undefined ? (views[selected.draftId] ?? DEFAULT_VIEW) : DEFAULT_VIEW;
  const setView = (patch: Partial<DraftView>): void => {
    if (selected === undefined) return;
    const id = selected.draftId;
    setSelection(null);
    setViews((all) => ({ ...all, [id]: { ...(all[id] ?? DEFAULT_VIEW), ...patch } }));
  };

  // Show the picker whenever there is a choice to make: several chats are listed, or no chat is attached yet
  // (including a single listed chat that was not picked automatically).
  const mustChoose = snapshot.session === null && snapshot.sessions.length > 0;
  // The picker follows the panel width: a native select is as wide as its longest chat title, which used
  // to push the panel wider than a narrow window and leave only this box sticking out.
  const sessionPicker =
    snapshot.sessions.length > 1 || mustChoose ? (
      <label
        style={{
          ...(mustChoose ? styles.title : styles.muted),
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          flex: '1 1 200px',
          minWidth: 0,
          maxWidth: 480,
        }}
      >
        <span style={{ flex: '0 0 auto' }}>{mustChoose ? t('session.choose') : t('session.chat')}</span>
        <select
          style={{ ...styles.select, flex: '1 1 auto', minWidth: 0, width: '100%', textOverflow: 'ellipsis' }}
          aria-label={t('session.chat')}
          data-testid="session-picker"
          value={snapshot.session?.sessionId ?? ''}
          onChange={(e) => {
            const ref = snapshot.sessions.find((s) => s.sessionId === e.target.value);
            if (ref !== undefined) void controller.selectSession(ref);
          }}
        >
          {snapshot.session === null ? <option value="">{t('session.chooseOption')}</option> : null}
          {snapshot.sessions.map((s) => (
            <option key={s.sessionId} value={s.sessionId}>
              {s.title ?? s.sessionId}
            </option>
          ))}
        </select>
      </label>
    ) : null;

  const noSession = snapshot.phase === 'ready' && snapshot.session === null;
  // Without the API grant nothing can be read, so "no chat" or "no drafts" would be misleading.
  const permissionDenied = drafts.length === 0 && snapshot.notices.some((n) => n.code === 'permission_denied');
  const permissionBox = permissionDenied ? (
    <div style={bannerStyle('warning')} role="alert" data-testid="permission-needed">
      <div>
        <div style={styles.title}>{t('permission.title')}</div>
        <div>{t('permission.how', { host: snapshot.host.info.displayName })}</div>
      </div>
    </div>
  ) : null;

  return (
    <I18nContext.Provider value={i18n}>
      <div
        style={rootStyle}
        data-testid="draft-canvas-panel"
        lang={i18n.locale}
        aria-hidden={active === false ? true : undefined}
      >
        {selected === undefined ? toolbarRow : null}
        {diagBox}
        <StatusBanners snapshot={snapshot} controller={controller} dismissed={dismissedBanners} onDismiss={dismissBanner} />
        <NoticeList notices={snapshot.notices} controller={controller} />
        {liveUpdates === false ? (
          <div style={bannerStyle('warning')} role="alert" data-testid="no-live-updates">
            {t('banner.noLiveUpdates', { host: snapshot.host.info.displayName })}
          </div>
        ) : null}

        {sessionPicker !== null || drafts.length > 1 ? (
          <div style={styles.row}>
            {sessionPicker}
            {drafts.length > 1
              ? drafts.map((d) => (
                  <button
                    key={d.draftId}
                    type="button"
                    style={{ ...styles.chip, ...(selected?.draftId === d.draftId ? styles.chipSelected : {}) }}
                    aria-pressed={selected?.draftId === d.draftId}
                    title={d.draftId}
                    onClick={() => {
                      setSelection(null);
                      setSelectedId(d.draftId);
                    }}
                  >
                    {draftLabel(d)}
                    {d.preview !== undefined && snapshot.active ? ' ⋯' : ''}
                    {d.status === 'dirty' || d.status === 'staged-stale' ? ' •' : ''}
                  </button>
                ))
              : null}
          </div>
        ) : null}

        {permissionBox}

        {noSession && !permissionDenied ? (
          <div style={{ ...styles.box, ...styles.muted }} data-testid="no-session">
            {snapshot.sessions.length > 0 ? (
              <div>{t('nosession.pick')}</div>
            ) : (
              <>
                <div>{t('nosession.none')}</div>
                <div>
                  <button type="button" style={styles.buttonSmall} onClick={() => void controller.refresh()}>
                    {t('nosession.checkAgain')}
                  </button>
                </div>
              </>
            )}
          </div>
        ) : null}

        {selected === undefined ? (
          noSession || permissionDenied ? null : <EmptyState openHint={openHint} phase={snapshot.phase} />
        ) : (
          <DraftBody
            controller={controller}
            snapshot={snapshot}
            draft={selected}
            view={view}
            setView={setView}
            selection={selection}
            onSelectionChange={onSelectionChange}
            comments={comments}
            onAddComment={addComment}
            onRemoveComment={removeComment}
            onSent={clearComments}
            toolbar={toolbar}
          />
        )}
      </div>
    </I18nContext.Provider>
  );
}
