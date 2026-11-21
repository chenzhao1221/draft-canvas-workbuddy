import type { ReactElement, ReactNode } from 'react';
import type { DraftSessionController, Notice, NoticeLevel, SessionSnapshot } from '@draft-canvas/core';
import { useI18n } from './i18n';
import { bannerStyle, styles } from './styles';

function Banner({
  level,
  children,
  action,
}: {
  level: NoticeLevel;
  children: ReactNode;
  action?: { label: string; onClick: () => void };
}): ReactElement {
  return (
    <div style={bannerStyle(level)} role={level === 'info' ? 'status' : 'alert'}>
      <span style={styles.spacer}>{children}</span>
      {action !== undefined ? (
        <button type="button" style={styles.buttonSmall} onClick={action.onClick}>
          {action.label}
        </button>
      ) : null}
    </div>
  );
}

/** Banners the user may close for good: they describe how the host works, not something to act on. */
export const DISMISSIBLE_BANNERS = ['fidelity', 'window'] as const;
export type DismissibleBanner = (typeof DISMISSIBLE_BANNERS)[number];

/** Reads a stored list of closed banners (JSON array); anything unknown is dropped. */
export function parseDismissedBanners(value: string | null | undefined): Set<DismissibleBanner> {
  if (value === null || value === undefined || value === '') return new Set();
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is DismissibleBanner => (DISMISSIBLE_BANNERS as readonly unknown[]).includes(k)));
  } catch {
    return new Set();
  }
}

/**
 * Banners for state that concerns the whole panel (design section 6, item 1): connection and loading
 * state, transcript fidelity, history window and where working copies are kept. Banners for one draft
 * (stale base) are rendered by the panel next to that draft.
 */
export function StatusBanners({
  snapshot,
  controller,
  dismissed,
  onDismiss,
}: {
  snapshot: SessionSnapshot;
  controller: DraftSessionController;
  dismissed?: ReadonlySet<DismissibleBanner>;
  onDismiss?: (banner: DismissibleBanner) => void;
}): ReactElement | null {
  const { t } = useI18n();
  const items: ReactElement[] = [];
  const closeAction = (banner: DismissibleBanner): { label: string; onClick: () => void } | undefined =>
    onDismiss === undefined ? undefined : { label: t('action.dismiss'), onClick: () => onDismiss(banner) };

  if (snapshot.phase === 'connecting') {
    items.push(
      <Banner key="connecting" level="info">
        {t('banner.connecting', { host: snapshot.host.info.displayName })}
      </Banner>,
    );
  } else if (snapshot.phase === 'loading') {
    items.push(
      <Banner key="loading" level="info">
        {t('banner.loading')}
      </Banner>,
    );
  } else if (snapshot.phase === 'error') {
    items.push(
      <Banner key="error" level="error" action={{ label: t('action.retry'), onClick: () => void controller.retryConnect() }}>
        {t('banner.error', { host: snapshot.host.info.displayName })}
      </Banner>,
    );
  }

  if (snapshot.connection === 'reconnecting') {
    items.push(
      <Banner key="reconnecting" level="warning">
        {t('banner.reconnecting')}
      </Banner>,
    );
  } else if (snapshot.connection === 'disconnected' && snapshot.phase !== 'error') {
    items.push(
      <Banner key="disconnected" level="error" action={{ label: t('action.reload'), onClick: () => void controller.refresh() }}>
        {t('banner.disconnected', { host: snapshot.host.info.displayName })}
      </Banner>,
    );
  }

  if (snapshot.fidelity === 'context-only' && dismissed?.has('fidelity') !== true) {
    const action = closeAction('fidelity');
    items.push(
      <Banner key="fidelity" level="warning" {...(action !== undefined ? { action } : {})}>
        {t('banner.fidelity', { host: snapshot.host.info.displayName })}
      </Banner>,
    );
  }

  if (snapshot.completeness === 'window' && dismissed?.has('window') !== true) {
    const action = closeAction('window');
    items.push(
      <Banner key="window" level="info" {...(action !== undefined ? { action } : {})}>
        {t('banner.window')}
      </Banner>,
    );
  }

  if (snapshot.storageMode === 'memory') {
    items.push(
      <Banner key="memory" level="info">
        {t('banner.memory')}
      </Banner>,
    );
  }

  if (items.length === 0) return null;
  return <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{items}</div>;
}

/** Dismissible notices produced by the controller (storage errors, unfinished drafts, unanswered rewrites…). */
export function NoticeList({
  notices,
  controller,
}: {
  notices: readonly Notice[];
  controller: DraftSessionController;
}): ReactElement | null {
  const { t, msg } = useI18n();
  if (notices.length === 0) return null;
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }} data-testid="notices">
      {notices.map((notice) => (
        <Banner
          key={notice.id}
          level={notice.level}
          action={{ label: t('action.dismiss'), onClick: () => controller.dismissNotice(notice.id) }}
        >
          {msg(notice.message)}
        </Banner>
      ))}
    </div>
  );
}
