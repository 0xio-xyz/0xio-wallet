import { useEffect, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { usePvacBlocked } from 'src/hooks/privacy/usePvacBlocked';
import { checkSetupPrivate } from 'src/services/privacy/setupPrivate';
import { nodeReads } from 'src/services/privacy/setupPrivateReads';
import { networkCapabilities } from 'src/utils/network';

export function useSetupPrivate(): { feeRaw: string | null; recheck: () => void } {
  const { activeWallet, networkId, balance, pvacForeign } = useWallet();
  const blocked = usePvacBlocked() || pvacForeign;
  const address = activeWallet?.address ?? '';
  const canSign = activeWallet?.type !== 'watch' && !!activeWallet?.privateKey;
  const privacy = networkCapabilities(networkId).privacy;
  const publicRaw = Math.round((parseFloat(balance) || 0) * 1_000_000);
  const scopeKey = `${networkId}:${address}`;
  const [shown, setShown] = useState<{ scope: string; feeRaw: string | null }>({
    scope: scopeKey,
    feeRaw: null,
  });
  const [revision, setRevision] = useState(0);

  // effect:audited - node reads for the active wallet; re-runs when its scope or public balance
  // changes so funding a wallet shows the tag without reopening Home.
  useEffect(() => {
    if (!address) return;
    let live = true;
    checkSetupPrivate({ privacy, canSign, blocked, publicRaw }, nodeReads(networkId, address)).then(
      (feeRaw) => {
        if (live) setShown({ scope: scopeKey, feeRaw });
      }
    );
    return () => {
      live = false;
    };
  }, [scopeKey, networkId, address, privacy, canSign, blocked, publicRaw, revision]);

  return {
    feeRaw: shown.scope === scopeKey ? shown.feeRaw : null,
    recheck: () => {
      setShown({ scope: scopeKey, feeRaw: null });
      setRevision((r) => r + 1);
    },
  };
}
