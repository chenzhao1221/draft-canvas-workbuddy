import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { DraftCanvasPanel } from '../src/index';
import { UiFakeHost } from './support/fake-host';

afterEach(cleanup);

const STREAM = '```draft id="d9" title="Live"\nStreaming text here.\n```\n';

function hostWithChat(): UiFakeHost {
  return new UiFakeHost({
    messages: [
      {
        id: 'u1',
        sessionId: 'session-1',
        role: 'user',
        text: 'Write me a draft.',
        createdAt: '2026-01-01T00:00:00.000Z',
        complete: true,
      },
    ],
  });
}

/**
 * Visibility gating (REQ-16.1-16.3). `active === false` means: no streaming preview and no badge, even
 * though the panel stays mounted and keeps its editor; `undefined` counts as visible.
 */
describe('panel visibility', () => {
  it('treats an undefined active flag as visible and shows a streaming preview', async () => {
    const host = hostWithChat();
    render(<DraftCanvasPanel adapter={host} active={undefined} />);

    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    host.emit({ type: 'assistant_chunk', sessionId: 'session-1', messageId: 'm9', delta: STREAM });

    await waitFor(() => expect(screen.getByTestId('streaming-badge')).toBeDefined());
    // The fence is complete in this chunk, so the badge says the version has arrived.
    expect(screen.getByTestId('streaming-badge').textContent).toBe('new version received');
    expect(screen.getByText('Streaming text here.')).toBeDefined();
    expect(screen.getByTestId('draft-canvas-panel').getAttribute('aria-hidden')).toBeNull();
  });

  it('drops the preview and the badge, and hides the root, when active becomes false', async () => {
    const host = hostWithChat();
    const { rerender } = render(<DraftCanvasPanel adapter={host} active />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    host.emit({ type: 'assistant_chunk', sessionId: 'session-1', messageId: 'm9', delta: STREAM });
    await waitFor(() => expect(screen.getByTestId('streaming-badge')).toBeDefined());

    rerender(<DraftCanvasPanel adapter={host} active={false} />);

    await waitFor(() => expect(screen.queryByTestId('streaming-badge')).toBeNull());
    expect(screen.queryByText('Streaming text here.')).toBeNull();
    const root = screen.getByTestId('draft-canvas-panel');
    expect(root.getAttribute('aria-hidden')).toBe('true');
    expect(root.style.display).toBe('none');
  });

  it('ignores chunks that arrive while hidden and does not render them after becoming visible', async () => {
    const host = hostWithChat();
    const { rerender } = render(<DraftCanvasPanel adapter={host} active={false} />);
    await waitFor(() => expect(screen.getByTestId('draft-canvas-panel')).toBeDefined());

    host.emit({ type: 'assistant_chunk', sessionId: 'session-1', messageId: 'm9', delta: STREAM });
    await waitFor(() => expect(screen.getByTestId('draft-canvas-panel').getAttribute('aria-hidden')).toBe('true'));
    expect(screen.queryByTestId('streaming-badge')).toBeNull();

    rerender(<DraftCanvasPanel adapter={host} active />);
    await waitFor(() => expect(screen.getByTestId('draft-canvas-panel').getAttribute('aria-hidden')).toBeNull());
    expect(screen.queryByTestId('streaming-badge')).toBeNull();
    expect(screen.queryByText('Streaming text here.')).toBeNull();
  });
});
