import { useEffect, useState, type ReactElement } from 'react';
import { extractSelection, type DraftComment, type DraftState, type RewriteMode, type SelectionRange } from '@draft-canvas/core';
import { useI18n, type I18n } from './i18n';
import { bannerStyle, styles } from './styles';

export interface CommentPopoverProps {
  draft: DraftState;
  /** Non-empty selection in the editor text (code-point coordinates). */
  range: SelectionRange;
  mode: RewriteMode;
  onAdd: (comment: DraftComment) => void;
}

function describeRange(range: SelectionRange, t: I18n['t']): string {
  return range.startLine === range.endLine
    ? t('rewrite.line', { n: range.startLine })
    : t('rewrite.lines', { a: range.startLine, b: range.endLine });
}

/** The text the editor shows for `draft`: the user's working copy, else the latest version. */
export function editorText(draft: DraftState): string | undefined {
  return draft.workingCopy?.text ?? draft.versions[draft.versions.length - 1]?.body;
}

/**
 * A comment on the selected passage. Nothing is sent here: the comment joins the list that the one
 * "Send to the agent" button sends together with the user's edits. The selection may include the user's
 * own unsent edits, because the edits go out first in the same message.
 */
export function CommentPopover({ draft, range, mode, onAdd }: CommentPopoverProps): ReactElement | null {
  const { t } = useI18n();
  const [instruction, setInstruction] = useState('');
  const [added, setAdded] = useState(false);

  const rangeKey = `${range.startLine}:${range.startOffset}-${range.endLine}:${range.endOffset}`;
  useEffect(() => {
    setAdded(false);
  }, [rangeKey, draft.draftId]);

  if (mode === 'unavailable') return null;
  const text = editorText(draft);
  const quote = text === undefined ? null : extractSelection(text, range);
  const blocked = quote === null || quote === '' || instruction.trim() === '';

  const onAddClick = (): void => {
    if (blocked || quote === null) return;
    onAdd({ draftId: draft.draftId, range, quote, instruction: instruction.trim() });
    setInstruction('');
    setAdded(true);
  };

  return (
    <div style={styles.box} data-testid="comment-popover">
      <div style={styles.row}>
        <span style={styles.title}>{t('comment.title')}</span>
        <span style={styles.muted}>{describeRange(range, t)}</span>
      </div>
      <textarea
        style={styles.textarea}
        value={instruction}
        placeholder={t('rewrite.placeholder')}
        aria-label={t('rewrite.instructionLabel')}
        onChange={(e) => {
          setInstruction(e.target.value);
          setAdded(false);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
            e.preventDefault();
            onAddClick();
          }
        }}
      />
      {added ? (
        <div style={bannerStyle('info')} role="status">
          {t('comment.added')}
        </div>
      ) : null}
      <div style={styles.row}>
        <span style={styles.spacer} />
        <button
          type="button"
          style={{ ...styles.button, ...(blocked ? styles.buttonDisabled : {}) }}
          disabled={blocked}
          onClick={onAddClick}
        >
          {t('comment.add')}
        </button>
      </div>
    </div>
  );
}
