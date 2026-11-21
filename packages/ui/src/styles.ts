import type { CSSProperties } from 'react';

/**
 * The panel has no stylesheet pipeline, so styles are inline objects built on CSS custom
 * properties. The fallbacks are the light theme of the 0.1.12 design; a host passes the dark
 * values (see `DARK_THEME_VARIABLES`) or its own through `cssVariables`. The UI package has no
 * dependency on any host theme API.
 *
 * Sizes: radius 8 px, buttons 28 px high, spacing 4 / 8 / 12 / 16 px, body 16 px with line height 1.8
 * in the editor, labels 12 px, titles 16 px semibold.
 */
const v = (name: string, fallback: string): string => `var(--dc-${name}, ${fallback})`;
/** A tint of a theme colour over the current background. */
const tint = (colour: string, percent: number): string => `color-mix(in srgb, ${colour} ${percent}%, transparent)`;

export const color = {
  fg: v('fg', '#252623'),
  bg: v('bg', '#F0EFEB'),
  editorBg: v('editor-bg', '#FFFEFC'),
  muted: v('muted', '#767570'),
  border: v('border', '#DEDDD7'),
  accent: v('accent', '#4567AA'),
  accentFg: v('accent-fg', '#FFFFFF'),
  warning: v('warning', '#A87430'),
  danger: v('danger', '#B6534A'),
  success: v('success', '#407A62'),
  info: v('info', '#607F9B'),
  // Banner and diff backgrounds derive from the colours above unless a host overrides them.
  warnBg: v('warn-bg', tint(v('warning', '#A87430'), 12)),
  warnBorder: v('warn-border', tint(v('warning', '#A87430'), 45)),
  dangerBg: v('danger-bg', tint(v('danger', '#B6534A'), 12)),
  dangerBorder: v('danger-border', tint(v('danger', '#B6534A'), 45)),
  infoBg: v('info-bg', tint(v('info', '#607F9B'), 12)),
  infoBorder: v('info-border', tint(v('info', '#607F9B'), 45)),
  addBg: v('add-bg', tint(v('success', '#407A62'), 18)),
  delBg: v('del-bg', tint(v('danger', '#B6534A'), 16)),
};

/** Light and dark palettes of the 0.1.12 design, as `--dc-*` variables. */
export const LIGHT_THEME_VARIABLES: Record<string, string> = {
  '--dc-bg': '#F0EFEB',
  '--dc-editor-bg': '#FFFEFC',
  '--dc-fg': '#252623',
  '--dc-muted': '#767570',
  '--dc-border': '#DEDDD7',
  '--dc-accent': '#4567AA',
  '--dc-accent-fg': '#FFFFFF',
  '--dc-warning': '#A87430',
  '--dc-danger': '#B6534A',
  '--dc-success': '#407A62',
  '--dc-info': '#607F9B',
};

export const DARK_THEME_VARIABLES: Record<string, string> = {
  '--dc-bg': '#1D1F22',
  '--dc-editor-bg': '#292B2F',
  '--dc-fg': '#EDEBE5',
  '--dc-muted': '#A7A8A9',
  '--dc-border': '#41444A',
  '--dc-accent': '#7894D1',
  '--dc-accent-fg': '#10131A',
  '--dc-warning': '#D5A15A',
  '--dc-danger': '#DB8179',
  '--dc-success': '#83B6A0',
  '--dc-info': '#8DABC9',
};

const button: CSSProperties = {
  font: 'inherit',
  fontSize: 13,
  height: 28,
  padding: '0 12px',
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  boxSizing: 'border-box',
  borderRadius: 8,
  border: `1px solid ${color.border}`,
  background: color.editorBg,
  color: color.fg,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
};

export const styles = {
  root: {
    display: 'flex',
    flexDirection: 'column',
    gap: 12,
    height: '100%',
    minHeight: 0,
    boxSizing: 'border-box',
    padding: 16,
    fontSize: 13,
    lineHeight: 1.5,
    color: color.fg,
    background: color.bg,
    overflowY: 'auto',
  } satisfies CSSProperties,
  hidden: { display: 'none' } satisfies CSSProperties,
  row: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } satisfies CSSProperties,
  spacer: { flex: 1 } satisfies CSSProperties,
  muted: { color: color.muted } satisfies CSSProperties,
  label: { color: color.muted, fontSize: 12 } satisfies CSSProperties,
  button,
  buttonPrimary: {
    ...button,
    background: color.accent,
    borderColor: color.accent,
    color: color.accentFg,
    fontWeight: 600,
  } satisfies CSSProperties,
  /** Destructive action shown as coloured text, never filled. */
  buttonDanger: {
    ...button,
    background: 'transparent',
    borderColor: 'transparent',
    color: color.danger,
  } satisfies CSSProperties,
  buttonDisabled: { opacity: 0.5, cursor: 'not-allowed' } satisfies CSSProperties,
  buttonSmall: { ...button, fontSize: 12, height: 26, padding: '0 8px' } satisfies CSSProperties,
  /** The ‹ › version arrows: a 28 px square, easy to hit. */
  arrowButton: { ...button, width: 28, minWidth: 28, padding: 0, justifyContent: 'center', fontSize: 16 } satisfies CSSProperties,
  /** A square 28 px button holding one icon (settings, fullscreen, collapse) or an arrow. */
  iconButton: {
    ...button,
    width: 28,
    minWidth: 28,
    padding: 0,
    justifyContent: 'center',
    fontSize: 16,
    background: 'transparent',
    borderColor: 'transparent',
    color: color.muted,
  } satisfies CSSProperties,
  /** The settings menu that drops down from the gear. */
  menu: {
    position: 'absolute',
    top: 'calc(100% + 4px)',
    right: 0,
    zIndex: 20,
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'flex-start',
    gap: 10,
    padding: 12,
    borderRadius: 8,
    border: `1px solid ${color.border}`,
    background: color.editorBg,
    color: color.fg,
    boxShadow: '0 4px 16px rgba(0, 0, 0, 0.12)',
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,
  /** A bare icon-like button (×). */
  buttonGhost: {
    ...button,
    background: 'transparent',
    borderColor: 'transparent',
    color: color.muted,
    height: 24,
    padding: '0 6px',
  } satisfies CSSProperties,
  chip: {
    ...button,
    height: 28,
    padding: '0 10px',
    maxWidth: 180,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  } satisfies CSSProperties,
  chipSelected: {
    borderColor: color.accent,
    color: color.accent,
    background: tint(v('accent', '#4567AA'), 10),
  } satisfies CSSProperties,
  badge: {
    fontSize: 12,
    height: 24,
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '0 10px',
    borderRadius: 8,
    border: `1px solid ${color.border}`,
    color: color.muted,
    whiteSpace: 'nowrap',
  } satisfies CSSProperties,
  badgeStreaming: { borderColor: color.accent, color: color.accent } satisfies CSSProperties,
  badgeWarning: { borderColor: color.warnBorder, color: color.warning, background: color.warnBg } satisfies CSSProperties,
  badgeDanger: { borderColor: color.dangerBorder, color: color.danger, background: color.dangerBg } satisfies CSSProperties,
  title: { fontWeight: 600, fontSize: 16 } satisfies CSSProperties,
  sectionTitle: { fontWeight: 600, fontSize: 15 } satisfies CSSProperties,
  banner: {
    padding: '8px 12px',
    borderRadius: 8,
    border: '1px solid',
    borderLeftWidth: 3,
    display: 'flex',
    gap: 8,
    alignItems: 'center',
  } satisfies CSSProperties,
  bannerInfo: { background: color.infoBg, borderColor: color.infoBorder, borderLeftColor: color.info } satisfies CSSProperties,
  bannerWarning: {
    background: color.warnBg,
    borderColor: color.warnBorder,
    borderLeftColor: color.warning,
  } satisfies CSSProperties,
  bannerError: { background: color.dangerBg, borderColor: color.dangerBorder, borderLeftColor: color.danger } satisfies CSSProperties,
  editorBox: {
    flex: 1,
    minHeight: 200,
    overflow: 'auto',
    border: `1px solid ${color.border}`,
    borderRadius: 8,
    background: color.editorBg,
    boxShadow: '0 1px 2px rgba(0, 0, 0, 0.06)',
  } satisfies CSSProperties,
  box: {
    border: `1px solid ${color.border}`,
    borderRadius: 8,
    padding: 12,
    background: color.editorBg,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } satisfies CSSProperties,
  /** The quoted passage of a comment: thin bar on the left, secondary text. */
  quote: {
    borderLeft: `3px solid ${color.infoBorder}`,
    background: tint(v('info', '#607F9B'), 6),
    borderRadius: 4,
    padding: '6px 10px',
    color: color.muted,
    fontSize: 14,
    lineHeight: 1.6,
  } satisfies CSSProperties,
  /** The bar with the send button, kept at the bottom of the panel. */
  bottomBar: {
    position: 'sticky',
    bottom: 0,
    margin: '0 -16px',
    padding: '12px 16px',
    background: color.bg,
    borderTop: `1px solid ${color.border}`,
    display: 'flex',
    flexDirection: 'column',
    gap: 8,
  } satisfies CSSProperties,
  textarea: {
    font: 'inherit',
    fontSize: 14,
    width: '100%',
    boxSizing: 'border-box',
    minHeight: 56,
    resize: 'vertical',
    padding: 8,
    borderRadius: 8,
    border: `1px solid ${color.border}`,
    background: color.bg,
    color: 'inherit',
  } satisfies CSSProperties,
  select: {
    font: 'inherit',
    fontSize: 13,
    height: 28,
    padding: '0 8px',
    borderRadius: 8,
    border: `1px solid ${color.border}`,
    background: color.editorBg,
    color: 'inherit',
  } satisfies CSSProperties,
  hunk: {
    border: `1px solid ${color.border}`,
    borderRadius: 8,
    overflow: 'hidden',
  } satisfies CSSProperties,
  hunkBar: {
    display: 'flex',
    alignItems: 'center',
    gap: 8,
    padding: '4px 8px',
    borderBottom: `1px solid ${color.border}`,
  } satisfies CSSProperties,
  pre: {
    margin: 0,
    padding: '4px 8px',
    whiteSpace: 'pre-wrap',
    wordBreak: 'break-word',
    fontFamily: 'var(--dc-editor-font, ui-monospace, SFMono-Regular, Menlo, Consolas, monospace)',
    fontSize: 'var(--dc-editor-font-size, 16px)',
    lineHeight: 1.7,
  } satisfies CSSProperties,
  preAdd: { background: color.addBg } satisfies CSSProperties,
  preDel: { background: color.delBg } satisfies CSSProperties,
  list: { margin: 0, padding: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 8 } satisfies CSSProperties,
};

export function bannerStyle(level: 'info' | 'warning' | 'error'): CSSProperties {
  if (level === 'error') return { ...styles.banner, ...styles.bannerError };
  if (level === 'warning') return { ...styles.banner, ...styles.bannerWarning };
  return { ...styles.banner, ...styles.bannerInfo };
}
