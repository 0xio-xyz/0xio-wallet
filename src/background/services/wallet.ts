import { ZeroXIOConfig } from '../../utils/config';
import { logger } from '../../utils/logger';
import { walletStorage } from 'src/services/wallet/WalletStorage';

export async function getActiveWallet() {
  try {
    const localData = await chrome.storage.local.get([
      'activeWalletId',
      ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET,
      'encryptedWallets',
      'passwordSkipped',
    ]);

    const sessionData = await chrome.storage.session.get(['wallet_unlocked', 'sessionKey']);

    // If password is skipped, consider it unlocked for connection purposes
    const isUnlocked = sessionData.wallet_unlocked || localData.passwordSkipped;

    if (!isUnlocked) {
      return null;
    }

    let activeAddress =
      localData[ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET] || localData.activeWalletId;

    if (!activeAddress) {
      return null;
    }

    if (localData.encryptedWallets) {
      let walletsArray;
      if (Array.isArray(localData.encryptedWallets)) {
        walletsArray = localData.encryptedWallets;
      } else if (localData.encryptedWallets.wallets) {
        walletsArray = localData.encryptedWallets.wallets;
      }

      if (walletsArray) {
        const activeWalletData = walletsArray.find(
          (w: any) => w.id === activeAddress || w.address === activeAddress
        );
        if (activeWalletData) {
          return {
            id: activeWalletData.id,
            address: activeWalletData.address || activeAddress,
            publicKey: activeWalletData.publicKey,
            balance: activeWalletData.balance || '0.00',
            name: activeWalletData.name || 'Wallet',
          };
        }
      }
    }

    let publicKey = null;
    let walletName = 'Wallet';
    let balance = '0.00';
    let privateBalance = 0;

    if (sessionData.sessionKey) {
      try {
        const allWallets = await walletStorage.loadVault(sessionData.sessionKey);
        const activeWalletFull = allWallets.find(
          (w) => w.id === activeAddress || w.address === activeAddress
        );

        if (activeWalletFull) {
          publicKey = activeWalletFull.publicKey;
          walletName = activeWalletFull.name || 'Wallet';
        }
      } catch (e) {
        logger.warn('[Background] Failed to decrypt vault for active wallet details', e);
      }
    }

    return {
      id: activeAddress,
      address: activeAddress,
      publicKey: publicKey,
      balance: balance,
      privateBalance: privateBalance,
      name: walletName,
    };
  } catch (error) {
    logger.error('Error getting active wallet:', error);
    return null;
  }
}

/**
 * Blocks a dapp request until the wallet unlocks, giving up after timeoutMs (-> null).
 * Listens on chrome.storage.onChanged instead of polling; the open message port from
 * DAPP_REQUEST (which returns true) is what keeps the service worker alive in the meantime.
 */
export async function waitForWalletUnlock(timeoutMs: number) {
  const immediate = await getActiveWallet();
  if (immediate) return immediate;

  return new Promise<Awaited<ReturnType<typeof getActiveWallet>>>((resolve) => {
    let settled = false;

    const cleanup = () => {
      if (settled) return;
      settled = true;
      chrome.storage.onChanged.removeListener(storageListener);
      clearTimeout(timer);
    };

    /* eslint-disable @typescript-eslint/no-unused-vars */
    const storageListener = async (
      _changes: Record<string, chrome.storage.StorageChange>,
      _area: string
    ) => {
      /* eslint-enable @typescript-eslint/no-unused-vars */
      if (settled) return;
      const wallet = await getActiveWallet();
      if (wallet) {
        cleanup();
        resolve(wallet);
      }
    };

    const timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, timeoutMs);

    chrome.storage.onChanged.addListener(storageListener);
  });
}
