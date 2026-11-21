import { useEffect, useMemo, useRef, useState, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from '@modelcontextprotocol/ext-apps';
import type { HostEvent } from '@draft-canvas/core';
import { PanelIcon, iconButtonStyle } from '@draft-canvas/ui';
import { WorkBuddyAdapter } from './adapter';
import { ADAPTER_VERSION } from './protocol';
import { clearDiag, diag, diagText } from './diag';
import { McpTransport, type McpBridge } from './mcpTransport';
import { PanelShell } from './shell';

/**
 * Entry for the MCP App widget: the panel rendered by WorkBuddy itself, inside the conversation.
 *
 * Three things this file owns that the served page does not need:
 * - **size**: a tool card is far too short for a document, so the widget keeps its own height (drag
 *   the handle under the panel, or go fullscreen from the header) and reports it with
 *   `ui/notifications/size-changed`;
 * - **collapse**: a reply that lands while nobody is working in the panel folds it down to one bar.
 *   Nothing is lost — the older versions are still in the version pager;
 * - **live updates**: there is no push channel, the transport polls every 1.5 s, so the panel must
 *   *not* show the Crew banner about missing event permissions.
 */
const app = new App({ name: 'draft-canvas', version: ADAPTER_VERSION }, {}, { autoResize: false, strict: false });

const bridge: McpBridge = {
  async readResource(uri: string): Promise<string> {
    const result = await app.readServerResource({ uri });
    const first = result.contents?.[0];
    if (first === undefined) return '';
    if ('text' in first && typeof first.text === 'string') return first.text;
    if ('blob' in first && typeof first.blob === 'string') return atob(first.blob);
    return '';
  },
  async sendUserMessage(text: string): Promise<void> {
    const result = await app.sendMessage({ role: 'user', content: [{ type: 'text', text }] });
    if (result.isError === true) throw new Error('the host refused the message');
  },
  async callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await app.callServerTool({ name, arguments: args });
    if (result.isError === true) throw new Error(`the tool ${name} failed`);
    return result.structuredContent ?? {};
  },
};

const HEIGHT_KEY = 'draft-canvas:v1:height';
const MIN_HEIGHT = 320;
/** The slim bar we would like when collapsed. */
const BAR_HEIGHT = 30;
/**
 * Collapsed heights to try, smallest first. The host ignores a height below its own floor and keeps
 * whatever it had, so we step up until the iframe really is that short.
 */
const COLLAPSE_LADDER = [BAR_HEIGHT, 96, 160, 240];

function storedHeight(): number {
  try {
    const raw = localStorage.getItem(HEIGHT_KEY);
    const value = raw === null ? Number.NaN : Number(raw);
    return Number.isFinite(value) && value >= MIN_HEIGHT ? value : 640;
  } catch {
    return 640;
  }
}

function themeOf(context: { theme?: string } | undefined): boolean {
  return context?.theme === 'dark';
}

const buttonStyle = {
  border: '1px solid #dedcd6',
  background: '#fffefc',
  borderRadius: 6,
  padding: '3px 8px',
  font: 'inherit',
  cursor: 'pointer',
  color: 'inherit',
} as const;

interface BarProps {
  onExpand: () => void;
}

/**
 * The one bar left when the panel is folded. Its expand button sits where the collapse button sits
 * when open — top right of the panel, same icon size — so the control does not move under the pointer.
 */
function Bar(props: BarProps): ReactElement {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        // 16px on the right matches the panel's own padding, so the expand icon lands exactly where
        // the collapse icon sits when the panel is open.
        padding: '0 16px 0 12px',
        height: BAR_HEIGHT,
        flex: '0 0 auto',
        background: '#f6f4f0',
        font: '12px/1 system-ui, sans-serif',
        color: '#6b6a66',
      }}
    >
      <span style={{ opacity: 0.75 }}>草稿面板已收起 · 旧版本都在，展开可翻</span>
      <span style={{ flex: 1 }} />
      <button
        type="button"
        style={iconButtonStyle}
        aria-label="展开面板"
        title="展开面板"
        aria-expanded={false}
        data-testid="widget-expand"
        onClick={props.onExpand}
      >
        <PanelIcon name="expand" />
      </button>
    </div>
  );
}

function ResizeHandle(props: { height: number; onHeight: (height: number) => void }): ReactElement {
  const start = useRef<{ y: number; height: number } | null>(null);
  return (
    <div
      role="separator"
      aria-orientation="horizontal"
      aria-label="调整面板高度"
      onPointerDown={(event) => {
        start.current = { y: event.clientY, height: props.height };
        event.currentTarget.setPointerCapture(event.pointerId);
      }}
      onPointerMove={(event) => {
        if (start.current === null) return;
        props.onHeight(Math.max(MIN_HEIGHT, Math.round(start.current.height + (event.clientY - start.current.y))));
      }}
      onPointerUp={(event) => {
        start.current = null;
        event.currentTarget.releasePointerCapture(event.pointerId);
      }}
      style={{
        flex: '0 0 auto',
        height: 12,
        cursor: 'ns-resize',
        background: 'linear-gradient(#dedcd6, #dedcd6) center/48px 2px no-repeat',
        borderTop: '1px solid #e5e3dd',
      }}
    />
  );
}

function Widget(): ReactElement {
  const [ready, setReady] = useState(false);
  const [dark, setDark] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [height, setHeight] = useState(storedHeight);
  const [collapsed, setCollapsed] = useState(false);
  /**
   * The card is not always allowed to shrink: `autoResize` grows it, but this host keeps the tallest
   * height it has seen. When that happens the collapsed state must fill the space instead of leaving
   * a blank block, so we measure once after collapsing.
   */
  const [shrinkFailed, setShrinkFailed] = useState(false);
  const [viewport, setViewport] = useState(0);
  /** The collapsed height the host actually accepted. */
  const [collapsedHeight, setCollapsedHeight] = useState(BAR_HEIGHT);
  const host = useRef<HTMLDivElement | null>(null);
  const transport = useMemo(() => new McpTransport(bridge), []);
  const adapter = useMemo(() => new WorkBuddyAdapter({ transport, mode: 'app' }), [transport]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        await app.connect();
        if (cancelled) return;
        setDark(themeOf(app.getHostContext()));
        app.onhostcontextchanged = (context) => setDark(themeOf(context));
        diag(`widget connected theme=${String(app.getHostContext()?.theme ?? '?')}`);
        setReady(true);
      } catch (err) {
        if (cancelled) return;
        const message = err instanceof Error ? err.message : String(err);
        diag(`widget connect FAILED (${message})`);
        setNote(`面板没能连上 WorkBuddy：${message}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // A version that lands while nobody is working in the panel folds it down: the chat stays readable
  // and the draft is one click away. Never fold while the caret or a field is inside the panel.
  useEffect(() => {
    transport.onHostEvent = (event: HostEvent) => {
      if (event.type !== 'assistant_done') return;
      // If the card cannot shrink, folding it on its own would only leave a dead block behind.
      if (shrinkFailed) return;
      const focused = host.current !== null && host.current.contains(document.activeElement);
      if (focused) {
        diag('new version arrived while editing: staying open');
        return;
      }
      diag('new version arrived: collapsing');
      setCollapsed(true);
    };
    return () => {
      transport.onHostEvent = undefined;
    };
  }, [transport, shrinkFailed]);



  // Sizing is explicit: `autoResize` measures the document, but the host only grows that way. The
  // preset buttons have always resized in both directions, so `size-changed` is the reliable path.
  useEffect(() => {
    if (collapsed) return;
    try {
      localStorage.setItem(HEIGHT_KEY, String(Math.round(height)));
    } catch {
      // the choice lasts for this card only
    }
    void app.sendSizeChanged({ height: Math.round(height) }).catch(() => undefined);
  }, [height, collapsed]);

  // Collapsing: try the slim bar first, then step up until the iframe is really that short. The host
  // silently keeps the previous height when the value is below its floor, which is why 30 alone
  // looked like "nothing happened".
  useEffect(() => {
    if (!collapsed) {
      setShrinkFailed(false);
      setCollapsedHeight(BAR_HEIGHT);
      return undefined;
    }
    let cancelled = false;
    void (async () => {
      for (const candidate of COLLAPSE_LADDER) {
        if (cancelled) return;
        await app.sendSizeChanged({ height: candidate }).catch(() => undefined);
        await new Promise((done) => setTimeout(done, 260));
        if (cancelled) return;
        setCollapsedHeight(candidate);
        if (window.innerHeight <= candidate + 48) {
          diag(`collapsed to ${candidate}px (iframe ${window.innerHeight}px)`);
          return;
        }
      }
      // Even 240 was refused: the card cannot shrink on this host.
      diag(`host refused to shrink (iframe ${window.innerHeight}px)`);
      setViewport(window.innerHeight);
      setShrinkFailed(true);
    })();
    return () => {
      cancelled = true;
    };
  }, [collapsed]);

  const diagnostics = useMemo(
    () => () =>
      diagText(
        adapter.diagnostics([
          `height: ${height}px${collapsed ? ' (collapsed)' : ''}`,
          `host theme: ${dark ? 'dark' : 'light'}`,
          ...(note === null ? [] : [note]),
        ]),
      ),
    [adapter, dark, height, collapsed, note],
  );

  if (!ready) {
    return <div style={{ font: '13px/1.6 system-ui, sans-serif', padding: 16, color: '#767570' }}>正在连接 WorkBuddy…</div>;
  }

  const fullscreen = (): void => {
    void app.requestDisplayMode({ mode: 'fullscreen' }).catch((err: unknown) => {
      diag(`fullscreen refused (${err instanceof Error ? err.message : String(err)})`);
      setNote('宿主不允许全屏；拖分隔条调高度即可。');
    });
  };

  const boxHeight = collapsed ? (shrinkFailed ? Math.max(180, viewport) : collapsedHeight) : height;
  return (
    <div
      ref={host}
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: boxHeight,
        minHeight: collapsed && !shrinkFailed ? collapsedHeight : MIN_HEIGHT,
        overflow: 'hidden',
      }}
    >
      {collapsed && shrinkFailed ? (
        <div
          style={{
            flex: '1 1 auto',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 10,
            padding: 24,
            textAlign: 'center',
            font: '13px/1.7 system-ui, sans-serif',
            color: '#6b6a66',
          }}
        >
          <div style={{ fontSize: 15, color: '#3d3a35' }}>草稿面板已收起</div>
          <div style={{ maxWidth: 460 }}>
            宿主没让卡片变矮，所以这里占着原来的位置。草稿没有丢：点展开就能接着改，旧版本都在。
          </div>
          <button
            type="button"
            onClick={() => setCollapsed(false)}
            style={{ ...buttonStyle, padding: '6px 14px', fontSize: 13 }}
          >
            展开面板
          </button>
        </div>
      ) : null}
      {collapsed ? null : (
        <>
          <div style={{ flex: '1 1 auto', minHeight: 0, overflow: 'auto' }}>
            <PanelShell
              adapter={adapter}
              // Polling, not push — but replies do show up on their own, so the Crew permission banner is wrong here.
              liveUpdates
              refreshIntervalMs={4_000}
              diagnostics={diagnostics}
              dark={dark}
              notice={note}
              headerActions={
                <>
                  <button
                    type="button"
                    style={iconButtonStyle}
                    aria-label="全屏"
                    title="全屏"
                    data-testid="widget-fullscreen"
                    onClick={fullscreen}
                  >
                    <PanelIcon name="fullscreen" />
                  </button>
                  <button
                    type="button"
                    style={iconButtonStyle}
                    aria-label="收起面板"
                    title="收起面板"
                    aria-expanded
                    data-testid="widget-collapse"
                    onClick={() => setCollapsed(true)}
                  >
                    <PanelIcon name="collapse" />
                  </button>
                </>
              }
            />
          </div>
          <ResizeHandle height={height} onHeight={setHeight} />
        </>
      )}
      {collapsed && !shrinkFailed ? <Bar onExpand={() => setCollapsed(false)} /> : null}
    </div>
  );
}

clearDiag();
diag(`widget boot ${new Date().toISOString()}`);
const container = document.getElementById('root');
if (container !== null) createRoot(container).render(<Widget />);
