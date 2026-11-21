import { useEffect, useRef, type ReactElement } from 'react';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { markdown } from '@codemirror/lang-markdown';
import { Annotation, Compartment, EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap } from '@codemirror/view';
import { utf16ToCodePoint, type SelectionRange } from '@draft-canvas/core';
import { styles } from './styles';

/** Marks transactions that come from the `text` prop, so they are not echoed to `onChange`. */
const external = Annotation.define<boolean>();

export interface DraftEditorProps {
  /**
   * Identity of the shown document (draft id plus which version). When it changes the editor is
   * rebuilt, which also resets the undo history.
   */
  docKey: string;
  text: string;
  readOnly: boolean;
  /** `markdown` turns on Markdown highlighting; anything else is plain text. */
  lang: string;
  /** Called with the full text after each user edit (UTF-16 string, LF line endings). */
  onChange?: (text: string) => void;
  /** Called when the non-empty selection changes; `null` for an empty selection. Code-point coordinates. */
  onSelectionChange?: (range: SelectionRange | null) => void;
  /**
   * Called when the user *finishes* selecting: mouse up, a shift/arrow key, a touch. The panel opens
   * the comment box here instead of on every change, so it never appears in the middle of a drag.
   */
  onSelectionCommit?: (range: SelectionRange | null) => void;
  /** Accessible label of the editing surface. */
  label?: string;
  /** Changing this number collapses the selection to its end (the panel bumps it after adding a comment). */
  clearSelectionSignal?: number;
  /**
   * Scroll this range into the middle of the editor. The panel passes the selection while the comment
   * box is open, so the box (which renders under the editor) never covers the caret at the bottom.
   */
  revealRange?: SelectionRange | null;
}

/** The editor selection as an ADAPTER_INTERFACE section 12 range: 1-based lines, code-point offsets. */
export function selectionToRange(state: EditorState): SelectionRange | null {
  const { from, to } = state.selection.main;
  if (from === to) return null;
  const first = state.doc.lineAt(from);
  const last = state.doc.lineAt(to);
  return {
    startLine: first.number,
    startOffset: utf16ToCodePoint(first.text, from - first.from),
    endLine: last.number,
    endOffset: utf16ToCodePoint(last.text, to - last.from),
  };
}

function rangeKey(range: SelectionRange | null): string {
  return range === null ? '' : `${range.startLine}:${range.startOffset}-${range.endLine}:${range.endOffset}`;
}

function accessMode(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)];
}

const baseTheme = EditorView.theme({
  '&': { fontSize: 'var(--dc-editor-font-size, 16px)', background: 'transparent', color: 'inherit' },
  '.cm-content': { padding: '16px 20px', fontFamily: 'inherit', lineHeight: '1.8', caretColor: 'var(--dc-accent, #4567AA)' },
  '.cm-scroller': { fontFamily: 'var(--dc-editor-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)' },
  '.cm-line': { padding: '0' },
  '&.cm-focused': { outline: 'none' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground': {
    background: 'color-mix(in srgb, var(--dc-accent, #4567AA) 22%, transparent) !important',
  },
});

/** CodeMirror 6 view wrapped for React. Text flows in through `text`, edits flow out through `onChange`. */
export function DraftEditor(props: DraftEditorProps): ReactElement {
  const { docKey, text, readOnly, lang, label } = props;
  const host = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);
  const accessRef = useRef(new Compartment());
  // Latest values for the long-lived view callbacks.
  const latest = useRef(props);
  latest.current = props;
  const lastRange = useRef('');

  // The comment box opens under the editor and takes height away from it; without this the caret of a
  // selection at the bottom ends up outside the visible part of the editor, i.e. "behind" the box.
  useEffect(() => {
    const view = viewRef.current;
    const range = props.revealRange ?? null;
    if (view === null || range === null) return;
    const lineNumber = Math.min(Math.max(range.endLine, 1), view.state.doc.lines);
    const line = view.state.doc.line(lineNumber);
    view.dispatch({ effects: EditorView.scrollIntoView(line.from, { y: 'center' }) });
  }, [props.revealRange]);

  // Create the view; rebuild it when the document identity or language changes.
  useEffect(() => {
    const parent = host.current;
    if (parent === null) return undefined;
    const isMarkdown = lang.toLowerCase() === 'markdown';
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: latest.current.text,
        extensions: [
          history(),
          drawSelection(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          EditorView.lineWrapping,
          // Keep a strip of empty text under the caret: the panel's bottom controls sit right below.
          EditorView.scrollMargins.of(() => ({ bottom: 96 })),
          isMarkdown ? markdown() : [],
          baseTheme,
          accessRef.current.of(accessMode(latest.current.readOnly)),
          EditorView.contentAttributes.of({ 'aria-label': latest.current.label ?? 'Draft text' }),
          EditorView.domEventHandlers({
            mouseup: (_event, view) => {
              latest.current.onSelectionCommit?.(selectionToRange(view.state));
              return false;
            },
            touchend: (_event, view) => {
              latest.current.onSelectionCommit?.(selectionToRange(view.state));
              return false;
            },
            keyup: (event, view) => {
              const selecting = event.shiftKey || ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'PageUp', 'PageDown'].includes(event.key);
              if (selecting) latest.current.onSelectionCommit?.(selectionToRange(view.state));
              return false;
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged && !update.transactions.some((t) => t.annotation(external) === true)) {
              latest.current.onChange?.(update.state.doc.toString());
            }
            if (update.selectionSet || update.docChanged) {
              const range = selectionToRange(update.state);
              const key = rangeKey(range);
              if (key !== lastRange.current) {
                lastRange.current = key;
                latest.current.onSelectionChange?.(range);
              }
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    if (lastRange.current !== '') {
      lastRange.current = '';
      latest.current.onSelectionChange?.(null);
    }
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, [docKey, lang]);

  // Controlled text: apply outside changes (version switch, review result, discard).
  useEffect(() => {
    const view = viewRef.current;
    if (view === null) return;
    const current = view.state.doc.toString();
    if (current === text) return;
    view.dispatch({
      changes: { from: 0, to: current.length, insert: text },
      annotations: external.of(true),
    });
  }, [text, docKey, lang]);

  useEffect(() => {
    viewRef.current?.dispatch({ effects: accessRef.current.reconfigure(accessMode(readOnly)) });
  }, [readOnly, docKey, lang]);

  // Collapse the selection on request; the update listener then reports `null` to the parent.
  const clearSignal = props.clearSelectionSignal;
  useEffect(() => {
    if (clearSignal === undefined || clearSignal === 0) return;
    const view = viewRef.current;
    if (view === null) return;
    const head = view.state.selection.main.to;
    view.dispatch({ selection: { anchor: head } });
  }, [clearSignal]);

  // The selection belongs to this editor instance; clear it for the parent when the editor goes away.
  useEffect(
    () => () => {
      latest.current.onSelectionChange?.(null);
    },
    [],
  );

  return <div ref={host} style={styles.editorBox} data-testid="draft-editor" aria-label={label} />;
}
