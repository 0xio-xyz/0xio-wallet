import { useCallback, useEffect, useRef, useState } from 'react';
import {
  ACTIVE,
  advance,
  loadTransfers,
  saveTransfers,
  type BridgeTransfer,
} from 'src/services/bridge/transfers';
import { logger } from 'src/utils/logger';
import { recoverTransfers, transferFromHash } from 'src/services/bridge/recover';

const POLL_MS = 20_000;
const PARALLEL = 3;
const EMPTY: BridgeTransfer[] = [];

const QUICK: ReadonlySet<BridgeTransfer['status']> = new Set(['claiming', 'approving']);

export const passOrder = (list: readonly BridgeTransfer[]): BridgeTransfer[] => {
  const active = list.filter((x) => ACTIVE.has(x.status));
  return [
    ...active.filter((x) => QUICK.has(x.status)),
    ...active.filter((x) => !QUICK.has(x.status)),
  ];
};

export async function runCapped<T>(
  items: readonly T[],
  cap: number,
  fn: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) await fn(items[next++]);
  };
  await Promise.all(Array.from({ length: Math.min(cap, items.length) }, worker));
}

const mergeById = (incoming: BridgeTransfer[], base: BridgeTransfer[]) => [
  ...incoming,
  ...base.filter((b) => !incoming.some((i) => i.id === b.id)),
];

const newestFirst = (list: BridgeTransfer[]) => [...list].sort((a, b) => b.createdAt - a.createdAt);

export function useBridgeTransfers(
  octAddress: string | null | undefined,
  evmAddress?: string | null
) {
  const scope = octAddress ?? null;
  const [state, setState] = useState<{ scope: string | null; items: BridgeTransfer[] }>({
    scope,
    items: EMPTY,
  });
  const [scanning, setScanning] = useState(false);
  const [loadedScope, setLoadedScope] = useState<string | null>(null);
  const scopeRef = useRef(scope);
  scopeRef.current = scope;
  const listRef = useRef<BridgeTransfer[]>(EMPTY);
  const listScopeRef = useRef<string | null>(scope);
  const loadedRef = useRef<string | null>(null);

  const commit = useCallback((next: BridgeTransfer[]) => {
    const owner = listScopeRef.current;
    listRef.current = next;
    setState({ scope: owner, items: next });
    if (owner && loadedRef.current === owner) void saveTransfers(owner, next);
  }, []);

  const mergeInto = useCallback(
    async (owner: string, build: (base: BridgeTransfer[]) => BridgeTransfer[]) => {
      if (listScopeRef.current === owner) {
        commit(build(listRef.current));
        return;
      }
      const stored = await loadTransfers(owner);
      if (listScopeRef.current === owner) {
        commit(build(listRef.current));
        return;
      }
      await saveTransfers(owner, build(stored));
    },
    [commit]
  );

  const add = useCallback(
    (t: BridgeTransfer) => commit([t, ...listRef.current.filter((x) => x.id !== t.id)]),
    [commit]
  );

  const update = useCallback(
    (id: string, patch: Partial<BridgeTransfer>) =>
      commit(
        listRef.current.map((x) => (x.id === id ? { ...x, ...patch, updatedAt: Date.now() } : x))
      ),
    [commit]
  );

  const recover = useCallback(async () => {
    const owner = scope;
    if (!owner) return 0;
    setScanning(true);
    try {
      const known = listScopeRef.current === owner ? listRef.current : await loadTransfers(owner);
      const found = await recoverTransfers({
        octAddress: owner,
        evmAddress: evmAddress ?? null,
        known,
      });
      if (found.length) await mergeInto(owner, (base) => newestFirst(mergeById(found, base)));
      try {
        await chrome.storage.local.set({ [`bridge_recovered:mainnet:${owner}`]: Date.now() });
      } catch {}
      return found.length;
    } finally {
      if (scopeRef.current === owner) setScanning(false);
    }
  }, [scope, evmAddress, mergeInto]);

  const addByHash = useCallback(
    async (hash: string) => {
      const owner = scope;
      if (!owner) return false;
      const t = await transferFromHash({ hash, octAddress: owner, evmAddress: evmAddress ?? null });
      if (!t) return false;
      const sameHash = (x: BridgeTransfer) =>
        (x.lockHash ?? x.burnHash)?.toLowerCase() === (t.lockHash ?? t.burnHash)?.toLowerCase();
      await mergeInto(owner, (base) => (base.some(sameHash) ? base : [t, ...base]));
      return true;
    },
    [scope, evmAddress, mergeInto]
  );

  // effect:audited - loads this wallet's transfers and polls the chains (external systems); cleanup stops the loop
  useEffect(() => {
    if (listScopeRef.current !== scope) {
      listScopeRef.current = scope;
      loadedRef.current = null;
      listRef.current = EMPTY;
      setState({ scope, items: EMPTY });
      setScanning(false);
    }
    if (!scope) return;
    let cancelled = false;
    let running = false;
    const check = async (t: BridgeTransfer) => {
      if (cancelled) return;
      try {
        const patch = await advance(t);
        const now = listRef.current.find((x) => x.id === t.id);
        if (patch && !cancelled && now?.status === t.status) update(t.id, patch);
      } catch (e) {
        logger.warn('[Bridge] could not check a transfer', e);
      }
    };
    const tick = async () => {
      if (running || document.hidden) return;
      running = true;
      try {
        await runCapped(passOrder(listRef.current), PARALLEL, check);
      } finally {
        running = false;
      }
    };
    void loadTransfers(scope).then(async (stored) => {
      if (cancelled) return;
      const early = listRef.current;
      loadedRef.current = scope;
      commit(early.length ? mergeById(early, stored) : stored);
      setLoadedScope(scope);
      void runCapped(
        listRef.current.filter((x) => QUICK.has(x.status)),
        PARALLEL,
        check
      );
      try {
        const key = `bridge_recovered:mainnet:${scope}`;
        const done = (await chrome.storage.local.get([key]))?.[key];
        if (!done && !cancelled) await recover();
      } catch (e) {
        logger.warn('[Bridge] could not read transfers from chain', e);
      }
      void tick();
    });
    const timer = setInterval(tick, POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [scope, update, recover, commit]);

  const transfers = state.scope === scope ? state.items : EMPTY;
  const loaded = !!scope && loadedScope === scope;
  return { transfers, loaded, add, update, recover, addByHash, scanning };
}
