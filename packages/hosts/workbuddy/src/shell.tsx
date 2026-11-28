import { useEffect, useMemo, useState, type ReactElement, type ReactNode } from 'react';
import { DARK_THEME_VARIABLES, DraftCanvasPanel, type Locale, type TextStyle } from '@draft-canvas/ui';
import type { HostAdapter } from '@draft-canvas/core';
import {
  readStoredDismissedBanners,
  readStoredLocale,
  readStoredTextStyle,
  writeStoredDismissedBanners,
  writeStoredLocale,
  writeStoredTextStyle,
} from './prefs';

/**
 * The one place the panel is mounted. Both entries use it:
 * - `panel.tsx` — a page served by the local hub (`draft-canvas-wb start`);
 * - `mcpPanel.tsx` — an MCP App widget rendered inside WorkBuddy.
 *
 * Everything host-specific is a prop; nothing here knows which one it is in.
 */
export interface PanelShellProps {
  adapter: HostAdapter;
  liveUpdates?: boolean;
  refreshIntervalMs?: number;
  openHint?: string | Partial<Record<Locale, string>>;
  diagnostics: () => string;
  /** Fixed banner under the panel, for a problem the panel itself cannot render. */
  notice?: string | null;
  /** Applied once on mount; the entries read it from the browser or the host context. */
  dark?: boolean;
  /** Buttons for the right end of the panel header (collapse, fullscreen in the widget). */
  headerActions?: ReactNode;
  openSupportLink?: (url: string) => Promise<void>;
}

export function PanelShell(props: PanelShellProps): ReactElement {
  const { adapter, notice } = props;
  const [visible, setVisible] = useState(() => typeof document === 'undefined' || document.visibilityState !== 'hidden');
  const storedLocale = useMemo(() => readStoredLocale(), []);
  const storedTextStyle = useMemo(() => readStoredTextStyle(), []);
  const storedDismissedBanners = useMemo(() => readStoredDismissedBanners(), []);

  useEffect(() => {
    if (typeof document === 'undefined') return;
    const onVisibility = (): void => setVisible(document.visibilityState !== 'hidden');
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  return (
    <>
      <DraftCanvasPanel
        adapter={adapter}
        active={visible}
        {...(props.openHint !== undefined ? { openHint: props.openHint } : {})}
        storedLocale={storedLocale}
        onLocaleChange={(locale: Locale) => writeStoredLocale(locale)}
        storedTextStyle={storedTextStyle}
        onTextStyleChange={(style: TextStyle) => writeStoredTextStyle(style)}
        {...(props.liveUpdates !== undefined ? { liveUpdates: props.liveUpdates } : {})}
        {...(props.refreshIntervalMs !== undefined ? { refreshIntervalMs: props.refreshIntervalMs } : {})}
        storedDismissedBanners={storedDismissedBanners}
        onDismissedBannersChange={(json: string) => writeStoredDismissedBanners(json)}
        diagnostics={props.diagnostics}
        supportLink={{
          url: 'https://github.com/chenzhao1221/draft-canvas-workbuddy',
          ...(props.openSupportLink ? { open: props.openSupportLink } : {}),
        }}
        {...(props.headerActions !== undefined ? { headerActions: props.headerActions } : {})}
        {...(props.dark === true ? { cssVariables: DARK_THEME_VARIABLES } : {})}
      />
      {notice === null || notice === undefined ? null : <Notice text={notice} />}
    </>
  );
}

function Notice({ text }: { text: string }): ReactElement {
  return (
    <div
      role="alert"
      style={{
        position: 'fixed',
        inset: 'auto 12px 12px 12px',
        padding: '10px 12px',
        borderRadius: 8,
        border: '1px solid #d9534f',
        background: '#fdf2f2',
        color: '#7a1c1c',
        font: '13px/1.5 system-ui, sans-serif',
      }}
    >
      {text}
    </div>
  );
}
