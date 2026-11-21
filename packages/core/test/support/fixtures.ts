import { readFileSync } from 'node:fs';

import type { HistoryCompleteness, Message, SearchReplaceBlock } from '../../src/index';

/** Repository fixtures live outside the package: `<repo>/fixtures/conformance/`. */
const FIXTURE_ROOT = new URL('../../../../fixtures/conformance/', import.meta.url);

function readJson<T>(relativePath: string): T {
  return JSON.parse(readFileSync(new URL(relativePath, FIXTURE_ROOT), 'utf8')) as T;
}

export interface ExpectedVersionFixture {
  n: number;
  sourceMessageId: string;
  fenceIndex: number;
  revHint?: string;
  title?: string;
  lang: string;
  body: string;
}

/** One recorded transcript with the versions core must rebuild from it. */
export interface TranscriptFixture {
  name: string;
  description: string;
  sessionId: string;
  completeness: HistoryCompleteness;
  messages: Message[];
  expectedDraftOrder: string[];
  expectedVersions: { draftId: string; versions: ExpectedVersionFixture[] }[];
  /** Draft ids of unclosed fences, in message order. */
  expectedUnclosed: string[];
}

export type ChangelogExpectation = 'changelog' | 'no_changes' | 'marker_conflict';

export interface ChangelogFixtureCase {
  name: string;
  req: string;
  id: string;
  baseVersion: number;
  base: string;
  working: string;
  expect: ChangelogExpectation;
  expectedBlocks?: SearchReplaceBlock[];
  expectedConflict?: { line: string; section: 'search' | 'replace' };
}

export interface RewriteSelectionFixture {
  startLine: number;
  startOffset: number;
  endLine: number;
  endOffset: number;
}

export interface RewriteFixtureCase {
  name: string;
  req: string;
  id: string;
  rev: number;
  body: string;
  selection: RewriteSelectionFixture;
  instruction: string;
  expectedSelection: string;
  expectedFenceLength: number;
  /** Present when the exact message text is normative (AI section 12.3). */
  expectedMessage?: string;
}

export const TRANSCRIPT_NAMES = ['basic', 'edge-cases'] as const;

export type TranscriptName = (typeof TRANSCRIPT_NAMES)[number];

export function loadTranscript(name: TranscriptName): TranscriptFixture {
  return readJson<TranscriptFixture>(`transcripts/${name}.json`);
}

export function allTranscripts(): TranscriptFixture[] {
  return TRANSCRIPT_NAMES.map((name) => loadTranscript(name));
}

export function loadChangelogCases(): ChangelogFixtureCase[] {
  return readJson<{ cases: ChangelogFixtureCase[] }>('changelogs.json').cases;
}

export function loadRewriteCases(): RewriteFixtureCase[] {
  return readJson<{ cases: RewriteFixtureCase[] }>('rewrites.json').cases;
}

/** A deep copy, so tests cannot mutate the shared fixture arrays. */
export function copyMessages(messages: readonly Message[]): Message[] {
  return messages.map((message) => ({ ...message }));
}
