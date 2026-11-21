import { describe, expect, it } from 'vitest';

import {
  DEFAULT_DRAFT_ID,
  escapeAttrValue,
  fenceLengthFor,
  formatAttrs,
  formatChangelogFence,
  formatDraftFence,
  formatRewriteMessage,
  isValidDraftId,
  parseAttrs,
  parseChangelogFences,
  parseDraftFences,
  parseRewriteFences,
  scanFences,
} from '../src/index';

/**
 * T-22: draft fence scanning, attributes, parsing and generation.
 * Every test names the requirement it checks (requirements.md REQ-1, REQ-3).
 */

function draft(text: string, attrs = 'id="d"'): string {
  return `\`\`\`draft ${attrs}\n${text}\n\`\`\``;
}

describe('REQ-1.5 fence length and closing', () => {
  it('REQ-1.5 accepts opening fences of 3 or more backticks and closes at >= opening', () => {
    const text = ['````draft id="long"', 'line one', '```sh', 'npm test', '```', 'line two', '````'].join('\n');
    const [fence] = parseDraftFences(text);
    expect(fence).toBeDefined();
    expect(fence?.fenceLength).toBe(4);
    expect(fence?.closed).toBe(true);
    expect(fence?.body).toBe('line one\n```sh\nnpm test\n```\nline two');
  });

  it('REQ-1.5 treats inner backtick runs shorter than the opener as body content', () => {
    const text = ['`````draft id="five"', '````', '```', 'text', '`````'].join('\n');
    const [fence] = parseDraftFences(text);
    expect(fence?.fenceLength).toBe(5);
    expect(fence?.body).toBe('````\n```\ntext');
  });

  it('REQ-1.5 closes a three-backtick fence at a longer closing run', () => {
    const text = ['```draft id="short"', 'body', '````', 'after'].join('\n');
    const fences = parseDraftFences(text);
    expect(fences).toHaveLength(1);
    expect(fences[0]?.body).toBe('body');
    expect(fences[0]?.closed).toBe(true);
  });

  it('REQ-1.5 does not close on a line with trailing text after the backticks', () => {
    const text = ['```draft id="a"', 'body', '``` trailing', 'still body', '```'].join('\n');
    const [fence] = parseDraftFences(text);
    expect(fence?.body).toBe('body\n``` trailing\nstill body');
  });

  it('REQ-1.5 closes on backticks followed only by whitespace', () => {
    const text = ['```draft id="a"', 'body', '```   ', 'after'].join('\n');
    const [fence] = parseDraftFences(text);
    expect(fence?.closed).toBe(true);
    expect(fence?.body).toBe('body');
  });
});

describe('REQ-1.3 top-level fences only', () => {
  it('REQ-1.3 ignores a draft opener inside another backtick block', () => {
    const text = ['````text', '```draft id="nested"', 'not a draft', '```', '````', '', draft('real', 'id="real"')].join('\n');
    const fences = parseDraftFences(text);
    expect(fences.map((f) => f.id)).toEqual(['real']);
  });

  it('REQ-1.3 ignores a draft opener inside a tilde block', () => {
    const text = ['~~~text', '```draft id="tilde"', 'content', '```', '~~~'].join('\n');
    expect(parseDraftFences(text)).toEqual([]);
    expect(scanFences(text)).toEqual([]);
  });

  it('REQ-1.3 ignores a draft opener inside a block quote', () => {
    const text = ['> ```draft id="quoted"', '> content', '> ```'].join('\n');
    expect(parseDraftFences(text)).toEqual([]);
  });

  it('REQ-1.3 ignores a draft opener indented by 4 or more spaces', () => {
    const text = ['    ```draft id="indented"', '    content', '    ```'].join('\n');
    expect(parseDraftFences(text)).toEqual([]);
  });

  // Known gap (reported, not fixed): the scanner is line based and has no list
  // parser, so a fence indented 0-3 spaces as list-item content is treated as a
  // top-level fence. requirements.md REQ-1.3 and ADAPTER_INTERFACE 10.1 rule 1
  // say fences inside list items are not recognized.
  it('REQ-1.3 ignores a draft opener inside a list item [known gap: REQ-1.3]', () => {
    const text = ['- Here is the draft:', '', '  ```draft id="list-item"', '  Inside a list item.', '  ```'].join('\n');
    expect(parseDraftFences(text)).toEqual([]);
  });

  it('REQ-1.5 keeps an indented opener body aligned with the opener indent', () => {
    const text = ['  ```draft id="indented-ok"', '  first', '   second', '  ```'].join('\n');
    const [fence] = parseDraftFences(text);
    // Up to the opener indent (2) is stripped from each body line (AI 10.1 rule 3).
    expect(fence?.body).toBe('first\n second');
  });
});

describe('REQ-1.4 missing ids get an auto id, invalid ids are ignored', () => {
  it('REQ-1.4 gives a fence without an id the auto id draft-1', () => {
    const [fence] = parseDraftFences('```draft\nbody\n```');
    expect(fence?.id).toBe(DEFAULT_DRAFT_ID);
    expect(fence?.id).toBe('draft-1');
    expect(isValidDraftId(fence?.id)).toBe(true);
    expect(fence?.closed).toBe(true);
    expect(fence?.lang).toBe('markdown');
    expect(fence?.body).toBe('body');
  });

  it('REQ-1.4 gives a fence with only other attributes the auto id', () => {
    expect(parseDraftFences('```draft title="Letter" lang="text"\nbody\n```')[0]?.id).toBe('draft-1');
  });

  it('REQ-1.4 keeps an explicit id as its own id', () => {
    expect(parseDraftFences(draft('body', 'id="foo"'))[0]?.id).toBe('foo');
  });

  it('REQ-1.4 ignores an explicit id whose value is malformed (not an id-less fence)', () => {
    expect(parseDraftFences('```draft id="unclosed\nbody\n```')).toEqual([]);
    expect(parseDraftFences('```draft id=bad/id\nbody\n```')).toEqual([]);
  });

  it('REQ-1.4 ignores ids that do not match the id pattern', () => {
    for (const id of ['bad id!', '', '-starts-with-dash', 'has/slash']) {
      expect(parseDraftFences(draft('body', `id="${id}"`))).toEqual([]);
    }
  });

  it('REQ-1.4 accepts leading letters and digits and the . _ - characters', () => {
    expect(isValidDraftId('A1.b_c-d')).toBe(true);
    expect(isValidDraftId('1')).toBe(true);
    expect(isValidDraftId('_leading')).toBe(false);
  });
});

describe('REQ-1.5 / REQ-1.6 / REQ-1.7 body, line endings and language', () => {
  it('REQ-1.5 marks an unclosed fence and runs it to the end of the message', () => {
    const [fence] = parseDraftFences('intro\n```draft id="open"\nline one\nline two');
    expect(fence?.closed).toBe(false);
    expect(fence?.body).toBe('line one\nline two');
  });

  it('REQ-1.5 does not include the trailing newline in an unclosed body', () => {
    const [fence] = parseDraftFences('```draft id="open"\nline one\n');
    expect(fence?.closed).toBe(false);
    expect(fence?.body).toBe('line one');
  });

  it('REQ-1.6 normalizes CRLF and lone CR before parsing', () => {
    const text = 'before\r\n```draft id="crlf"\r\nfirst\r\nsecond\r\n```\r\nafter';
    const [fence] = parseDraftFences(text);
    expect(fence?.body).toBe('first\nsecond');
    const loneCr = '```draft id="cr"\rfirst\rsecond\r```';
    expect(parseDraftFences(loneCr)[0]?.body).toBe('first\nsecond');
  });

  it('REQ-1.7 defaults lang to markdown and keeps an explicit language', () => {
    expect(parseDraftFences(draft('x'))[0]?.lang).toBe('markdown');
    expect(parseDraftFences(draft('x', 'id="a" lang="text"'))[0]?.lang).toBe('text');
    expect(parseDraftFences(draft('x', 'id="a" lang="typescript"'))[0]?.lang).toBe('typescript');
  });
});

describe('REQ-1.5 attributes (AI 10.1 rule 5)', () => {
  it('REQ-1.5 reads quoted values with \\" and \\\\ escapes, bare values and unknown keys', () => {
    const attrs = parseAttrs('id="a" rev=7 title="He said \\"hi\\" at C:\\\\tmp" lang=text unknown=bare');
    expect(attrs['id']).toBe('a');
    expect(attrs['rev']).toBe('7');
    expect(attrs['title']).toBe('He said "hi" at C:\\tmp');
    expect(attrs['lang']).toBe('text');
    expect(attrs['unknown']).toBe('bare');
  });

  it('REQ-1.5 keeps the last value when a key repeats', () => {
    expect(parseAttrs('id="first" id="second"').id).toBe('second');
    expect(parseDraftFences(draft('body', 'id="first" id="second"'))[0]?.id).toBe('second');
  });

  it('REQ-1.5 ignores tokens that are not valid attributes', () => {
    const attrs = parseAttrs('id="a" broken 9bad=x =oops rev="1');
    expect(attrs['id']).toBe('a');
    expect(attrs['9bad']).toBeUndefined();
    expect(attrs['rev']).toBeUndefined();
  });

  it('REQ-1.5 rejects quoted values containing a backtick or another escape', () => {
    expect(parseAttrs('id="a`b"').id).toBeUndefined();
    expect(parseAttrs('id="a\\nb"').id).toBeUndefined();
  });

  it('REQ-1.5 ignores unknown kinds such as Draft and draftx', () => {
    expect(parseDraftFences('```Draft id="upper"\nbody\n```')).toEqual([]);
    expect(parseDraftFences('```draftx id="suffix"\nbody\n```')).toEqual([]);
  });

  it('REQ-1.8 skips malformed fences without throwing and keeps the rest of the message', () => {
    const text = ['```draft id="unclosed-quote', 'body', '```', '', draft('good', 'id="good"')].join('\n');
    expect(() => parseDraftFences(text)).not.toThrow();
    expect(parseDraftFences(text).map((f) => f.id)).toEqual(['good']);
  });
});

describe('REQ-2.1 / REQ-3.1 repeated ids and round trips', () => {
  it('REQ-2.1 returns every fence of a repeated id in message order with a stable fenceIndex', () => {
    const text = [
      '```draft id="same"\nfirst\n```',
      '```draft id="other"\nother\n```',
      '```draft id="same"\nsecond\n```',
    ].join('\n\n');
    const fences = parseDraftFences(text);
    expect(fences.map((f) => [f.id, f.fenceIndex, f.body])).toEqual([
      ['same', 0, 'first'],
      ['other', 1, 'other'],
      ['same', 2, 'second'],
    ]);
  });

  it('REQ-3.1 round-trips a draft fence with a code block through generation and parsing', () => {
    const input = {
      id: 'rt',
      rev: '3',
      title: 'He said "hi"',
      lang: 'text',
      body: 'Intro\n```sh\nnpm test\n```\nDone',
    };
    const text = formatDraftFence(input);
    expect(text.startsWith('````draft ')).toBe(true);
    const [fence] = parseDraftFences(text);
    expect(fence).toMatchObject({
      id: input.id,
      rev: input.rev,
      title: input.title,
      lang: input.lang,
      body: input.body,
      closed: true,
      fenceLength: 4,
    });
  });

  it('REQ-3.1 round-trips a changelog fence', () => {
    const text = formatChangelogFence({
      id: 'trip-note',
      from: 2,
      to: 3,
      blocks: [{ search: 'old', replace: 'new' }],
    });
    expect(parseChangelogFences(text)).toEqual([
      { id: 'trip-note', from: 2, to: 3, blocks: [{ search: 'old', replace: 'new' }] },
    ]);
  });

  it('REQ-3.1 round-trips a rewrite message including the instruction', () => {
    const text = formatRewriteMessage({
      id: 'essay-main',
      rev: 3,
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: 4,
      selection: '起步 🚀',
      instruction: 'Make it friendlier.',
    });
    const [request] = parseRewriteFences(text);
    expect(request).toEqual({
      id: 'essay-main',
      rev: 3,
      startLine: 1,
      endLine: 1,
      startOffset: 0,
      endOffset: 4,
      selection: '起步 🚀',
      instruction: 'Make it friendlier.',
    });
  });

  it('REQ-3.1 writes an empty draft body as zero lines between the fences', () => {
    const text = formatDraftFence({ id: 'empty', body: '' });
    expect(text).toBe('```draft id="empty" lang="markdown"\n```');
    expect(parseDraftFences(text)[0]?.body).toBe('');
    expect(parseDraftFences(text)[0]?.closed).toBe(true);
  });
});

describe('REQ-3.2 fence length rule (AI 10.4)', () => {
  it('REQ-3.2 uses max(3, 1 + longest body line backtick run after 0-3 spaces)', () => {
    expect(fenceLengthFor('plain text')).toBe(3);
    expect(fenceLengthFor('```sh')).toBe(4);
    expect(fenceLengthFor('  ````')).toBe(5);
    expect(fenceLengthFor('    ```')).toBe(3);
    expect(fenceLengthFor('text ``` middle')).toBe(3);
    expect(fenceLengthFor('a\n`````\nb')).toBe(6);
    expect(fenceLengthFor('`````\n```\n````')).toBe(6);
  });

  it('REQ-3.2 wraps a body containing a code fence in four or more backticks', () => {
    const text = formatDraftFence({ id: 'code', body: 'Before\n```js\nx\n```\nAfter' });
    expect(/^````draft /.test(text)).toBe(true);
    expect(parseDraftFences(text)[0]?.body).toBe('Before\n```js\nx\n```\nAfter');
  });
});

describe('REQ-3.3 attribute escaping', () => {
  it('REQ-3.3 escapes quotes and backslashes', () => {
    expect(escapeAttrValue('say "hi"')).toBe('say \\"hi\\"');
    expect(escapeAttrValue('C:\\tmp')).toBe('C:\\\\tmp');
  });

  it('REQ-3.3 replaces backticks with a quote and line breaks with a space', () => {
    expect(escapeAttrValue('a`b')).toBe("a'b");
    expect(escapeAttrValue('line one\nline two')).toBe('line one line two');
    expect(escapeAttrValue('crlf\r\nline')).toBe('crlf line');
  });

  it('REQ-3.3 quotes every value and skips undefined and invalid keys', () => {
    expect(formatAttrs({ id: 'x', rev: undefined })).toBe(' id="x"');
    expect(formatAttrs({ id: 'x', title: 'a"b' })).toBe(' id="x" title="a\\"b"');
    expect(formatAttrs({ 'not-a-key': 'x' })).toBe('');
  });

  it('REQ-3.3 produces attributes its own parser reads back to the same values', () => {
    const title = 'He said "hi" \\ C:\\tmp`end';
    const text = formatDraftFence({ id: 'esc', title, body: 'body' });
    expect(parseDraftFences(text)[0]?.title).toBe('He said "hi" \\ C:\\tmp\'end');
  });
});
