import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftSessionController, type DraftComment, type DraftState, type SelectionRange } from '@draft-canvas/core';
import { DraftCanvasPanel } from '../src/index';
// CommentPopover is not part of the package's public API; the test uses the component module directly.
import { CommentPopover } from '../src/CommentPopover';
import { appendText, assistantMessage, editorView, selectRange } from './support/dom';
import { UiFakeHost, draftReply } from './support/fake-host';

afterEach(cleanup);

const BODY = 'Line one.\nLine two.\nLine three.';

async function makeController(body = BODY): Promise<{ host: UiFakeHost; controller: DraftSessionController }> {
  const host = new UiFakeHost({ messages: [assistantMessage('a1', draftReply('d1', body))] });
  const controller = new DraftSessionController({ adapter: host });
  await controller.start();
  return { host, controller };
}

function draftOf(controller: DraftSessionController): DraftState {
  const draft = controller.getSnapshot()?.drafts.find((d) => d.draftId === 'd1');
  if (draft === undefined) throw new Error('draft d1 is missing');
  return draft;
}

const LINE_TWO: SelectionRange = { startLine: 2, startOffset: 0, endLine: 2, endOffset: 8 };

describe('CommentPopover', () => {
  it('renders nothing when the host cannot send', async () => {
    const { controller } = await makeController();
    const { container } = render(
      <CommentPopover draft={draftOf(controller)} range={LINE_TWO} mode="unavailable" onAdd={() => undefined} />,
    );
    expect(container.innerHTML).toBe('');
  });

  it('adds a comment with the selected text and sends nothing', async () => {
    const { host, controller } = await makeController();
    const added: DraftComment[] = [];
    render(<CommentPopover draft={draftOf(controller)} range={LINE_TWO} mode="send" onAdd={(c) => added.push(c)} />);

    const add = screen.getByRole('button', { name: 'Add comment' }) as HTMLButtonElement;
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rewrite instruction'), { target: { value: '   ' } });
    expect(add.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Rewrite instruction'), { target: { value: 'Make it shorter.' } });
    fireEvent.click(add);

    expect(added).toEqual([{ draftId: 'd1', range: LINE_TWO, quote: 'Line two', instruction: 'Make it shorter.' }]);
    expect(host.sent).toHaveLength(0);
    expect(host.injected).toHaveLength(0);
  });

  it('accepts a selection inside the user\'s own unsent edits', async () => {
    const { controller } = await makeController();
    controller.edit('d1', 'Line one changed.\nLine two.\nLine three.');
    const added: DraftComment[] = [];
    render(
      <CommentPopover
        draft={draftOf(controller)}
        range={{ startLine: 1, startOffset: 9, endLine: 1, endOffset: 16 }}
        mode="send"
        onAdd={(c) => added.push(c)}
      />,
    );
    fireEvent.change(screen.getByLabelText('Rewrite instruction'), { target: { value: 'Another word.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(added[0]?.quote).toBe('changed');
  });
});

describe('panel: one send for edits and comments', () => {
  async function renderPanel(): Promise<UiFakeHost> {
    const host = new UiFakeHost({ messages: [assistantMessage('a1', draftReply('d1', BODY))] });
    render(<DraftCanvasPanel adapter={host} />);
    await waitFor(() => expect(screen.getByTestId('draft-editor')).toBeDefined());
    return host;
  }

  function sendButton(): HTMLButtonElement {
    return screen.getByTestId('send-button') as HTMLButtonElement;
  }

  it('has a single send button and no separate staging or rewrite send', async () => {
    await renderPanel();
    expect(sendButton().textContent).toBe('Send to the agent');
    expect(sendButton().disabled).toBe(true);
    expect(screen.queryByRole('button', { name: /Add changes to my message|^Send$/ })).toBeNull();
  });

  it('sends the edits first and a comment on the edited text in the same message', async () => {
    const host = await renderPanel();
    act(() => {
      appendText(editorView(), '\nMy new line.');
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    // Select "My new line" (line 4), which exists only in the user's edits.
    act(() => {
      const doc = editorView().state.doc.toString();
      const from = doc.indexOf('My new line');
      selectRange(editorView(), from, from + 'My new line'.length);
    });
    await waitFor(() => expect(screen.getByTestId('comment-popover')).toBeDefined());
    fireEvent.change(screen.getByLabelText('Rewrite instruction'), { target: { value: 'Say it warmer.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(screen.getByTestId('comment-list').textContent).toContain('Say it warmer.'));
    // Adding the comment drops the selection, so the comment box closes.
    expect(editorView().state.selection.main.empty).toBe(true);
    expect(screen.queryByTestId('comment-popover')).toBeNull();

    fireEvent.click(sendButton());
    await waitFor(() => expect(host.sent).toHaveLength(1));
    const sent = host.sent[0] ?? '';
    const changelogAt = sent.indexOf('```draft-changelog id="d1" from="1" to="2"');
    const rewriteAt = sent.indexOf('```draft-rewrite id="d1" rev="2" start_line="4"');
    expect(changelogAt).toBe(0);
    expect(rewriteAt).toBeGreaterThan(changelogAt);
    expect(sent).toContain('My new line');
    expect(sent.trimEnd().endsWith('Say it warmer.')).toBe(true);
    expect(host.injected).toHaveLength(0);
    await waitFor(() => expect(screen.queryByTestId('comment-list')).toBeNull());
  });

  it('sends a comment alone when there are no edits', async () => {
    const host = await renderPanel();
    act(() => {
      selectRange(editorView(), 10, 18);
    });
    await waitFor(() => expect(screen.getByTestId('comment-popover')).toBeDefined());
    fireEvent.change(screen.getByLabelText('Rewrite instruction'), { target: { value: 'Shorter.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.sent[0]?.startsWith('```draft-rewrite id="d1" rev="1" start_line="2"')).toBe(true);
  });

  it('removes a comment from the list', async () => {
    await renderPanel();
    act(() => {
      selectRange(editorView(), 0, 4);
    });
    await waitFor(() => expect(screen.getByTestId('comment-popover')).toBeDefined());
    fireEvent.change(screen.getByLabelText('Rewrite instruction'), { target: { value: 'Drop it.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    await waitFor(() => expect(screen.getByTestId('comment-list')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Remove comment' }));
    await waitFor(() => expect(screen.queryByTestId('comment-list')).toBeNull());
    expect(sendButton().disabled).toBe(true);
  });

  it('hides the comment box on an older version', async () => {
    const host = new UiFakeHost({
      messages: [
        assistantMessage('a1', draftReply('d1', BODY)),
        assistantMessage('a2', draftReply('d1', `${BODY}\nLine four.`)),
      ],
    });
    render(<DraftCanvasPanel adapter={host} />);
    await waitFor(() => expect(screen.getByText('v2 of 2')).toBeDefined());
    act(() => {
      selectRange(editorView(), 0, 4);
    });
    await waitFor(() => expect(screen.getByTestId('comment-popover')).toBeDefined());
    fireEvent.click(screen.getByRole('button', { name: 'Previous version' }));
    await waitFor(() => expect(screen.getByText('v1 of 2')).toBeDefined());
    expect(screen.queryByTestId('comment-popover')).toBeNull();
  });
});
