import { useEffect, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { blockedAckKey } from 'src/shared/ui/KeySwitchOverlay';
import { registerSessionCache } from 'src/utils/sessionCaches';

const known = new Map<string, boolean>();
registerSessionCache(() => known.clear());

/** Privacy ops must stay gated in this state even after the overlay is
 *  dismissed: the key still can't be resolved, so an encrypt/decrypt would use an unusable key. */
export function usePvacBlocked(): boolean {
  const { activeWallet, networkId } = useWallet();
  const address = activeWallet?.address;
  const key = address ? blockedAckKey(networkId ?? '', address) : null;
  const [state, setState] = useState<{ key: string | null; blocked: boolean }>(() => ({
    key,
    blocked: (key && known.get(key)) || false,
  }));

  // effect:audited - a chrome.storage subscription that must re-bind when the active account/network
  // changes; useMountEffect (mount-once) would leave it bound to a stale account after a switch.
  useEffect(() => {
    if (!key) return;
    let disposed = false;
    const settle = (blocked: boolean) => {
      known.set(key, blocked);
      if (!disposed) setState({ key, blocked });
    };
    chrome.storage.local
      .get(key)
      .then((r) => settle(typeof r[key] === 'string'))
      .catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && key in changes) settle(typeof changes[key].newValue === 'string');
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  }, [key]);

  if (!key) return false;
  return state.key === key ? state.blocked : (known.get(key) ?? false);
}
