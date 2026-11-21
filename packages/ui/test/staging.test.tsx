import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { DraftState, WorkingCopyStatus } from '@draft-canvas/core';
import { DraftCanvasPanel, LABEL_ADD, LABEL_ALREADY, LABEL_UPDATE, stageButtonState } from '../src/index';
import { appendText, assistantMessage, editorView } from './support/dom';
import { UiFakeHost, draftReply } from './support/fake-host';

afterEach(cleanup);

function draftWith(status: WorkingCopyStatus, draftId = 'd1'): DraftState {
  return { draftId, lang: 'markdown', versions: [], status, editable: true };
}

/**
 * The staging button (design section 5.4, REQ-9). The panel is driven through its real controller and a
 * fake adapter: an edit in the CodeMirror view is what makes a draft `dirty`.
 */
describe('stageButtonState', () => {
  it('offers Add while a draft has unstaged edits', () => {
    expect(stageButtonState([draftWith('dirty')])).toEqual({ label: LABEL_ADD, enabled: true });
  });

  it('offers Update when the message holds an older copy', () => {
    expect(stageButtonState([draftWith('staged-stale')])).toEqual({ label: LABEL_UPDATE, enabled: true });
  });

  it('reports Already and disables the button while the changes are in the message', () => {
    expect(stageButtonState([draftWith('staged')])).toEqual({ label: LABEL_ALREADY, enabled: false });
  });

  it('is disabled when every draft is clean', () => {
    expect(stageButtonState([draftWith('clean'), draftWith('clean', 'd2')])).toEqual({
      label: LABEL_ADD,
      enabled: false,
    });
  });

  it('prefers Add over Update when both states exist across drafts', () => {
    expect(stageButtonState([draftWith('staged-stale', 'd1'), draftWith('dirty', 'd2')])).toEqual({
      label: LABEL_ADD,
      enabled: true,
    });
  });
});

function sendButton(): HTMLButtonElement {
  return screen.getByTestId('send-button') as HTMLButtonElement;
}

async function renderPanelWithDraft(): Promise<UiFakeHost> {
  const host = new UiFakeHost({
    messages: [assistantMessage('a1', ['Here is the draft.', '', draftReply('d1', 'First line.\nSecond line.', 'Letter')].join('\n'))],
  });
  render(<DraftCanvasPanel adapter={host} />);
  await waitFor(() => expect(screen.getByTestId('draft-editor')).toBeDefined());
  return host;
}

describe('panel send button', () => {
  it('is disabled with no edits, sends the edits on click, then says they were sent', async () => {
    const host = await renderPanelWithDraft();
    expect(sendButton().disabled).toBe(true);

    act(() => {
      appendText(editorView(), '\nA line I added.');
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    act(() => {
      fireEvent.click(sendButton());
    });
    await waitFor(() => expect(host.sent).toHaveLength(1));
    expect(host.sent[0]).toContain('```draft-changelog id="d1"');
    expect(host.injected).toHaveLength(0);
    await waitFor(() => expect(screen.getByTestId('status-badge').textContent).toBe('Sent, waiting for a new version'));
    expect(sendButton().disabled).toBe(true);
  });

  it('puts the message in the composer when the host cannot send now', async () => {
    const host = new UiFakeHost({
      messages: [assistantMessage('a1', draftReply('d1', 'First line.'))],
      capabilities: { canSendNow: false },
    });
    render(<DraftCanvasPanel adapter={host} />);
    await waitFor(() => expect(screen.getByTestId('draft-editor')).toBeDefined());
    act(() => {
      appendText(editorView(), '\nMore.');
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));
    fireEvent.click(sendButton());
    await waitFor(() => expect(host.injected).toHaveLength(1));
    expect(host.sent).toHaveLength(0);
  });

  it('discards the working copy after confirmation, back to clean', async () => {
    const host = await renderPanelWithDraft();
    act(() => {
      appendText(editorView(), '\nThrowaway.');
    });
    await waitFor(() => expect(sendButton().disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: 'Discard changes' }));
    fireEvent.click(screen.getByRole('button', { name: 'Yes, discard' }));

    await waitFor(() => expect(sendButton().disabled).toBe(true));
    expect(host.sent).toHaveLength(0);
    expect(host.injected).toHaveLength(0);
  });
});
