import { createContext, useContext } from 'react';

/**
 * Tiny i18n for the panel: English (default and fallback) and Simplified Chinese. No library.
 *
 * - `en` is the source table. `zh-CN` must define every key (the compiler checks this).
 * - Language choice (`resolveLocale`), first match wins:
 *   1. the user's explicit choice (`stored`, set with the header toggle),
 *   2. a language the host reports (`preferred`),
 *   3. any tag of `navigator.languages`, then `navigator.language`, that is Chinese,
 *   4. `document.documentElement.lang`, when it is Chinese,
 *   5. English.
 *   The UI never reads a host API.
 * - Any `zh` tag selects Chinese, including zh-TW, zh-HK and zh-Hant. There is only a Simplified Chinese
 *   table, so those users get zh-CN rather than English.
 * - Messages produced by `@draft-canvas/core` (stage and rewrite results, notices, changelog errors)
 *   are English strings. `I18n.msg` translates the ones this package knows by matching them against the
 *   `core.*` templates below and leaves every other string (text supplied by the host, such as an HTTP
 *   error) as it is.
 */

export type Locale = 'en' | 'zh-CN';

export const DEFAULT_LOCALE: Locale = 'en';

const en = {
  // Banners
  'banner.connecting': 'Connecting to {host}…',
  'banner.loading': 'Loading the chat history…',
  'banner.error': 'Could not reach {host}. Your drafts are not shown until the connection works.',
  'banner.reconnecting': 'Connection lost. Reconnecting… New replies may be missing until it is back.',
  'banner.disconnected': 'Disconnected from {host}.',
  'banner.fidelity':
    'Your changes go to the agent when you send your message. Whether they stay in the saved chat history after a reload has not been confirmed for {host} yet, so do not rely on them appearing there.',
  'banner.window':
    "Only part of this chat's history is available. Older versions may be missing, and version numbers count from the first one that is visible.",
  'banner.memory': 'Unsent changes are kept in memory only and are lost when this panel closes.',
  'banner.noLiveUpdates':
    'New replies will not show up here on their own: {host} has not granted Draft Canvas the chat events permission. Approve it on the Apps page, then close this tab and open it again. Until then, switch chats to refresh.',
  'action.retry': 'Retry',
  'action.reload': 'Reload',
  'action.dismiss': 'Dismiss',
  'lang.label': 'Language',
  'settings.button': 'Settings',
  'settings.star': 'Star on GitHub',
  'settings.star.copy': 'Copy the GitHub repository link',
  'send.nothing': 'No changes',
  'send.shortcut': 'Ctrl+Enter',
  'diag.button': 'Diagnostics',
  'diag.title': 'Diagnostic log',
  'diag.refresh': 'Refresh',
  'diag.copy': 'Copy',
  'text.label': 'Text size and font',
  'text.smaller': 'Smaller text',
  'text.larger': 'Larger text',
  'text.size': '{n} px',
  'text.font': 'Font',
  'font.mono': 'Monospace',
  'font.song': 'Song (serif)',
  'font.hei': 'Hei (sans)',
  'font.kai': 'Kai',

  // Staging bar
  'stage.add': 'Add changes to my message',
  'stage.update': 'Update changes in my message',
  'stage.already': 'Already in your message',
  'stage.staleCopy':
    'Your message already contains an older copy of these changes. The button adds the current changes after it, and the agent uses the last one. This panel cannot remove text from your message.',
  'stage.sent': 'Your changes were sent. They stay here until the agent replies with a new version.',
  'stage.hideChanges': 'Hide my changes',
  'stage.showChanges': 'Show my changes',
  'stage.review': 'Review changes',
  'stage.discard': 'Discard changes',
  'stage.discardConfirm': 'Discard your unsent changes?',
  'stage.discardYes': 'Yes, discard',
  'stage.keep': 'Keep',
  'stage.addFailed': 'Could not add the changes to your message.',

  // Draft status badges
  'status.dirty': 'Unsent changes',
  'status.staged': 'In your message',
  'status.staged-stale': 'Message has older changes',
  'status.sent': 'Sent, waiting for a new version',
  'status.stale-base': 'Based on an older version',

  // Stale base banner
  'stale.base_missing':
    'The version your changes were based on is no longer in the chat history. They are not sent unless you review or discard them.',
  'stale.base_changed':
    'The version your changes were based on has changed since they were saved. They are not sent unless you review or discard them.',
  'stale.newer_version':
    'A newer version arrived after you made these changes. They are not sent unless you review or discard them.',
  'stale.reviewLatest': 'Review against latest',
  'stale.discard': 'Discard',

  // Empty and waiting states
  'empty.noDrafts': 'No drafts yet',
  'empty.waiting': 'Waiting for drafts',
  'empty.ask': 'Ask the agent to write a draft, for example a letter, a post or an outline you want to refine.',
  'empty.skill':
    'With the Draft Canvas skill installed, the agent puts the text in a draft block and it shows up here to edit. Your edits go back to the agent with your next message.',
  'panel.starting': 'Starting Draft Canvas…',
  'draft.waitingFinish': 'Waiting for the agent to finish the draft…',

  // Version pager and compare
  'version.prev': 'Previous version',
  'version.next': 'Next version',
  'version.label': 'v{n} of {total}',
  'version.latest': 'Latest',
  'compare.open': 'Compare',
  'compare.close': 'Close compare',
  'compare.from': 'From',
  'compare.to': 'to',
  'badge.received': 'new version received',
  'badge.streaming': 'streaming',
  'view.agentVersion': 'v{n} (agent)',
  'view.yourChanges': 'Your changes',
  'view.streamingPreview': 'Streaming preview',
  'view.versionReadOnly': 'Version {n}, read-only',
  'view.latestVersion': '{title}, latest version',
  'incoming.showing': 'Showing the incoming text.',
  'incoming.arriving': 'A new version is arriving.',
  'incoming.showCurrent': 'Show current version',
  'incoming.showIncoming': 'Show incoming text',

  // Session picker
  'session.choose': 'Choose a chat to follow',
  'session.chat': 'Chat',
  'session.chooseOption': 'Choose a chat…',
  'nosession.pick':
    'No chat is selected yet. Pick the chat you are working in from the list above, and its drafts will appear here.',
  'nosession.none': 'No chat found. Open or start a chat, then check again.',
  'nosession.checkAgain': 'Check again',
  'permission.title': 'Draft Canvas is not allowed to read this chat yet',
  'permission.how':
    'Open Draft Canvas in the {host} Apps page and approve its permissions. Then close this tab and open it again.',

  // Rewrite popover
  'rewrite.title': 'Rewrite selection',
  'rewrite.line': 'line {n}',
  'rewrite.lines': 'lines {a}–{b}',
  'rewrite.placeholder': 'What should change in this passage?',
  'rewrite.instructionLabel': 'Rewrite instruction',
  'rewrite.waiting': "Waiting for the agent's reply to your rewrite request…",
  'rewrite.hintCompose': 'The request goes into your message. Send it in the chat.',
  'rewrite.hintSend': 'Sent to the chat right away.',
  'rewrite.addToMessage': 'Add to my message',
  'rewrite.send': 'Send',
  'rewrite.sendFailed': 'Could not send the rewrite request.',
  'comment.title': 'Comment on the selection',
  'comment.add': 'Add comment',
  'comment.added': 'Comment added. It goes out with your edits when you press "Send to the agent".',
  'comment.list': 'Comments to send ({n})',
  'comment.hint': 'Sent together with your edits',
  'comment.remove': 'Remove comment',
  'send.button': 'Send to the agent',
  'send.failed': 'Could not send.',

  // Review
  'review.agentVersion': 'Agent version',
  'review.yourText': 'Your text',
  'review.emptyLine': '(empty line)',
  'review.change': 'Change {n} of {total}',
  'review.reject': 'Reject',
  'review.accept': 'Accept',
  'review.title': 'Review changes',
  'review.toVersion': '{label} → version {n}',
  'review.noDiff': 'No differences.',
  'review.rejectAll': 'Reject all',
  'review.acceptAll': 'Accept all',
  'review.undecided': '{count} undecided keep your text',
  'review.cancel': 'Cancel',
  'review.done': 'Done',

  // Strings produced by @draft-canvas/core. Keep them identical to the English in core: `I18n.msg`
  // matches incoming messages against these templates.
  'core.overlap':
    'This selection includes unsent edits. Add your changes to your message and send it, or discard them, then try again.',
  'core.notConnected': 'Not connected to the chat. Try again.',
  'core.tooLarge': 'Too large to send.',
  'core.unsupported': 'The chat host does not support this action.',
  'core.busy': 'Already adding changes to your message.',
  'core.noChat': 'No active chat.',
  'core.noChangelog': 'No changelog could be built.',
  'core.noChanges': 'There are no changes to add.',
  'core.tooLargeStage': 'Too large to send. Add fewer drafts to your message at a time.',
  'core.addedCompose': 'Added to your message. Send it in the chat when ready.',
  'core.addedNext': 'Your changes will go with your next message.',
  'core.cannotRewrite': 'This chat host cannot send a rewrite request.',
  'core.badSelection': 'The selection is empty or outside the text.',
  'core.tooLargeRewrite': 'Too large to send. Select a shorter passage.',
  'core.rewriteSent': 'Rewrite request sent.',
  'core.rewriteQueued': 'Added to your message. Send it in the chat to start the rewrite.',
  'core.staleBase': 'Your changes are based on an older version. Review or discard them first.',
  'core.emptyInstruction': 'Write an instruction for the selected text.',
  'core.invalidId': 'The draft id is not valid.',
  'core.invalidRev': 'The version number must be 1 or greater.',
  'core.replyNoVersion': 'The reply did not contain a new version of "{id}".',
  'core.unclosed': 'Draft "{id}" was not finished and was not saved.',
  'core.readFail': 'Could not read saved changes: {detail}',
  'core.saveFail': 'Could not save your changes (kept in memory): {detail}',
  'core.interfaceVersion': 'This adapter implements interface version {have}, but Draft Canvas supports version {want}.',
  'core.markerConflict':
    'The line "{line}" would appear in the {section} part of the changelog and cannot be expressed there. Change that line (for example, write a Setext underline with a different number of "=" characters, or use a "#" heading) and try again.',
  'core.yourChanges': 'Your changes',
  'core.versionN': 'Version {n}',
  'core.commentMoved': 'A comment points at text that has changed. Remove it and add it again.',
  'core.nothingToSend': 'Nothing to send. Edit the draft or add a comment first.',
  'core.sentToChat': 'Sent to the chat.',
  'core.newerVersion': 'A newer version arrived. Look at it first, then send again.',
  'core.updatedTo': 'Updated to version {n}.',
} as const;

export type MessageKey = keyof typeof en;

const zhCN: Record<MessageKey, string> = {
  'banner.connecting': '正在连接 {host}…',
  'banner.loading': '正在加载对话历史…',
  'banner.error': '无法连接 {host}。连接恢复之前，不会显示你的草稿。',
  'banner.reconnecting': '连接已断开，正在重新连接…恢复之前可能会漏掉新的回复。',
  'banner.disconnected': '已与 {host} 断开连接。',
  'banner.fidelity':
    '你的修改会在你发送消息时交给智能体。重新加载后，这些修改是否仍保留在已保存的对话历史中，目前尚未在 {host} 上得到确认，请不要依赖它们出现在历史记录里。',
  'banner.window': '只能获取到这段对话的部分历史。较早的版本可能缺失，版本号从可见的第一个版本开始计数。',
  'banner.memory': '未发送的修改只保存在内存中，关闭此面板后会丢失。',
  'banner.noLiveUpdates':
    '新回复不会自动显示：{host} 还没批准 Draft Canvas 的对话事件权限。请到应用页批准，然后关掉这个标签重新打开。批准之前，切换一下对话可以刷新。',
  'action.retry': '重试',
  'action.reload': '重新加载',
  'action.dismiss': '关闭',
  'lang.label': '语言',
  'settings.button': '设置',
  'settings.star': '在 GitHub 点个 Star',
  'settings.star.copy': '复制 GitHub 仓库链接',
  'send.nothing': '没有改动',
  'send.shortcut': 'Ctrl+Enter',
  'diag.button': '诊断',
  'diag.title': '诊断日志',
  'diag.refresh': '刷新',
  'diag.copy': '复制',
  'text.label': '字号和字体',
  'text.smaller': '缩小字号',
  'text.larger': '放大字号',
  'text.size': '{n} px',
  'text.font': '字体',
  'font.mono': '等宽',
  'font.song': '宋体',
  'font.hei': '黑体',
  'font.kai': '楷体',

  'stage.add': '把修改加入我的消息',
  'stage.update': '更新我消息中的修改',
  'stage.already': '已在你的消息中',
  'stage.staleCopy':
    '你的消息里已经包含这些修改的旧副本。按钮会把当前的修改追加在它后面，智能体以最后一份为准。此面板无法删除你消息中的文字。',
  'stage.sent': '你的修改已发送。在智能体回复新版本之前，它们会一直保留在这里。',
  'stage.hideChanges': '隐藏我的修改',
  'stage.showChanges': '查看我的修改',
  'stage.review': '审阅修改',
  'stage.discard': '放弃修改',
  'stage.discardConfirm': '放弃你尚未发送的修改？',
  'stage.discardYes': '确定放弃',
  'stage.keep': '保留',
  'stage.addFailed': '无法把修改加入你的消息。',

  'status.dirty': '有未发送的修改',
  'status.staged': '已在你的消息中',
  'status.staged-stale': '消息中的修改是旧的',
  'status.sent': '已发送，等待新版本',
  'status.stale-base': '基于较早的版本',

  'stale.base_missing': '你的修改所基于的版本已不在对话历史中。除非你审阅或放弃它们，否则不会发送。',
  'stale.base_changed': '你的修改所基于的版本在保存之后发生了变化。除非你审阅或放弃它们，否则不会发送。',
  'stale.newer_version': '你做出这些修改之后，又出现了更新的版本。除非你审阅或放弃它们，否则不会发送。',
  'stale.reviewLatest': '与最新版本对照审阅',
  'stale.discard': '放弃',

  'empty.noDrafts': '还没有草稿',
  'empty.waiting': '等待草稿',
  'empty.ask': '请让智能体写一份草稿，比如一封信、一篇帖子，或一份你想打磨的提纲。',
  'empty.skill':
    '安装 Draft Canvas 技能后，智能体会把文字放进草稿块，并显示在这里供你编辑。你的修改会随你的下一条消息一起回到智能体。',
  'panel.starting': '正在启动 Draft Canvas…',
  'draft.waitingFinish': '正在等待智能体写完草稿…',

  'version.prev': '上一个版本',
  'version.next': '下一个版本',
  'version.label': '第 {n} 版，共 {total} 版',
  'version.latest': '最新',
  'compare.open': '对比',
  'compare.close': '关闭对比',
  'compare.from': '从',
  'compare.to': '到',
  'badge.received': '已收到新版本',
  'badge.streaming': '正在生成',
  'view.agentVersion': 'v{n}（智能体）',
  'view.yourChanges': '你的修改',
  'view.streamingPreview': '实时预览',
  'view.versionReadOnly': '第 {n} 版（只读）',
  'view.latestVersion': '{title}，最新版本',
  'incoming.showing': '正在显示传入的文字。',
  'incoming.arriving': '新版本正在到达。',
  'incoming.showCurrent': '显示当前版本',
  'incoming.showIncoming': '显示传入的文字',

  'session.choose': '选择要跟随的对话',
  'session.chat': '对话',
  'session.chooseOption': '选择一个对话…',
  'nosession.pick': '还没有选择对话。请从上方列表中选出你正在使用的对话，它的草稿会显示在这里。',
  'nosession.none': '没有找到对话。请打开或新建一个对话，然后再检查一次。',
  'nosession.checkAgain': '重新检查',
  'permission.title': 'Draft Canvas 还没有读取对话的权限',
  'permission.how': '请到 {host} 的应用页打开 Draft Canvas，批准它的权限。然后关掉这个标签，重新打开。',

  'rewrite.title': '改写所选内容',
  'rewrite.line': '第 {n} 行',
  'rewrite.lines': '第 {a}–{b} 行',
  'rewrite.placeholder': '这段文字要怎么改？',
  'rewrite.instructionLabel': '改写指令',
  'rewrite.waiting': '正在等待智能体回复你的改写请求…',
  'rewrite.hintCompose': '请求会放进你的消息，请在对话中发送。',
  'rewrite.hintSend': '会立即发送到对话。',
  'rewrite.addToMessage': '加入我的消息',
  'rewrite.send': '发送',
  'rewrite.sendFailed': '无法发送改写请求。',
  'comment.title': '对选中的文字提意见',
  'comment.add': '添加意见',
  'comment.added': '已添加。点「发给 AI」时，会和你的修改一起发出。',
  'comment.list': '待发的意见（{n} 条）',
  'comment.hint': '将在发送时与修改内容一并提交',
  'comment.remove': '删除这条意见',
  'send.button': '发给 AI',
  'send.failed': '发送失败。',

  'review.agentVersion': '智能体的版本',
  'review.yourText': '你的文字',
  'review.emptyLine': '（空行）',
  'review.change': '第 {n} 处修改，共 {total} 处',
  'review.reject': '拒绝',
  'review.accept': '接受',
  'review.title': '审阅修改',
  'review.toVersion': '{label} → 第 {n} 版',
  'review.noDiff': '没有差异。',
  'review.rejectAll': '全部拒绝',
  'review.acceptAll': '全部接受',
  'review.undecided': '{count} 处未决定，将保留你的文字',
  'review.cancel': '取消',
  'review.done': '完成',

  'core.overlap': '所选内容包含尚未发送的修改。请先把修改加入你的消息并发送，或放弃这些修改，然后再试一次。',
  'core.notConnected': '未连接到对话，请重试。',
  'core.tooLarge': '内容过大，无法发送。',
  'core.unsupported': '当前的对话宿主不支持此操作。',
  'core.busy': '正在把修改加入你的消息。',
  'core.noChat': '当前没有活动的对话。',
  'core.noChangelog': '无法生成修改记录。',
  'core.noChanges': '没有可添加的修改。',
  'core.tooLargeStage': '内容过大，无法发送。请每次往消息里加入更少的草稿。',
  'core.addedCompose': '已加入你的消息。准备好后请在对话中发送。',
  'core.addedNext': '你的修改会随你的下一条消息一起发送。',
  'core.cannotRewrite': '当前的对话宿主无法发送改写请求。',
  'core.badSelection': '所选内容为空，或超出了文本范围。',
  'core.tooLargeRewrite': '内容过大，无法发送。请选择更短的一段。',
  'core.rewriteSent': '改写请求已发送。',
  'core.rewriteQueued': '已加入你的消息。请在对话中发送，以开始改写。',
  'core.staleBase': '你的修改基于较早的版本。请先审阅或放弃它们。',
  'core.emptyInstruction': '请为所选文字写一条指令。',
  'core.invalidId': '草稿 ID 无效。',
  'core.invalidRev': '版本号必须大于或等于 1。',
  'core.replyNoVersion': '回复中没有“{id}”的新版本。',
  'core.unclosed': '草稿“{id}”没有写完，未被保存。',
  'core.readFail': '无法读取已保存的修改：{detail}',
  'core.saveFail': '无法保存你的修改（已暂存在内存中）：{detail}',
  'core.interfaceVersion': '此适配器实现的接口版本是 {have}，而 Draft Canvas 支持的版本是 {want}。',
  'core.markerConflict':
    '这一行“{line}”会出现在修改记录的 {section} 部分，但无法在那里表示。请修改这一行（例如，让 Setext 下划线的“=”数量不同，或改用“#”标题），然后再试一次。',
  'core.yourChanges': '你的修改',
  'core.versionN': '第 {n} 版',
  'core.commentMoved': '有一条意见对应的文字已经被改掉了。请删掉这条意见，重新添加。',
  'core.nothingToSend': '没有可发送的内容。请先修改草稿或添加意见。',
  'core.sentToChat': '已发送到对话。',
  'core.newerVersion': 'AI 已经出了更新的版本。请先看一下新版，再发送。',
  'core.updatedTo': '已更新到第 {n} 版。',
};

const TABLES: Record<Locale, Record<MessageKey, string>> = { en, 'zh-CN': zhCN };

export type MessageParams = Record<string, string | number>;

function format(template: string, params: MessageParams | undefined): string {
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

// --------------------------------------------------------------------------- locale detection

/**
 * Maps one BCP 47 tag to a locale this package has a table for.
 * `null` means the tag says nothing about the choice (another language, or empty).
 * Every `zh` tag, Traditional Chinese included (`zh-Hant`, `zh-TW`, `zh-HK`, `zh-MO`), returns `'zh-CN'`:
 * the only Chinese table is Simplified.
 */
export function localeFromTag(tag: string): Locale | null {
  const primary = (tag.trim().toLowerCase().replace(/_/g, '-').split('-')[0] ?? '');
  if (primary === 'en') return 'en';
  if (primary === 'zh') return 'zh-CN';
  return null;
}

/** Reads a stored or typed locale value; anything but the two known locales is `null`. */
export function parseLocale(value: unknown): Locale | null {
  return value === 'en' || value === 'zh-CN' ? value : null;
}

export interface NavigatorLanguages {
  language?: string;
  languages?: readonly string[];
}

export interface ResolveLocaleOptions {
  /** The user's explicit choice from the header toggle. It wins over everything else. */
  stored?: Locale | null;
  /**
   * Language the host reports, as one tag or an ordered list. The Kiro Crew 0.12.2 SDK exposes none
   * (`useAppInfo()` and `useTheme()` carry no language), so the Crew entry does not pass one.
   */
  preferred?: string | readonly string[] | null;
  /** Defaults to the global `navigator`; injectable for tests. */
  navigator?: NavigatorLanguages | null;
  /** Defaults to `document.documentElement.lang`; injectable for tests. */
  documentLang?: string | null;
}

function firstDecided(tags: readonly string[]): Locale | null {
  for (const tag of tags) {
    const locale = localeFromTag(tag);
    if (locale !== null) return locale;
  }
  return null;
}

function hasChinese(tags: readonly string[]): boolean {
  return tags.some((tag) => localeFromTag(tag) === 'zh-CN');
}

function readDocumentLang(): string | null {
  if (typeof document === 'undefined') return null;
  const lang = document.documentElement?.lang;
  return typeof lang === 'string' && lang !== '' ? lang : null;
}

/**
 * Picks the panel language. First match wins:
 * 1. `stored` (the user's toggle), 2. `preferred` (host language; the first English or Chinese tag decides),
 * 3. Chinese anywhere in `navigator.languages`, then `navigator.language`,
 * 4. a Chinese `document.documentElement.lang`, 5. English.
 * Steps 3 and 4 only ever switch to Chinese: a browser list of `['en', 'zh-TW']` gives Chinese.
 */
export function resolveLocale(options: ResolveLocaleOptions = {}): Locale {
  if (options.stored !== undefined && options.stored !== null) return options.stored;

  const preferred = options.preferred;
  if (preferred !== undefined && preferred !== null) {
    const decided = firstDecided(typeof preferred === 'string' ? [preferred] : preferred);
    if (decided !== null) return decided;
  }

  const nav: NavigatorLanguages | null =
    options.navigator !== undefined
      ? options.navigator
      : typeof navigator !== 'undefined'
        ? (navigator as NavigatorLanguages)
        : null;
  if (nav !== null) {
    const list = [...(nav.languages ?? []), ...(nav.language !== undefined ? [nav.language] : [])];
    if (hasChinese(list)) return 'zh-CN';
  }

  const docLang = options.documentLang !== undefined ? options.documentLang : readDocumentLang();
  if (docLang !== null && hasChinese([docLang])) return 'zh-CN';

  return DEFAULT_LOCALE;
}
// ------------------------------------------------------------------------ core message matching

interface CoreMatcher {
  key: MessageKey;
  pattern: RegExp;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** A matcher per `core.*` key, built from its English template so it cannot drift from the table. */
const CORE_MATCHERS: readonly CoreMatcher[] = (Object.keys(en) as MessageKey[])
  .filter((key) => key.startsWith('core.'))
  .map((key) => {
    const source = en[key]
      .split(/\{(\w+)\}/)
      .map((part, i) => (i % 2 === 0 ? escapeRegExp(part) : `(?<${part}>[\\s\\S]*?)`))
      .join('');
    return { key, pattern: new RegExp(`^${source}$`) };
  });

function translateCore(locale: Locale, message: string): string {
  if (locale === 'en') return message;
  for (const { key, pattern } of CORE_MATCHERS) {
    const match = pattern.exec(message);
    if (match === null) continue;
    const params: MessageParams = {};
    for (const [name, value] of Object.entries(match.groups ?? {})) params[name] = value;
    return format(TABLES[locale][key], params);
  }
  return message;
}

// ----------------------------------------------------------------------------------- the API

export interface I18n {
  locale: Locale;
  /** Looks up a UI string and fills in `{name}` placeholders. */
  t: (key: MessageKey, params?: MessageParams) => string;
  /** Translates a known English message from core; any other text is returned unchanged. */
  msg: (message: string) => string;
}

/** The full string table of a locale, for tests that compare tables. */
export function messageTable(locale: Locale): Readonly<Record<MessageKey, string>> {
  return TABLES[locale];
}

export function createI18n(locale: Locale): I18n {
  const table = TABLES[locale];
  return {
    locale,
    t: (key, params) => format(table[key], params),
    msg: (message) => translateCore(locale, message),
  };
}

const ENGLISH = createI18n('en');

/** English unless a panel provides a locale, so components rendered on their own stay English. */
export const I18nContext = createContext<I18n>(ENGLISH);

export function useI18n(): I18n {
  return useContext(I18nContext);
}
