import type { ReactElement } from 'react';
import type { Hunk, HunkDecision, ReviewState } from '@draft-canvas/core';
import { useI18n } from './i18n';
import { styles } from './styles';

export interface ReviewViewProps {
  review: ReviewState;
  onDecision: (hunkIndex: number, decision: HunkDecision | null) => void;
  onDecideAll: (decision: HunkDecision | null) => void;
  onDone: () => void;
  onCancel: () => void;
}

function Lines({ text, kind }: { text: string; kind: 'add' | 'del' }): ReactElement {
  const { t } = useI18n();
  const label = kind === 'add' ? t('review.agentVersion') : t('review.yourText');
  return (
    <pre
      style={{ ...styles.pre, ...(kind === 'add' ? styles.preAdd : styles.preDel) }}
      aria-label={label}
    >
      {text === '' ? t('review.emptyLine') : text}
    </pre>
  );
}

function HunkRow({
  hunk,
  total,
  decision,
  onDecision,
}: {
  hunk: Hunk;
  total: number;
  decision: HunkDecision | null;
  onDecision: (decision: HunkDecision | null) => void;
}): ReactElement {
  const { t } = useI18n();
  const accepted = decision === 'accept';
  const rejected = decision === 'reject';
  return (
    <li style={styles.hunk} data-testid="review-hunk">
      <div style={styles.hunkBar}>
        <span style={styles.muted}>
          {t('review.change', { n: hunk.index + 1, total })}
        </span>
        <span style={styles.spacer} />
        <button
          type="button"
          style={{ ...styles.buttonSmall, ...(rejected ? { borderColor: 'currentColor', fontWeight: 600 } : {}) }}
          aria-pressed={rejected}
          onClick={() => onDecision(rejected ? null : 'reject')}
        >
          {t('review.reject')}
        </button>
        <button
          type="button"
          style={{ ...styles.buttonSmall, ...(accepted ? { borderColor: 'currentColor', fontWeight: 600 } : {}) }}
          aria-pressed={accepted}
          onClick={() => onDecision(accepted ? null : 'accept')}
        >
          {t('review.accept')}
        </button>
      </div>
      {hunk.leftEnd > hunk.leftStart ? <Lines text={hunk.leftText} kind="del" /> : null}
      {hunk.rightEnd > hunk.rightStart ? <Lines text={hunk.rightText} kind="add" /> : null}
    </li>
  );
}

/**
 * Per-hunk review (design section 5.6). The hunks and the decisions are the ones computed and held by
 * core (`computeHunks`, `setReviewDecision`), so what the user sees is exactly what `finishReview`
 * resolves. Accept keeps the agent's text for that change; Reject keeps the user's text.
 * A change left undecided keeps the user's text.
 */
export function ReviewView({ review, onDecision, onDecideAll, onDone, onCancel }: ReviewViewProps): ReactElement {
  const { t, msg } = useI18n();
  const undecided = review.decisions.filter((d) => d === null).length;
  return (
    <div style={{ ...styles.editorBox, padding: 8, display: 'flex', flexDirection: 'column', gap: 8 }} data-testid="review-view">
      <div style={styles.row}>
        <span style={styles.title}>{t('review.title')}</span>
        <span style={styles.muted}>
          {t('review.toVersion', { label: msg(review.leftLabel), n: review.rightVersion })}
        </span>
      </div>
      {review.hunks.length === 0 ? (
        <div style={styles.muted}>{t('review.noDiff')}</div>
      ) : (
        <ul style={styles.list}>
          {review.hunks.map((hunk) => (
            <HunkRow
              key={hunk.index}
              hunk={hunk}
              total={review.hunks.length}
              decision={review.decisions[hunk.index] ?? null}
              onDecision={(d) => onDecision(hunk.index, d)}
            />
          ))}
        </ul>
      )}
      <div style={styles.row}>
        <button type="button" style={styles.button} onClick={() => onDecideAll('reject')}>
          {t('review.rejectAll')}
        </button>
        <button type="button" style={styles.button} onClick={() => onDecideAll('accept')}>
          {t('review.acceptAll')}
        </button>
        <span style={styles.spacer} />
        {undecided > 0 ? <span style={styles.muted}>{t('review.undecided', { count: undecided })}</span> : null}
        <button type="button" style={styles.button} onClick={onCancel}>
          {t('review.cancel')}
        </button>
        <button type="button" style={styles.buttonPrimary} onClick={onDone}>
          {t('review.done')}
        </button>
      </div>
    </div>
  );
}
