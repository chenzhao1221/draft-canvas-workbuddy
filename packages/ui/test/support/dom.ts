import { EditorView } from '@codemirror/view';
import type { Message } from '@draft-canvas/core';

/** Helpers shared by the panel component tests. They touch only the public CodeMirror API. */

export function assistantMessage(id: string, text: string): Message {
  return {
    id,
    sessionId: 'session-1',
    role: 'assistant',
    text,
    createdAt: '2026-01-01T00:00:00.000Z',
    complete: true,
  };
}

/** The CodeMirror view the panel mounted, found from the DOM (the panel owns the instance). */
export function editorView(container: ParentNode = document): EditorView {
  const dom = container.querySelector('.cm-editor');
  if (!(dom instanceof HTMLElement)) throw new Error('the panel rendered no CodeMirror editor');
  const view = EditorView.findFromDOM(dom);
  if (view === null) throw new Error('no EditorView is attached to the editor DOM');
  return view;
}

/** Appends text at the end of the document, as typing would. */
export function appendText(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: view.state.doc.length, insert: text } });
}

/** Replaces the whole document, as a paste over a selection would. */
export function replaceText(view: EditorView, text: string): void {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } });
}

/** Marks 0-based UTF-16 offsets as selected; the panel converts them to code points. */
/**
 * Selects a range the way a user does: the transaction moves the selection, then the gesture ends
 * with a `mouseup`. The panel opens the comment box on that end, not on every selection change.
 */
export function selectRange(view: EditorView, from: number, to: number): void {
  view.dispatch({ selection: { anchor: from, head: to } });
  view.contentDOM.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
}
