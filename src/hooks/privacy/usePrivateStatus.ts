import { useEffect, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { privateStatusOf, type PrivateStatus } from 'src/services/privacy/privateStatus';
import { readMigrationStatus } from 'src/services/privacy/setupPrivateReads';
import { networkCapabilities } from 'src/utils/network';
import { registerSessionCache } from 'src/utils/sessionCaches';

const known = new Map<string, PrivateStatus | null>();
registerSessionCache(() => known.clear());

export function usePrivateStatus(): PrivateStatus | null {
  const { activeWallet, networkId, balance } = useWallet();
  const address = activeWallet?.address ?? '';
  const privacy = networkCapabilities(networkId).privacy;
  const scopeKey = `${networkId}:${address}`;
  const [shown, setShown] = useState<{ scope: string; status: PrivateStatus | null }>({
    scope: '',
    status: null,
  });

  // effect:audited - a node read (external system) per network + address, again when the public
  // balance changes; the shared read is cached a minute and asked once at a time
  useEffect(() => {
    if (!address || !privacy) return;
    let live = true;
    void readMigrationStatus(networkId, address).then((status) => {
      const next = privateStatusOf(status);
      known.set(scopeKey, next);
      if (live) setShown({ scope: scopeKey, status: next });
    });
    return () => {
      live = false;
    };
  }, [scopeKey, networkId, address, privacy, balance]);

  if (!privacy) return null;
  return shown.scope === scopeKey ? shown.status : (known.get(scopeKey) ?? null);
}
