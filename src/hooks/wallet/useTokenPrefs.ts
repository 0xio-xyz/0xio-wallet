import { useCallback, useEffect, useState } from 'react';
import {
  DETECTED_PREFIX,
  SENT_PREFIX,
  detectedSignature,
  primeDetected,
  primeSent,
  readDetected,
  refreshDetection,
  type DetectedRecord,
} from 'src/services/evm/detectedTokens';
import { isEvmAddress } from 'src/services/evm/balances';
import {
  VIS_PREFIX,
  peekVisibility,
  primeVisibility,
  readVisibility,
  setTokenShown,
  type VisMap,
} from 'src/services/tokens/tokenVisibility';

interface StorageChange {
  oldValue?: unknown;
  newValue?: unknown;
}

export function useTokenPrefsVersion(): number {
  const [version, setVersion] = useState(0);
  // effect:audited - subscribes to chrome.storage (external system) so a switch flipped in Settings or a detection read shows without a reload
  useEffect(() => {
    const changed = globalThis.chrome?.storage?.onChanged;
    if (!changed) return;
    const listener = (changes: Record<string, StorageChange>, area: string) => {
      if (area !== 'local') return;
      let bump = false;
      for (const [key, change] of Object.entries(changes)) {
        if (key.startsWith(VIS_PREFIX)) {
          primeVisibility(key, change.newValue);
          bump = true;
        } else if (key.startsWith(DETECTED_PREFIX)) {
          primeDetected(key, change.newValue);
          if (detectedSignature(change.newValue) !== detectedSignature(change.oldValue)) {
            bump = true;
          }
        } else if (key.startsWith(SENT_PREFIX)) {
          primeSent(key, change.newValue);
          bump = true;
        }
      }
      if (bump) setVersion((v) => v + 1);
    };
    changed.addListener(listener);
    return () => changed.removeListener(listener);
  }, []);
  return version;
}

const NO_MAPS: Record<string, VisMap> = {};

export function useTokenVisibility(keys: readonly string[]) {
  const scope = keys.join('|');
  const version = useTokenPrefsVersion();
  const [state, setState] = useState<{ scope: string; maps: Record<string, VisMap> } | null>(null);

  // effect:audited - reads the switches from chrome.storage (external system) per key set; drops a late answer after a switch of wallet or network
  useEffect(() => {
    if (!scope) return;
    let live = true;
    const list = scope.split('|');
    void readVisibility(list).then((maps) => {
      if (live) setState({ scope, maps });
    });
    return () => {
      live = false;
    };
  }, [scope, version]);

  const read = !!scope && state?.scope === scope;
  const ready = read || (!!scope && keys.every((k) => peekVisibility(k) !== undefined));
  const maps = !scope
    ? NO_MAPS
    : read
      ? state.maps
      : Object.fromEntries(keys.map((k) => [k, peekVisibility(k) ?? {}]));

  const set = useCallback(
    async (key: string, contract: string, shown: boolean): Promise<boolean> => {
      const sync = () =>
        setState((s) =>
          s && s.scope === scope
            ? { scope, maps: { ...s.maps, [key]: peekVisibility(key) ?? {} } }
            : s
        );
      const write = setTokenShown(key, contract, shown);
      sync();
      const ok = await write.then(
        () => true,
        () => false
      );
      sync();
      return ok;
    },
    [scope]
  );

  return { maps, ready, set, version };
}

export type DetectMode = 'stale' | 'open';

export function useEvmDetected(
  address: string | null | undefined,
  chainIds: readonly number[],
  enabled: boolean,
  mode: DetectMode
) {
  const active = enabled && isEvmAddress(address) && chainIds.length > 0;
  const scope = active ? `${address.toLowerCase()}|${chainIds.join(',')}` : '';
  const version = useTokenPrefsVersion();
  const [state, setState] = useState<{
    scope: string;
    records: Record<number, DetectedRecord | undefined>;
    busy: boolean;
  } | null>(null);

  // effect:audited - reads the oracle (external system) per address and chain set; skipped while hidden, cleanup drops late answers
  useEffect(() => {
    if (!scope) return;
    let live = true;
    const [owner, chains] = scope.split('|');
    const ids = chains.split(',').map(Number);
    let forced = mode !== 'open';
    const run = async () => {
      const records = await readDetected(ids, owner);
      if (!live) return;
      setState((s) => ({ scope, records, busy: s?.scope === scope ? s.busy : false }));
      if (document.hidden) return;
      const force = !forced;
      forced = true;
      setState((s) => (s?.scope === scope ? { ...s, busy: true } : s));
      const next = await refreshDetection(owner, ids, { force });
      if (live) setState({ scope, records: next, busy: false });
    };
    const onVisible = () => {
      if (!document.hidden) void run();
    };
    void run();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [scope, mode]);

  // effect:audited - picks up records another page or window stored, without a new oracle read
  useEffect(() => {
    if (!scope || version === 0) return;
    let live = true;
    const [owner, chains] = scope.split('|');
    void readDetected(chains.split(',').map(Number), owner).then((records) => {
      if (live) setState((s) => ({ scope, records, busy: s?.scope === scope ? s.busy : false }));
    });
    return () => {
      live = false;
    };
  }, [scope, version]);

  const current = state?.scope === scope ? state : null;
  return {
    records: current?.records ?? {},
    loading: !!scope && (!current || current.busy),
  };
}
