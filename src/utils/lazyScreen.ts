import React from 'react';

const RELOAD_KEY = '0xio_chunk_reload_at';
const RELOAD_WINDOW_MS = 10_000;

export const isStaleChunkError = (e: unknown): boolean =>
  e instanceof Error &&
  /dynamically imported module|Importing a module script failed|Loading chunk|error loading dynamically/i.test(
    e.message
  );

export function claimReload(now = Date.now()): boolean {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) || 0);
    if (now - last < RELOAD_WINDOW_MS) return false;
    sessionStorage.setItem(RELOAD_KEY, String(now));
    return true;
  } catch {
    return false;
  }
}

export function lazyScreen<T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>
): React.LazyExoticComponent<T> {
  return React.lazy(() =>
    load().catch((e: unknown) => {
      if (isStaleChunkError(e) && claimReload()) {
        window.location.reload();
        return new Promise<{ default: T }>(() => {});
      }
      throw e;
    })
  );
}
