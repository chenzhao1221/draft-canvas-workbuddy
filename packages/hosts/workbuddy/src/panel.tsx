import { useEffect, useMemo, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Locale } from '@draft-canvas/ui';
import { WorkBuddyAdapter } from './adapter';
import { clearDiag, diag, diagText } from './diag';
import { PanelShell } from './shell';
import { HttpTransport } from './transport';

/** Safety net: re-read the chat this often while the tab is visible (0.1.14 and later on Crew). */
const REFRESH_INTERVAL_MS = 5_000;

const OPEN_HINTS: Record<Locale, string> = {
  en: 'This page is the panel. Keep it open next to your WorkBuddy chat.',
  'zh-CN': '这个页面就是面板。把它和 WorkBuddy 的对话窗口并排放着即可。',
};

/** The panel follows the OS theme; the UI package's default palette is the light one. */
function prefersDark(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches === true;
}

/** Entry for the page the local hub serves (`draft-canvas-wb start`). */
function App(): ReactElement {
  const [dark, setDark] = useState(prefersDark);
  const [liveUpdates, setLiveUpdates] = useState<boolean | undefined>(undefined);
  const [hubNote, setHubNote] = useState<string | null>(null);

  const adapter = useMemo(() => new WorkBuddyAdapter({ transport: new HttpTransport('') }), []);

  useEffect(() => {
    const media = window.matchMedia?.('(prefers-color-scheme: dark)');
    const onTheme = (): void => setDark(prefersDark());
    media?.addEventListener?.('change', onTheme);
    return () => media?.removeEventListener?.('change', onTheme);
  }, []);

  // A failure before the panel is mounted (a bundle problem, a blocked route) used to be invisible:
  // the page just sat there. Surface it in the same banner as a hub problem.
  useEffect(() => {
    const onError = (event: ErrorEvent): void => setHubNote(event.message || 'script error');
    const onRejection = (event: PromiseRejectionEvent): void => {
      const reason: unknown = event.reason;
      setHubNote(reason instanceof Error ? reason.message : String(reason));
    };
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);

  // One look at the hub before mounting, so the panel can say "hooks are not installed" instead of
  // silently waiting for pushes that will never come.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch('/api/info', { headers: { 'x-draft-canvas-request': '1' }, cache: 'no-store' });
        const info: unknown = await response.json();
        if (cancelled || typeof info !== 'object' || info === null) return;
        const data = info as { liveUpdates?: unknown; demo?: unknown; host?: { home?: unknown; hooksInstalled?: unknown } };
        setLiveUpdates(data.liveUpdates === true);
        diag(`hub ${data.demo === true ? 'demo, ' : ''}live=${String(data.liveUpdates)} home=${String(data.host?.home ?? '?')} hooks=${String(data.host?.hooksInstalled)}`);
      } catch (err) {
        if (!cancelled) setHubNote(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const diagnostics = useMemo(
    () => () => diagText(adapter.diagnostics(hubNote === null ? [] : [`hub note: ${hubNote}`])),
    [adapter, hubNote],
  );

  return (
    <PanelShell
      adapter={adapter}
      openHint={OPEN_HINTS}
      {...(liveUpdates !== undefined ? { liveUpdates } : {})}
      refreshIntervalMs={REFRESH_INTERVAL_MS}
      diagnostics={diagnostics}
      dark={dark}
      notice={
        hubNote === null
          ? null
          : `连不上本地服务：${hubNote}。在终端里运行 draft-canvas-wb start，然后刷新这一页。`
      }
    />
  );
}

clearDiag();
diag(`panel boot ${new Date().toISOString()}`);
const container = document.getElementById('root');
if (container !== null) {
  createRoot(container).render(<App />);
}
