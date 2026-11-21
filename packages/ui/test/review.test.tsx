import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { ReactElement } from 'react';
import { DraftSessionController, type DraftState } from '@draft-canvas/core';
// ReviewView is not part of the package's public API; the test uses the component module directly.
import { ReviewView } from '../src/ReviewView';
import { assistantMessage } from './support/dom';
import { UiFakeHost, draftReply } from './support/fake-host';

afterEach(cleanup);

const V1 = 'Line one.\nOld middle.\nKeep this.\nOld tail.';
const V2 = 'Line one.\nNew middle.\nKeep this.\nNew tail.';

async function openReview(): Promise<{ controller: DraftSessionController; draft: () => DraftState }> {
  const host = new UiFakeHost({
    messages: [assistantMessage('a1', draftReply('d1', V1)), assistantMessage('a2', draftReply('d1', V2))],
  });
  const controller = new DraftSessionController({ adapter: host });
  await controller.start();
  expect(controller.openReview('d1')).toBe(true);
  return {
    controller,
    draft: () => {
      const draft = controller.getSnapshot()?.drafts.find((d) => d.draftId === 'd1');
      if (draft === undefined) throw new Error('draft d1 is missing');
      return draft;
    },
  };
}

function Harness({
  controller,
  onChange,
}: {
  controller: DraftSessionController;
  onChange: () => void;
}): ReactElement {
  const draft = controller.getSnapshot()?.drafts.find((d) => d.draftId === 'd1');
  const review = draft?.review;
  if (review === undefined) return <div data-testid="no-review" />;
  return (
    <ReviewView
      review={review}
      onDecision={(index, decision) => {
        controller.setReviewDecision('d1', index, decision);
        onChange();
      }}
      onDecideAll={(decision) => {
        controller.setAllReviewDecisions('d1', decision);
        onChange();
      }}
      onDone={() => {
        controller.finishReview('d1');
        onChange();
      }}
      onCancel={() => {
        controller.cancelReview('d1');
        onChange();
      }}
    />
  );
}

/** Renders the review and re-renders it after every controller change, as the panel's subscription does. */
function renderReview(controller: DraftSessionController): ReturnType<typeof render> {
  const onChange = (): void => {
    result.rerender(<Harness controller={controller} onChange={onChange} />);
  };
  const result = render(<Harness controller={controller} onChange={onChange} />);
  return result;
}

/**
 * Review resolution (REQ-13.3, 13.4). The component drives the real controller, so Accept then Done is the
 * same path the panel uses: the result becomes a working copy against the latest version.
 */
describe('ReviewView', () => {
  it('lists every change with its position', async () => {
    const { controller, draft } = await openReview();
    expect(draft().review?.hunks).toHaveLength(2);

    const { unmount } = renderReview(controller);
    expect(screen.getAllByTestId('review-hunk')).toHaveLength(2);
    expect(screen.getByText('Change 1 of 2')).toBeDefined();
    expect(screen.getByText('Change 2 of 2')).toBeDefined();
    unmount();
  });

  it('accepting everything leaves no working copy', async () => {
    const { controller, draft } = await openReview();
    const { unmount } = renderReview(controller);

    fireEvent.click(screen.getByRole('button', { name: 'Accept all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(draft().review).toBeUndefined();
    expect(draft().workingCopy).toBeUndefined();
    expect(draft().status).toBe('clean');
    unmount();
  });

  it('keeps the user text for rejected hunks', async () => {
    const { controller, draft } = await openReview();
    const { unmount } = renderReview(controller);

    fireEvent.click(screen.getByRole('button', { name: 'Reject all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    expect(draft().workingCopy?.text).toBe(V1);
    expect(draft().status).toBe('dirty');
    unmount();
  });

  it('mixes decisions per hunk and leaves undecided changes as the user wrote them', async () => {
    const { controller, draft } = await openReview();
    const { unmount } = renderReview(controller);

    const acceptButtons = screen.getAllByRole('button', { name: 'Accept' });
    expect(acceptButtons).toHaveLength(2);
    fireEvent.click(acceptButtons[1] as HTMLElement);
    expect((acceptButtons[1] as HTMLElement).getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));

    const text = draft().workingCopy?.text ?? '';
    expect(text).toContain('Old middle.'); // left undecided: the user's text is kept
    expect(text).toContain('New tail.'); // accepted
    unmount();
  });

  it('toggles a rejection off and leaves the draft untouched on Cancel', async () => {
    const { controller, draft } = await openReview();
    const { unmount } = renderReview(controller);

    const reject = screen.getAllByRole('button', { name: 'Reject' })[0] as HTMLElement;
    fireEvent.click(reject);
    expect(reject.getAttribute('aria-pressed')).toBe('true');
    fireEvent.click(reject);
    expect(reject.getAttribute('aria-pressed')).toBe('false');

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(draft().review).toBeUndefined();
    expect(draft().workingCopy).toBeUndefined();
    unmount();
  });
});
