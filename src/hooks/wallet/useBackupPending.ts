import { useEffect, useState } from 'react';
import {
  BACKUP_PENDING_KEY,
  isBackupPending,
  readPendingFromChange,
} from 'src/services/wallet/backupPending';

const known = new Map<string, boolean>();

const useBackupPending = (wallet?: { address?: string; type?: string } | null): boolean => {
  const address = wallet?.type === 'watch' ? undefined : wallet?.address;
  const [pending, setPending] = useState<Record<string, boolean>>({});

  // effect:audited - reads the stored flag for the active wallet and follows later writes
  useEffect(() => {
    if (!address) return;
    let live = true;
    const settle = (p: boolean) => {
      known.set(address, p);
      if (live) setPending((prev) => ({ ...prev, [address]: p }));
    };
    isBackupPending(address)
      .then(settle)
      .catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area !== 'local' || !(BACKUP_PENDING_KEY in changes)) return;
      settle(readPendingFromChange(changes[BACKUP_PENDING_KEY].newValue, address));
    };
    chrome.storage.onChanged?.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged?.removeListener(onChanged);
    };
  }, [address]);

  return !!address && (pending[address] ?? known.get(address)) === true;
};

export default useBackupPending;
