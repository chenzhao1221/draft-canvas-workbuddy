import { useEffect, useRef, useState, type ReactElement } from 'react';
import type { DraftComment, DraftSendResult, DraftSessionController, DraftState, NoticeLevel } from '@draft-canvas/core';
import { useI18n } from './i18n';
import { bannerStyle, styles } from './styles';

export const LABEL_ADD = 'Add changes to my message';
export const LABEL_UPDATE = 'Update changes in my message';
export const LABEL_ALREADY = 'Already in your message';

export type StageButtonState = { label: string; enabled: boolean };

/**
 * Label and enabled state of the staging button (design section 5.4). Staging is explicit and covers every
 * draft that has changes not yet in the message: `dirty` drafts are added, `staged-stale` drafts are updated
 * (the new changelog is appended and the last one wins). A `staged` draft is already in the message.
 */
export function stageButtonState(drafts: readonly DraftState[]): StageButtonState {
  const { kind, enabled } = stageButtonKind(drafts);
  return { label: kind === 'update' ? LABEL_UPDATE : kind === 'already' ? LABEL_ALREADY : LABEL_ADD, enabled };
}

type StageButtonKind = 'add' | 'update' | 'already';

/** The decision behind `stageButtonState`, without the English label, so the panel can translate it. */
function stageButtonKind(drafts: readonly DraftState[]): { kind: StageButtonKind; enabled: boolean } {
  if (drafts.some((d) => d.status === 'dirty')) return { kind: 'add', enabled: true };
  if (drafts.some((d) => d.status === 'staged-stale')) return { kind: 'update', enabled: true };
  if (drafts.some((d) => d.status === 'staged')) return { kind: 'already', enabled: false };
  return { kind: 'add', enabled: false };
}

function resultLevel(result: DraftSendResult): NoticeLevel {
  if (result.status === 'sent' || result.status === 'queued_in_composer' || result.status === 'nothing_to_send') return 'info';
  if (result.status === 'error') return 'error';
  return 'warning';
}

/** Draft statuses with edits that have not reached the agent yet. */
const UNSENT: ReadonlySet<DraftState['status']> = new Set(['dirty', 'staged', 'staged-stale']);

/** Whether the one send button has anything to send. */
export function canSend(drafts: readonly DraftState[], comments: readonly DraftComment[]): boolean {
  return comments.length > 0 || drafts.some((d) => UNSENT.has(d.status));
}

function shorten(text: string, max = 40): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  const chars = [...flat];
  return chars.length > max ? `${chars.slice(0, max).join('')}…` : flat;
}

export interface StagingBarProps {
  controller: DraftSessionController;
  /** Every draft in the session: the send covers every draft with unsent edits. */
  drafts: readonly DraftState[];
  /** The draft on screen: discard, "show my changes" and the warnings refer to it. */
  selected: DraftState;
  showingChanges: boolean;
  onToggleShowChanges: () => void;
  /** Comments waiting to be sent, across all drafts. */
  comments: readonly DraftComment[];
  onRemoveComment: (index: number) => void;
  /** Called after a successful send so the panel can clear the comment list. */
  onSent: () => void;
}

/**
 * The action bar below the editor. ONE button sends the user's edits and comments together
 * (`DraftSessionController.sendAll`): edits as changelogs first, then the comments.
 */
export function StagingBar({
  controller,
  drafts,
  selected,
  showingChanges,
  onToggleShowChanges,
  comments,
  onRemoveComment,
  onSent,
}: StagingBarProps): ReactElement {
  const { t, msg } = useI18n();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<DraftSendResult | null>(null);
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);

  // A send result no longer describes the state once the user edits again or adds a comment.
  const selectedStatus = selected.status;
  useEffect(() => {
    if (selectedStatus === 'dirty' || selectedStatus === 'clean') {
      setResult((current) => (current?.status === 'sent' || current?.status === 'queued_in_composer' ? null : current));
    }
    if (selectedStatus === 'clean') setConfirmingDiscard(false);
  }, [selectedStatus]);
  useEffect(() => {
    if (comments.length > 0) setResult((current) => (current?.status === 'sent' ? null : current));
  }, [comments.length]);

  const enabled = canSend(drafts, comments) && !busy;
  const hasChanges = selected.workingCopy !== undefined;
  const canReview = selected.versions.length >= 2 && selected.review === undefined;
  const waiting = drafts.some((d) => d.pendingRewrite !== undefined);
  const labelOf = (draftId: string): string => {
    const draft = drafts.find((d) => d.draftId === draftId);
    return draft?.title !== undefined && draft.title !== '' ? draft.title : draftId;
  };

  const onSend = (): void => {
    if (!enabled) return;
    setBusy(true);
    setResult(null);
    controller
      .sendAll({ comments })
      .then((r) => {
        setResult(r);
        if (r.status === 'sent' || r.status === 'queued_in_composer') onSent();
      })
      .catch((err: unknown) =>
        setResult({
          status: 'error',
          draftIds: [],
          message: err instanceof Error ? err.message : t('send.failed'),
        }),
      )
      .finally(() => setBusy(false));
  };

  // Ctrl+Enter (Cmd+Enter on a Mac) anywhere in the panel sends, so the hands stay on the keyboard
  // after editing. The comment box keeps Ctrl+Enter for "add comment", so text fields are skipped.
  const bar = useRef<HTMLDivElement | null>(null);
  const sendRef = useRef(onSend);
  sendRef.current = onSend;
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Enter' || !(event.ctrlKey || event.metaKey) || event.defaultPrevented) return;
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest('textarea, input, select') !== null) return;
      const panel = bar.current?.closest('[data-testid="draft-canvas-panel"]');
      if (panel === null || panel === undefined || !panel.contains(target)) return;
      event.preventDefault();
      sendRef.current();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, []);
  /** What the send covers: comments plus drafts with edits that have not reached the agent. */
  const pendingCount = comments.length + drafts.filter((d) => UNSENT.has(d.status)).length;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }} data-testid="staging-bar">
      {selected.changelogError !== undefined ? (
        <div style={bannerStyle('warning')} role="alert">
          {msg(selected.changelogError.message)}
        </div>
      ) : null}
      {selected.status === 'sent' && !waiting ? (
        <div style={bannerStyle('info')} role="status">
          {t('stage.sent')}
        </div>
      ) : null}
      {waiting ? (
        <div style={bannerStyle('info')} role="status">
          {t('rewrite.waiting')}
        </div>
      ) : null}

      {comments.length > 0 ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="comment-list">
          <div style={styles.row}>
            <span style={styles.sectionTitle}>{t('comment.list', { n: comments.length })}</span>
            <span style={styles.spacer} />
            <span style={styles.label}>{t('comment.hint')}</span>
          </div>
          {comments.map((comment, index) => (
            <div
              key={`${comment.draftId}:${index}`}
              style={{
                ...styles.box,
                ...(result?.commentIndex === index ? { borderColor: 'var(--dc-warning, #A87430)' } : {}),
              }}
            >
              <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
                <div style={{ ...styles.quote, flex: 1, minWidth: 0 }}>
                  {drafts.length > 1 ? <span>{labelOf(comment.draftId)} · </span> : null}
                  {shorten(comment.quote, 80)}
                </div>
                <button
                  type="button"
                  style={styles.buttonGhost}
                  aria-label={t('comment.remove')}
                  title={t('comment.remove')}
                  onClick={() => onRemoveComment(index)}
                >
                  ×
                </button>
              </div>
              <div style={{ fontSize: 14, lineHeight: 1.6, paddingLeft: 4 }}>{comment.instruction}</div>
            </div>
          ))}
        </div>
      ) : null}

      <div style={styles.bottomBar} ref={bar}>
      {/* Inset from both edges so the two groups sit at about 30% and 70% instead of hugging the
          corners; `space-between` keeps the send button put even when there are no other buttons. */}
      <div style={{ ...styles.row, justifyContent: 'space-between', padding: '0 clamp(12px, 22%, 220px)' }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {canReview ? (
          <button type="button" style={styles.button} onClick={() => controller.openReview(selected.draftId)}>
            {t('stage.review')}
          </button>
        ) : null}
        {hasChanges ? (
          <button type="button" style={styles.button} onClick={onToggleShowChanges}>
            {showingChanges ? t('stage.hideChanges') : t('stage.showChanges')}
          </button>
        ) : null}
        {hasChanges && !confirmingDiscard ? (
          <button type="button" style={styles.buttonDanger} onClick={() => setConfirmingDiscard(true)}>
            {t('stage.discard')}
          </button>
        ) : null}
        {hasChanges && confirmingDiscard ? (
          <>
            <span style={styles.muted}>{t('stage.discardConfirm')}</span>
            <button
              type="button"
              style={styles.buttonDanger}
              onClick={() => {
                setConfirmingDiscard(false);
                setResult(null);
                controller.discardChanges(selected.draftId);
              }}
            >
              {t('stage.discardYes')}
            </button>
            <button type="button" style={styles.button} onClick={() => setConfirmingDiscard(false)}>
              {t('stage.keep')}
            </button>
          </>
        ) : null}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          {!canSend(drafts, comments) && !busy ? (
            <span style={styles.label} data-testid="send-nothing">
              {t('send.nothing')}
            </span>
          ) : null}
        <button
          type="button"
          style={{ ...styles.buttonPrimary, ...(!enabled ? styles.buttonDisabled : {}) }}
          disabled={!enabled}
          onClick={onSend}
          title={t('send.shortcut')}
          data-testid="send-button"
        >
          {t('send.button')}
          {pendingCount > 0 ? (
            <span aria-hidden="true" style={{ opacity: 0.8, fontWeight: 400 }} data-testid="send-count">
              · {pendingCount}
            </span>
          ) : null}
          </button>
        </span>
      </div>

      {result !== null ? (
        <div style={bannerStyle(resultLevel(result))} role={result.status === 'sent' || result.status === 'queued_in_composer' ? 'status' : 'alert'}>
          {msg(result.message)}
        </div>
      ) : null}
      </div>
    </div>
  );
}
