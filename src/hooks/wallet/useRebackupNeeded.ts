import { useEffect, useState } from 'react';
import { needsRebackup, isRebackupDone, knownRebackupDone } from 'src/services/wallet/rebackup';

const useRebackupNeeded = (
  wallet?: {
    address?: string;
    type?: string;
    metadata?: { source?: string; createdAt?: number };
  } | null
): boolean => {
  const affected = needsRebackup(wallet);
  const address = wallet?.address;
  const [done, setDone] = useState<Record<string, boolean>>({});

  // effect:audited - reads the stored acknowledgement from chrome.storage when the active wallet changes
  useEffect(() => {
    if (!affected || !address) return;
    let live = true;
    const settle = (d: boolean) => {
      if (live) setDone((prev) => ({ ...prev, [address]: d }));
    };
    isRebackupDone(address)
      .then(settle)
      .catch(() => settle(false));
    return () => {
      live = false;
    };
  }, [affected, address]);

  return affected && !!address && (knownRebackupDone(address) ?? done[address]) === false;
};

export default useRebackupNeeded;
