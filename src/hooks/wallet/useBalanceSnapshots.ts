import { useEffect, useState } from 'react';
import { getSnapshots, type BalanceSnapshot } from 'src/services/wallet/BalanceHistory';
import { registerSessionCache } from 'src/utils/sessionCaches';
import { registerScopeWarmer } from 'src/utils/scopeWarmers';

const cache = new Map<string, BalanceSnapshot[]>();
registerSessionCache(() => cache.clear());
registerScopeWarmer(async ({ networkId, wallet, privateBalance }) => {
  const key = `${wallet.address}_${networkId}`;
  if (cache.has(key)) return;
  const points = await getSnapshots(wallet.address, networkId, 24, privateBalance);
  if (!cache.has(key)) cache.set(key, points);
});

const NONE: BalanceSnapshot[] = [];

export function useBalanceSnapshots(
  address: string | null | undefined,
  networkId: string | null | undefined,
  privateBalance: number,
  watch: unknown
): BalanceSnapshot[] {
  const key = address && networkId ? `${address}_${networkId}` : null;
  const [state, setState] = useState<{ key: string | null; points: BalanceSnapshot[] }>(() => ({
    key,
    points: (key && cache.get(key)) || NONE,
  }));

  // effect:audited - reads chrome.storage (external system) per wallet + network; delayed so a snapshot written by the same refresh lands first; cleanup drops a late read
  useEffect(() => {
    if (!key || !address || !networkId) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      getSnapshots(address, networkId, 24, privateBalance)
        .then((points) => {
          cache.set(key, points);
          if (!cancelled) setState({ key, points });
        })
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [key, address, networkId, privateBalance, watch]);

  if (!key) return NONE;
  return state.key === key ? state.points : (cache.get(key) ?? NONE);
}
