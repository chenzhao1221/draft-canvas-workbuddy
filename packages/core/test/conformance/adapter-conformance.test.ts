import { describe, expect, it } from 'vitest';

import { FakeHost, FakeHostStorage } from '../support/fake-host';
import { allTranscripts, loadChangelogCases, loadRewriteCases } from '../support/fixtures';
import { runConformanceSuite, type ConformanceDriver, type ConformanceSession, type ConformanceSetup } from './harness';

/**
 * T-23: runs the AI section 19 checklist against the in-memory fake host.
 *
 * The same suite is meant for real adapters (OpenCode, DeepSeek Harness,
 * CodeBuddy, Kiro Crew). See fixtures/conformance/README.md.
 */

const SESSION = 'conformance-session';

function fakeSession(setup: ConformanceSetup = {}): ConformanceSession {
  const sessionId = setup.sessionId ?? SESSION;
  const host = new FakeHost({
    sessionId,
    messages: setup.messages ?? [],
    capabilities: setup.capabilities,
    storage: new FakeHostStorage(),
  });
  const driver: ConformanceDriver = {
    assistantChunks: (messageId, delta) => host.streamChunk(messageId, delta),
    assistantDone: (message) => host.deliverAssistantDone(message),
    userMessage: (message) => host.deliverUserMessage(message),
    connection: (state) => host.setConnection(state),
    historyReset: (id) => host.emitHistoryReset(id),
    setHistory: (id, messages) => host.setMessages(id, messages),
    composer: () => host.composer,
    setComposer: (text) => host.setComposer(text),
  };
  return { adapter: host, driver };
}

function oversizedSession(bytes: number): ConformanceSession {
  return fakeSession({ capabilities: { maxInjectBytes: bytes } });
}

runConformanceSuite({
  name: 'in-memory fake host',
  create: fakeSession,
  createOversized: oversizedSession,
  hostDocumented: {
    'reload-test':
      'Not applicable to the in-memory fake host: there is no real host to reload. The fake composer is persisted by construction, so fidelity "persisted" and requiresUserSend true are true by definition. A real adapter must record its AI 8.1 result, host version and date here.',
    'composer-separation': 'Covered by the fake composer probe in the injection tests.',
    'oversized-injection': 'Covered by the fake maxInjectBytes cap (payload_too_large).',
  },
  transcripts: allTranscripts(),
  changelogCases: loadChangelogCases(),
  rewriteCases: loadRewriteCases(),
});

describe('conformance fixtures', () => {
  it('every transcript declares the same session id in all of its messages', () => {
    for (const fixture of allTranscripts()) {
      for (const message of fixture.messages) {
        expect(message.sessionId).toBe(fixture.sessionId);
      }
    }
  });

  it('every changelog case names the requirement it checks', () => {
    for (const testCase of loadChangelogCases()) {
      expect(testCase.req).toMatch(/REQ-\d+(\.\d+)?/);
    }
  });

  it('every rewrite case names the requirement it checks', () => {
    for (const testCase of loadRewriteCases()) {
      expect(testCase.req).toMatch(/REQ-\d+(\.\d+)?/);
    }
  });
});
