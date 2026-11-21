import { useEffect } from 'react';
import { useWallet } from 'src/contexts/WalletContext';

const POLL_MS = 30_000;

const involves = (tx: unknown, address: string): boolean => {
  const t = tx as { from?: unknown; to?: unknown } | null;
  if (!t || typeof t !== 'object') return false;
  const me = address.toLowerCase();
  return (
    (typeof t.from === 'string' && t.from.toLowerCase() === me) ||
    (typeof t.to === 'string' && t.to.toLowerCase() === me)
  );
};

export function useBalancePoll(): void {
  const { activeWallet, networkId, isLocked, pollBalance, refreshBalance } = useWallet();
  const address = activeWallet?.address;

  // effect:audited - polls the node and listens to chrome.storage (external systems) per wallet + network; stops while hidden or locked
  useEffect(() => {
    if (!address || isLocked) return;
    const tick = () => {
      if (!document.hidden) void pollBalance();
    };
    const timer = setInterval(tick, POLL_MS);
    document.addEventListener('visibilitychange', tick);

    const onStorage = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local') return;
      for (const [key, change] of Object.entries(changes)) {
        if (!key.startsWith('pending_tx_')) continue;
        const next = change.newValue as { status?: string; confirmed?: boolean } | undefined;
        const before = change.oldValue as { confirmed?: boolean } | undefined;
        const done =
          next === undefined ||
          next?.status === 'failed' ||
          (next?.confirmed === true && before?.confirmed !== true);
        if (done && involves(change.newValue ?? change.oldValue, address)) {
          void refreshBalance(address);
          return;
        }
      }
    };
    const changed = globalThis.chrome?.storage?.onChanged;
    changed?.addListener(onStorage);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
      changed?.removeListener(onStorage);
    };
  }, [address, networkId, isLocked, pollBalance, refreshBalance]);
}
