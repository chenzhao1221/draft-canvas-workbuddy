import { useEffect, useRef, type ReactElement } from 'react';
import { markdown } from '@codemirror/lang-markdown';
import { MergeView } from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView } from '@codemirror/view';
import { color, styles } from './styles';

export interface MergeCompareProps {
  left: string;
  right: string;
  leftLabel: string;
  rightLabel: string;
  lang: string;
}

const readOnlyTheme = EditorView.theme({
  '&': { fontSize: 'var(--dc-editor-font-size, 16px)', background: 'transparent', color: 'inherit' },
  '.cm-content': { lineHeight: '1.7' },
  '.cm-scroller': { fontFamily: 'var(--dc-editor-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)' },
});

/**
 * Read-only side-by-side comparison of two texts (`@codemirror/merge`). Used for "Compare versions"
 * and "Show my changes". There are no accept or reject controls here; per-hunk review is `ReviewView`.
 */
export function MergeCompare({ left, right, leftLabel, rightLabel, lang }: MergeCompareProps): ReactElement {
  const host = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const parent = host.current;
    if (parent === null) return undefined;
    const extensions: Extension[] = [
      EditorState.readOnly.of(true),
      EditorView.editable.of(false),
      EditorView.lineWrapping,
      readOnlyTheme,
      lang.toLowerCase() === 'markdown' ? markdown() : [],
    ];
    const view = new MergeView({
      a: { doc: left, extensions },
      b: { doc: right, extensions },
      parent,
      highlightChanges: true,
      gutter: true,
      collapseUnchanged: { margin: 2, minSize: 4 },
    });
    return () => view.destroy();
  }, [left, right, lang]);

  return (
    <div style={{ ...styles.editorBox, display: 'flex', flexDirection: 'column' }} data-testid="merge-compare">
      <div style={{ ...styles.row, padding: '3px 8px', borderBottom: `1px solid ${color.border}` }}>
        <span style={styles.muted}>{leftLabel}</span>
        <span style={styles.muted}>→</span>
        <span style={styles.muted}>{rightLabel}</span>
      </div>
      <div ref={host} />
    </div>
  );
}
