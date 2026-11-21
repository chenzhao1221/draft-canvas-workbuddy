import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { DraftSessionController, type HostAdapter, type SessionSnapshot } from '@draft-canvas/core';

export interface DraftSession {
  /** null until the controller has been created by the first effect. */
  controller: DraftSessionController | null;
  /** null until the controller exists. */
  snapshot: SessionSnapshot | null;
}

const noopSubscribe = (): (() => void) => () => {};
const noSnapshot = (): SessionSnapshot | null => null;

/**
 * Owns one `DraftSessionController` for `adapter` and mirrors its snapshots into React.
 * The controller is created inside an effect, so React StrictMode's mount, unmount, mount
 * sequence never reuses a disposed controller. `active` is forwarded to the controller, which
 * stops publishing while the panel is hidden and catches up once when it is shown again.
 */
export function useDraftSession(
  adapter: HostAdapter,
  active: boolean | undefined,
  refreshIntervalMs?: number,
): DraftSession {
  const [controller, setController] = useState<DraftSessionController | null>(null);

  useEffect(() => {
    const created = new DraftSessionController({
      adapter,
      ...(refreshIntervalMs !== undefined ? { refreshIntervalMs } : {}),
    });
    setController(created);
    void created.start();
    // Pending working-copy saves are debounced; make sure they land when the page goes away.
    const flush = (): void => {
      void created.flush();
    };
    window.addEventListener('pagehide', flush);
    return () => {
      window.removeEventListener('pagehide', flush);
      setController(null);
      void created.dispose();
    };
  }, [adapter, refreshIntervalMs]);

  useEffect(() => {
    if (controller !== null) void controller.setActive(active);
  }, [controller, active]);

  const subscribe = useMemo(
    () =>
      controller === null
        ? noopSubscribe
        : (onChange: () => void): (() => void) => controller.subscribe(() => onChange()),
    [controller],
  );
  const getSnapshot = useMemo(
    () => (controller === null ? noSnapshot : (): SessionSnapshot | null => controller.getSnapshot()),
    [controller],
  );
  const snapshot = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  return { controller, snapshot };
}
