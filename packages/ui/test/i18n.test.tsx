import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DraftSessionController, HostAdapterError } from '@draft-canvas/core';
import {
  DEFAULT_TEXT_STYLE,
  DraftCanvasPanel,
  LABEL_ADD,
  createI18n,
  localeFromTag,
  parseLocale,
  parseTextStyle,
  resolveLocale,
  serializeTextStyle,
  stageButtonState,
  type TextStyle,
} from '../src/index';
import { I18nContext, messageTable, type MessageKey } from '../src/i18n';
import { ReviewView } from '../src/ReviewView';
import { CommentPopover } from '../src/CommentPopover';
import { appendText, assistantMessage, editorView } from './support/dom';
import { UiFakeHost, draftReply } from './support/fake-host';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe('localeFromTag', () => {
  it.each(['zh', 'zh-CN', 'zh-cn', 'zh_CN', 'zh-Hans', 'zh-Hans-CN', 'zh-Hans-SG', 'zh-SG', 'ZH-hans'])(
    'treats %s as Simplified Chinese',
    (tag) => {
      expect(localeFromTag(tag)).toBe('zh-CN');
    },
  );

  it.each(['zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant', 'zh-Hant-TW', 'zh-Hant-HK'])('uses the Chinese table for %s', (tag) => {
    expect(localeFromTag(tag)).toBe('zh-CN');
  });

  it('ignores extension subtags', () => {
    expect(localeFromTag('zh-u-ca-chinese')).toBe('zh-CN');
    expect(localeFromTag('zh-TW-u-ca-chinese')).toBe('zh-CN');
  });

  it('knows English and has no opinion on other languages', () => {
    expect(localeFromTag('en-US')).toBe('en');
    expect(localeFromTag('fr-FR')).toBeNull();
    expect(localeFromTag('')).toBeNull();
  });
});

describe('resolveLocale', () => {
  const noDoc = { documentLang: null };

  it('defaults to English without any language information', () => {
    expect(resolveLocale({ navigator: null, ...noDoc })).toBe('en');
    expect(resolveLocale({ navigator: {}, ...noDoc })).toBe('en');
    expect(resolveLocale({ navigator: { language: 'fr-FR', languages: ['fr-FR', 'de'] }, ...noDoc })).toBe('en');
  });

  it('uses navigator.languages, then navigator.language', () => {
    expect(resolveLocale({ navigator: { language: 'en-US', languages: ['zh-CN', 'en-US'] }, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'zh-CN' }, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'zh-Hans-CN', languages: [] }, ...noDoc })).toBe('zh-CN');
  });

  it('picks Chinese when any navigator.languages tag is zh*, even if navigator.language is en', () => {
    expect(resolveLocale({ navigator: { language: 'en', languages: ['en', 'zh-CN'] }, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'en-US', languages: ['en-US', 'en', 'zh-TW'] }, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'en', languages: ['en-GB', 'fr', 'zh-Hant'] }, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'en', languages: ['en', 'zh-HK'] }, ...noDoc })).toBe('zh-CN');
  });

  it('treats Traditional Chinese as Chinese', () => {
    expect(resolveLocale({ navigator: { language: 'zh-TW', languages: ['zh-TW'] }, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'zh-Hant' }, ...noDoc })).toBe('zh-CN');
  });

  it('prefers an explicit host language over the browser', () => {
    const browser = { language: 'en-US', languages: ['en-US'] };
    expect(resolveLocale({ preferred: 'zh-CN', navigator: browser, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ preferred: ['zh-Hans'], navigator: browser, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ preferred: 'en', navigator: { language: 'zh-CN' }, ...noDoc })).toBe('en');
  });

  it('falls through to the browser when the host language is unsupported or empty', () => {
    const browser = { language: 'zh-CN', languages: ['zh-CN'] };
    expect(resolveLocale({ preferred: 'fr', navigator: browser, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ preferred: null, navigator: browser, ...noDoc })).toBe('zh-CN');
    expect(resolveLocale({ preferred: [], navigator: browser, ...noDoc })).toBe('zh-CN');
  });

  it('lets the stored choice win over the host language, the browser and the document', () => {
    const zhBrowser = { language: 'zh-CN', languages: ['zh-CN'] };
    expect(resolveLocale({ stored: 'en', preferred: 'zh-CN', navigator: zhBrowser, documentLang: 'zh-CN' })).toBe('en');
    expect(resolveLocale({ stored: 'zh-CN', preferred: 'en', navigator: { language: 'en' }, documentLang: 'en' })).toBe('zh-CN');
    expect(resolveLocale({ stored: null, navigator: zhBrowser, ...noDoc })).toBe('zh-CN');
  });

  it('falls back to a Chinese document language when the browser says nothing about Chinese', () => {
    expect(resolveLocale({ navigator: { language: 'en', languages: ['en'] }, documentLang: 'zh-CN' })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'en', languages: ['en'] }, documentLang: 'zh-Hant-TW' })).toBe('zh-CN');
    expect(resolveLocale({ navigator: { language: 'en', languages: ['en'] }, documentLang: 'en-US' })).toBe('en');
    expect(resolveLocale({ navigator: { language: 'en' }, documentLang: '' })).toBe('en');
  });

  it('reads the global navigator and document when none are injected', () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en', 'zh-CN']);
    expect(resolveLocale()).toBe('zh-CN');

    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en']);
    expect(resolveLocale()).toBe('en');
    document.documentElement.lang = 'zh-CN';
    try {
      expect(resolveLocale()).toBe('zh-CN');
    } finally {
      document.documentElement.removeAttribute('lang');
    }
  });
});

describe('parseLocale', () => {
  it('accepts only the two known locales', () => {
    expect(parseLocale('en')).toBe('en');
    expect(parseLocale('zh-CN')).toBe('zh-CN');
    expect(parseLocale('zh')).toBeNull();
    expect(parseLocale('')).toBeNull();
    expect(parseLocale(null)).toBeNull();
    expect(parseLocale(42)).toBeNull();
  });
});

describe('string tables', () => {
  const en = messageTable('en');
  const zh = messageTable('zh-CN');
  const placeholders = (text: string): string[] => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1] ?? '').sort();

  it('translates every key and keeps the same placeholders', () => {
    for (const key of Object.keys(en) as MessageKey[]) {
      expect(zh[key], key).toBeTruthy();
      expect(placeholders(zh[key]), key).toEqual(placeholders(en[key]));
    }
  });

  it('has the key zh-CN strings', () => {
    const { t } = createI18n('zh-CN');
    expect(t('stage.add')).toBe('把修改加入我的消息');
    expect(t('stage.update')).toBe('更新我消息中的修改');
    expect(t('stage.already')).toBe('已在你的消息中');
    expect(t('rewrite.send')).toBe('发送');
    expect(t('version.label', { n: 2, total: 5 })).toBe('第 2 版，共 5 版');
    expect(t('banner.connecting', { host: 'Kiro Crew' })).toBe('正在连接 Kiro Crew…');
  });

  it('keeps the English labels as the default', () => {
    const { t } = createI18n('en');
    expect(t('stage.add')).toBe(LABEL_ADD);
    expect(t('stage.update')).toBe('Update changes in my message');
    expect(t('stage.already')).toBe('Already in your message');
    expect(stageButtonState([]).label).toBe('Add changes to my message');
  });
});

describe('core message translation', () => {
  const zh = createI18n('zh-CN');
  const en = createI18n('en');

  it('translates the messages core produces', () => {
    expect(zh.msg('There are no changes to add.')).toBe('没有可添加的修改。');
    expect(zh.msg('Rewrite request sent.')).toBe('改写请求已发送。');
    expect(zh.msg('Added to your message. Send it in the chat when ready.')).toBe('已加入你的消息。准备好后请在对话中发送。');
    expect(zh.msg('Too large to send.')).toBe('内容过大，无法发送。');
    expect(zh.msg('Too large to send. Select a shorter passage.')).toBe('内容过大，无法发送。请选择更短的一段。');
    expect(zh.msg('Your changes')).toBe('你的修改');
    expect(zh.msg('Version 3')).toBe('第 3 版');
  });

  it('keeps the dynamic part of a message', () => {
    expect(zh.msg('Draft "letter" was not finished and was not saved.')).toBe('草稿“letter”没有写完，未被保存。');
    expect(zh.msg('The reply did not contain a new version of "letter".')).toBe('回复中没有“letter”的新版本。');
    expect(zh.msg('Could not save your changes (kept in memory): quota exceeded')).toBe(
      '无法保存你的修改（已暂存在内存中）：quota exceeded',
    );
    expect(
      zh.msg(
        'The line "====" would appear in the SEARCH part of the changelog and cannot be expressed there. Change that line (for example, write a Setext underline with a different number of "=" characters, or use a "#" heading) and try again.',
      ),
    ).toContain('这一行“====”会出现在修改记录的 SEARCH 部分');
  });

  it('leaves text from the host and unknown text unchanged', () => {
    expect(zh.msg('HTTP 403')).toBe('HTTP 403');
    expect(zh.msg('Kiro Crew request failed')).toBe('Kiro Crew request failed');
  });

  it('is the identity in English', () => {
    expect(en.msg('There are no changes to add.')).toBe('There are no changes to add.');
    expect(en.msg('HTTP 403')).toBe('HTTP 403');
  });
});

describe('panel in Chinese', () => {
  it('shows the empty state and the open hint in zh-CN when asked', async () => {
    const host = new UiFakeHost();
    render(<DraftCanvasPanel adapter={host} locale="zh-CN" openHint="请从聊天侧边栏的 + 菜单中打开 Draft Canvas。" />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    const empty = screen.getByTestId('empty-state').textContent ?? '';
    expect(empty).toContain('还没有草稿');
    expect(empty).toContain('请让智能体写一份草稿');
    expect(screen.getByTestId('draft-canvas-panel').getAttribute('lang')).toBe('zh-CN');
  });

  it('shows the send button, status and pager in zh-CN', async () => {
    const host = new UiFakeHost({
      messages: [assistantMessage('a1', draftReply('d1', 'First line.\nSecond line.', 'Letter'))],
    });
    render(<DraftCanvasPanel adapter={host} locale="zh-CN" />);
    await waitFor(() => expect(screen.getByTestId('draft-editor')).toBeDefined());

    expect(screen.getByTestId('version-label').textContent).toBe('第 1 版，共 1 版');
    const button = screen.getByRole('button', { name: '发给 AI' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(screen.getByTestId('send-nothing').textContent).toBe('没有改动');

    act(() => {
      appendText(editorView(), '\nA line I added.');
    });
    await waitFor(() => expect(button.disabled).toBe(false));
    expect(screen.getByTestId('status-badge').textContent).toBe('有未发送的修改');
    expect(screen.getByRole('button', { name: '放弃修改' })).toBeDefined();

    fireEvent.click(button);
    await waitFor(() => expect(screen.getByTestId('status-badge').textContent).toBe('已发送，等待新版本'));
    // The send result comes from core in English and is translated for display.
    expect(screen.getByTestId('staging-bar').textContent).toContain('已发送到对话');
  });

  it('follows the browser language when no locale is passed', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('zh-CN');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['zh-CN', 'en']);
    render(<DraftCanvasPanel adapter={new UiFakeHost()} />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿');
  });

  it('uses Chinese for Traditional Chinese browsers', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('zh-TW');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['zh-TW']);
    render(<DraftCanvasPanel adapter={new UiFakeHost()} />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿');
    expect(screen.getByTestId('draft-canvas-panel').getAttribute('lang')).toBe('zh-CN');
  });

  it('uses Chinese when navigator.languages has a zh tag but navigator.language is en', async () => {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue('en');
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(['en', 'zh-CN']);
    render(<DraftCanvasPanel adapter={new UiFakeHost()} />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿');
  });

  it('is English by default in jsdom', async () => {
    render(<DraftCanvasPanel adapter={new UiFakeHost()} />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.getByTestId('empty-state').textContent).toContain('No drafts yet');
  });

  it('closes the history-window banner for good and shows notices above the editor (0.1.11)', async () => {
    const saved: string[] = [];
    const host = new UiFakeHost({ messages: [assistantMessage('a1', draftReply('d1', 'Text.'))] });
    (host as unknown as { getHistory: UiFakeHost['getHistory'] }).getHistory = async () => ({
      messages: [assistantMessage('a1', draftReply('d1', 'Text.'))],
      completeness: 'window',
    });
    render(<DraftCanvasPanel adapter={host} onDismissedBannersChange={(json) => saved.push(json)} />);
    await waitFor(() => expect(screen.getByText(/Only part of this chat's history is available/)).toBeDefined());
    const banner = screen.getByText(/Only part of this chat's history is available/).closest('div') as HTMLElement;
    fireEvent.click(within(banner).getByRole('button', { name: 'Dismiss' }));
    await waitFor(() => expect(screen.queryByText(/Only part of this chat's history is available/)).toBeNull());
    expect(saved.at(-1)).toBe('["window"]');
  });

  it('keeps a closed banner closed on the next mount', async () => {
    const host = new UiFakeHost({ messages: [assistantMessage('a1', draftReply('d1', 'Text.'))], capabilities: {} });
    render(<DraftCanvasPanel adapter={host} storedDismissedBanners='["fidelity"]' />);
    await waitFor(() => expect(screen.getByTestId('draft-editor')).toBeDefined());
    expect(screen.queryByText(/Your changes go to the agent when you send your message/)).toBeNull();
  });

  it('warns that new replies will not show up when the host says live updates are off', async () => {
    render(<DraftCanvasPanel adapter={new UiFakeHost()} locale="zh-CN" liveUpdates={false} />);
    await waitFor(() => expect(screen.getByTestId('no-live-updates')).toBeDefined());
    expect(screen.getByTestId('no-live-updates').textContent).toContain('新回复不会自动显示');
  });

  it('asks for the permission grant instead of showing "no drafts" when the host refuses', async () => {
    class DeniedHost extends UiFakeHost {
      override async getActiveSession(): Promise<never> {
        throw new HostAdapterError('permission_denied', 'not permitted');
      }
      override async listSessions(): Promise<never> {
        throw new HostAdapterError('permission_denied', 'not permitted');
      }
    }
    render(<DraftCanvasPanel adapter={new DeniedHost()} locale="zh-CN" />);
    await waitFor(() => expect(screen.getByTestId('permission-needed')).toBeDefined());
    expect(screen.getByTestId('permission-needed').textContent).toContain('批准它的权限');
    expect(screen.queryByTestId('empty-state')).toBeNull();
    expect(screen.queryByTestId('no-session')).toBeNull();
  });
});

describe('text size and font', () => {
  it('changes the editor variables, clamps the size and reports each change', async () => {
    const changes: TextStyle[] = [];
    render(
      <DraftCanvasPanel
        adapter={new UiFakeHost()}
        locale="zh-CN"
        storedTextStyle={JSON.stringify({ size: 23, font: 'mono' })}
        onTextStyleChange={(s) => changes.push(s)}
      />,
    );
    await waitFor(() => expect(screen.getByTestId('settings-button')).toBeDefined());
    fireEvent.click(screen.getByTestId('settings-button'));
    expect(screen.getByTestId('text-style')).toBeDefined();
    const root = screen.getByTestId('draft-canvas-panel');
    expect(root.style.getPropertyValue('--dc-editor-font-size')).toBe('23px');

    const larger = screen.getByRole('button', { name: '放大字号' }) as HTMLButtonElement;
    fireEvent.click(larger);
    expect(root.style.getPropertyValue('--dc-editor-font-size')).toBe('24px');
    expect(larger.disabled).toBe(true);

    fireEvent.change(screen.getByTestId('text-font'), { target: { value: 'kai' } });
    expect(root.style.getPropertyValue('--dc-editor-font')).toContain('KaiTi');
    expect(changes).toEqual([
      { size: 24, font: 'mono' },
      { size: 24, font: 'kai' },
    ]);
  });

  it('falls back to 16 px Hei for a missing or broken stored value', () => {
    expect(parseTextStyle(null)).toEqual(DEFAULT_TEXT_STYLE);
    expect(parseTextStyle('{not json')).toEqual(DEFAULT_TEXT_STYLE);
    expect(parseTextStyle('{"size": 99, "font": "comic"}')).toEqual({ size: 24, font: 'hei' });
    expect(parseTextStyle(serializeTextStyle({ size: 16, font: 'song' }))).toEqual({ size: 16, font: 'song' });
  });
});

describe('repository link in settings', () => {
  it('asks the host to open the repository, and shows a copyable link if the host declines', async () => {
    const url = 'https://github.com/chenzhao1221/draft-canvas-workbuddy';
    const open = vi.fn().mockRejectedValue(new Error('Host declined'));
    render(<DraftCanvasPanel adapter={new UiFakeHost()} locale="zh-CN" supportLink={{ url, open }} />);

    expect(screen.queryByRole('link', { name: /在 GitHub 点个 Star/ })).toBeNull();
    fireEvent.click(await screen.findByTestId('settings-button'));
    fireEvent.click(screen.getByRole('link', { name: /在 GitHub 点个 Star/ }));

    expect(open).toHaveBeenCalledWith(url);
    const fallback = await screen.findByRole('textbox', { name: '复制 GitHub 仓库链接' });
    expect((fallback as HTMLInputElement).value).toBe(url);
  });
});

describe('components in Chinese', () => {
  it('translates the comment box', async () => {
    const host = new UiFakeHost({
      messages: [assistantMessage('a1', draftReply('d1', 'Line one.\nLine two.\nLine three.'))],
    });
    const controller = new DraftSessionController({ adapter: host });
    await controller.start();
    const draft = controller.getSnapshot()?.drafts.find((d) => d.draftId === 'd1');
    if (draft === undefined) throw new Error('draft d1 is missing');

    render(
      <I18nContext.Provider value={createI18n('zh-CN')}>
        <CommentPopover
          draft={draft}
          range={{ startLine: 1, startOffset: 0, endLine: 1, endOffset: 4 }}
          mode="send"
          onAdd={() => undefined}
        />
      </I18nContext.Provider>,
    );

    expect(screen.getByText('对选中的文字提意见')).toBeDefined();
    expect(screen.getByText('第 1 行')).toBeDefined();
    expect(screen.getByLabelText('改写指令')).toBeDefined();
    expect(screen.getByRole('button', { name: '添加意见' })).toBeDefined();
    expect(createI18n('zh-CN').msg('A comment points at text that has changed. Remove it and add it again.')).toContain(
      '请删掉这条意见',
    );
  });

  it('translates the review view', () => {
    render(
      <I18nContext.Provider value={createI18n('zh-CN')}>
        <ReviewView
          review={{
            leftText: 'a',
            leftLabel: 'Your changes',
            rightVersion: 2,
            rightText: 'b',
            hunks: [],
            decisions: [],
          }}
          onDecision={() => undefined}
          onDecideAll={() => undefined}
          onDone={() => undefined}
          onCancel={() => undefined}
        />
      </I18nContext.Provider>,
    );
    expect(screen.getByText('审阅修改')).toBeDefined();
    expect(screen.getByText('你的修改 → 第 2 版')).toBeDefined();
    expect(screen.getByText('没有差异。')).toBeDefined();
    expect(screen.getByRole('button', { name: '全部接受' })).toBeDefined();
    expect(screen.getByRole('button', { name: '完成' })).toBeDefined();
  });
});

describe('language toggle', () => {
  function mockBrowser(language: string, languages: string[]): void {
    vi.spyOn(window.navigator, 'language', 'get').mockReturnValue(language);
    vi.spyOn(window.navigator, 'languages', 'get').mockReturnValue(languages);
  }

  it('shows English and Chinese choices and marks the one in use', async () => {
    render(<DraftCanvasPanel adapter={new UiFakeHost()} />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.queryByTestId('language-toggle')).toBeNull();
    fireEvent.click(screen.getByTestId('settings-button'));
    const toggle = screen.getByTestId('language-toggle');
    expect(toggle.getAttribute('aria-label')).toBe('Language');
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('false');
  });

  it('switches to Chinese and back, and reports each choice', async () => {
    const onLocaleChange = vi.fn();
    render(<DraftCanvasPanel adapter={new UiFakeHost()} onLocaleChange={onLocaleChange} />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    fireEvent.click(screen.getByTestId('settings-button'));

    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(onLocaleChange).toHaveBeenLastCalledWith('zh-CN');
    expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿');
    expect(screen.getByTestId('draft-canvas-panel').getAttribute('lang')).toBe('zh-CN');
    expect(screen.getByRole('button', { name: '中文' }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByTestId('language-toggle').getAttribute('aria-label')).toBe('语言');

    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(onLocaleChange).toHaveBeenLastCalledWith('en');
    expect(screen.getByTestId('empty-state').textContent).toContain('No drafts yet');
    expect(screen.getByTestId('draft-canvas-panel').getAttribute('lang')).toBe('en');
    expect(onLocaleChange).toHaveBeenCalledTimes(2);
  });

  it('lets English be chosen on a Chinese browser', async () => {
    mockBrowser('zh-CN', ['zh-CN', 'en']);
    render(<DraftCanvasPanel adapter={new UiFakeHost()} />);
    await waitFor(() => expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿'));
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByTestId('empty-state').textContent).toContain('No drafts yet');
  });

  it('uses the persisted choice over the browser and the host language', async () => {
    mockBrowser('zh-CN', ['zh-CN']);
    const { unmount } = render(<DraftCanvasPanel adapter={new UiFakeHost()} locale="zh-CN" storedLocale="en" />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.getByTestId('empty-state').textContent).toContain('No drafts yet');
    fireEvent.click(screen.getByTestId('settings-button'));
    expect(screen.getByRole('button', { name: 'English' }).getAttribute('aria-pressed')).toBe('true');
    unmount();

    mockBrowser('en', ['en']);
    render(<DraftCanvasPanel adapter={new UiFakeHost()} locale="en" storedLocale="zh-CN" />);
    await waitFor(() => expect(screen.getByTestId('empty-state')).toBeDefined());
    expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿');
  });

  it('ignores a stored value that is not a known language', async () => {
    mockBrowser('zh-CN', ['zh-CN']);
    render(<DraftCanvasPanel adapter={new UiFakeHost()} storedLocale="fr" />);
    await waitFor(() => expect(screen.getByTestId('empty-state').textContent).toContain('还没有草稿'));
  });

  it('shows the open hint for the language in use', async () => {
    render(
      <DraftCanvasPanel adapter={new UiFakeHost()} openHint={{ en: 'Open it from the + menu.', 'zh-CN': '请从 + 菜单打开。' }} />,
    );
    await waitFor(() => expect(screen.getByTestId('empty-state').textContent).toContain('Open it from the + menu.'));
    fireEvent.click(screen.getByTestId('settings-button'));
    fireEvent.click(screen.getByRole('button', { name: '中文' }));
    expect(screen.getByTestId('empty-state').textContent).toContain('请从 + 菜单打开。');
  });
});
