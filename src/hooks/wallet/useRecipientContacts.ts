import { useEffect, useState } from 'react';
import { addressBookService } from 'src/services/wallet/AddressBookService';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import { logger } from 'src/utils/logger';
import { isOctAddress } from 'src/utils/octra/address';
import { isEvmAddress } from 'src/services/evm/tx';

export interface RecipientEntry {
  id: string;
  name: string;
  address: string;
  category: string;
  isFavorite: boolean;
}

export function useRecipientContacts(
  open: boolean,
  ownAddress?: string,
  network: 'oct' | 'evm' = 'oct'
) {
  const [contacts, setContacts] = useState<RecipientEntry[]>([]);
  const [loading, setLoading] = useState(false);

  // effect:audited - driven by the dropdown's open state; re-reads local storage per open.
  useEffect(() => {
    if (!open) return;
    let alive = true;
    setLoading(true);
    (async () => {
      try {
        await addressBookService.initialize();
        const all = await addressBookService.getAllContacts();
        const fits = network === 'evm' ? isEvmAddress : isOctAddress;
        let entries: RecipientEntry[] = all
          .filter((c) => fits(c.address))
          .map((c) => ({
            id: c.id,
            name: c.name,
            address: c.address,
            category: c.category,
            isFavorite: c.isFavorite,
          }));
        try {
          const wallets = await walletStorage.loadAllWallets();
          const saved = new Set(all.map((c) => c.address.toLowerCase()));
          const walletEntries: RecipientEntry[] = wallets
            .map((w) => ({
              w,
              address:
                network === 'evm'
                  ? w.metadata?.evm?.enabled
                    ? w.metadata.evm.address
                    : ''
                  : w.address,
            }))
            .filter(
              ({ address }) =>
                !!address &&
                !saved.has(address.toLowerCase()) &&
                address.toLowerCase() !== ownAddress?.toLowerCase()
            )
            .map(({ w, address }) => ({
              id: `wallet_${w.id}`,
              name: w.name || `Wallet (${address.slice(0, 8)}…)`,
              address,
              category: 'wallet',
              isFavorite: false,
            }));
          entries = [...walletEntries, ...entries];
        } catch {}
        if (alive) setContacts(entries);
      } catch (e) {
        logger.debug(`[recipients] address-book load failed: ${e}`);
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [open, ownAddress, network]);

  return { contacts, loading };
}

export default useRecipientContacts;
