import React, {
  createContext,
  useContext,
  useState,
  useEffect,
  useCallback,
  useRef,
  startTransition,
} from 'react';
import { walletStorage } from '../services/wallet/WalletStorage';
import {
  passwordManager,
  WrongPasswordError,
  LockedOutError,
} from '../services/crypto/PasswordManager';
import { networkService, privacyNetworkService } from '../services/network/NetworkService';
import { pvacManager } from '../services/pvac/PvacManager';
import { MigrationService } from '../services/wallet/MigrationService';
import { appendSnapshot, stripPrivateFromSnapshots } from '../services/wallet/BalanceHistory';
import {
  clearPrivateBalanceCache,
  readBalanceCache,
  type CachedBalance,
  stripPrivateFromLocalBalanceCache,
  writeBalanceCache,
} from '../services/wallet/balanceCache';
import { clearSessionCaches } from '../utils/sessionCaches';
import { warmScope } from '../utils/scopeWarmers';
import type { Wallet } from '../types/wallet';
import { ZeroXIOConfig, type NetworkId } from '../utils/config';
import { logger } from '../utils/logger';
import { plainError } from '../utils/plainError';
import i18n from 'src/i18n/core';
import {
  getPendingKeySwitch,
  clearPendingKeySwitch,
  resolveRotationState,
} from '../services/pvac/keySwitchService';
import { resolveNetworkPin, storedNetworkId } from '../services/network/txScope';
import { networkCapabilities } from '../utils/network';

interface WalletContextValue {
  isInitialized: boolean;
  isLocked: boolean;
  isLoading: boolean;
  activeWallet: Wallet | null;
  wallets: Wallet[];
  balance: string | null;
  privateBalance: string | null;
  totalBalance: string | null;
  privateUnavailable: boolean;
  message: {
    id: number;
    text: string;
    type: 'success' | 'error' | 'warning' | 'processing' | 'info';
  } | null;
  requiresMigrationPassword: boolean;
  isMigrating: boolean;
  migrationError: string | null;
  migrateLegacyWallet: (password: string) => Promise<boolean>;
  clearMigrationState: () => void;
  unlockWallet: (password: string, opts?: { countFailure?: boolean }) => Promise<boolean>;
  lockWallet: () => Promise<void>;
  refreshBalance: (
    address?: string,
    walletObj?: Wallet | null,
    force?: boolean,
    networkOverride?: NetworkId
  ) => Promise<void>;
  pollBalance: () => Promise<void>;
  adjustBalanceOptimistic: (pubDeltaOCT: number, privDeltaOCT: number) => void;
  refreshWallets: () => Promise<void>;
  switchWallet: (address: string) => Promise<void>;
  showMessage: (
    text: string,
    type?: 'success' | 'error' | 'warning' | 'processing' | 'info'
  ) => void;
  hideMessage: (id?: number) => void;
  walletStorage: typeof walletStorage;
  passwordManager: typeof passwordManager;
  showBalanceValues: boolean;
  setShowBalanceValues: React.Dispatch<React.SetStateAction<boolean>>;
  passwordSkipped: boolean;
  networkId: NetworkId;
  pvacForeign: boolean;
  setPvacForeign: (value: boolean) => void;
  pvacLegacy: boolean;
  setPvacLegacy: (value: boolean) => void;
  markPrivacyOp: () => void;
}

const WalletContext = createContext<WalletContextValue | undefined>(undefined);

interface ShownBalance {
  scope: string;
  pubAt: number;
  fullAt: number;
  pub: string | null;
  priv: string | null;
  total: string | null;
  privFailed: boolean;
}

interface ShownView {
  scope: string;
  pub: string | null;
  priv: string | null;
  total: string | null;
  privFailed: boolean;
}

const emptyShown = (scope: string): ShownBalance => ({
  scope,
  pubAt: -1,
  fullAt: -1,
  pub: null,
  priv: null,
  total: null,
  privFailed: false,
});

const emptyView = (scope: string): ShownView => ({
  scope,
  pub: null,
  priv: null,
  total: null,
  privFailed: false,
});

const balanceScope = (networkId: string, address: string) => `${networkId}:${address}`;
const toAmount = (v: string | null) => (v === null ? null : parseFloat(v));
const sameAmount = (a: number | null, b: number | null) =>
  a === null || b === null ? a === b : Math.abs(a - b) < 5e-7;
const OPTIMISTIC_HOLD_MS = 60_000;

const readScope = async (net: NetworkId, wallet: Wallet): Promise<CachedBalance | null> => {
  const cached = await readBalanceCache(net, wallet.address).catch((): null => null);
  const privateBalance = parseFloat(cached?.privateBalance ?? '0') || 0;
  await warmScope({ networkId: net, wallet, privateBalance });
  return cached;
};

export const WalletProvider = ({ children }: { children: React.ReactNode }) => {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isLocked, setIsLocked] = useState(true);
  const [activeWallet, setActiveWallet] = useState<Wallet | null>(null);
  const [wallets, setWallets] = useState<Wallet[]>([]);

  const [isMigrating, setIsMigrating] = useState(false);
  const [migrationError, setMigrationError] = useState<string | null>(null);
  const [requiresMigrationPassword, setRequiresMigrationPassword] = useState(false);
  const justMigratedRef = React.useRef(false);
  const migrationInProgressRef = React.useRef(false);
  const recheckRef = React.useRef(false);
  const needsMigrationRef = React.useRef(false);

  // Every shown value carries the network + address it was read for, so a wallet or network
  // switch can never show the previous scope's numbers, not even for one render.
  const [shown, setShown] = useState<ShownView>(() => emptyView(''));

  const [isLoading, setIsLoading] = useState(true);
  const [message, setMessage] = useState<{
    id: number;
    text: string;
    type: 'success' | 'error' | 'warning' | 'processing' | 'info';
  } | null>(null);

  const messageSeq = useRef(0);
  const [showBalanceValues, setShowBalanceValues] = useState(true);

  const [passwordSkipped, setPasswordSkipped] = useState(false);
  const [networkId, setNetworkId] = useState<NetworkId>('mainnet');

  const activeWalletRef = useRef<Wallet | null>(null);
  activeWalletRef.current = activeWallet;
  const networkIdRef = useRef<NetworkId>(networkId);
  networkIdRef.current = networkId;

  const [pvacForeign, setPvacForeignState] = useState(false);
  // Encrypted balance readable only via the legacy (pre-canonical-parity) keys: written by an
  // older build. NOT corruption - but private ops must pause on it (layering onto it would
  // corrupt it beyond either keyset).
  const [pvacLegacy, setPvacLegacy] = useState(false);
  const pvacCheckDoneRef = useRef<string | null>(null);

  const setPvacForeign = useCallback((value: boolean) => {
    pvacManager.pvacForeign = value;
    setPvacForeignState(value);
  }, []);

  const lastRefreshRef = useRef<{ scope: string; at: number }>({ scope: '', at: 0 });
  const trailingRefreshRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const refreshEpochRef = useRef(0);
  const loadGenRef = useRef(0);
  const lastPrivacyOpRef = useRef<number>(0);
  const markPrivacyOp = useCallback(() => {
    lastPrivacyOpRef.current = Date.now();
  }, []);

  // A value only replaces one read no earlier, so an older response can never win.
  const shownRef = useRef<ShownBalance>(emptyShown(''));
  const optimisticRef = useRef<{
    scope: string;
    pub: number;
    priv: number | null;
    until: number;
  } | null>(null);

  const resetShown = (scope: string, cached?: CachedBalance | null) => {
    const s = emptyShown(scope);
    if (typeof cached?.balance === 'string') s.pub = cached.balance;
    if (cached?.privateBalance != null) s.priv = cached.privateBalance;
    if (cached?.totalBalance != null) s.total = cached.totalBalance;
    shownRef.current = s;
    optimisticRef.current = null;
    setShown({ ...emptyView(scope), pub: s.pub, priv: s.priv, total: s.total });
  };

  const publishShown = () => {
    const { scope, pub, priv, total, privFailed } = shownRef.current;
    startTransition(() => setShown({ scope, pub, priv, total, privFailed }));
  };

  const heldBack = (scope: string, pub: string, priv?: string | null) => {
    const hold = optimisticRef.current;
    if (!hold || hold.scope !== scope) return false;
    if (Date.now() > hold.until) {
      optimisticRef.current = null;
      return false;
    }
    return (
      sameAmount(toAmount(pub), hold.pub) &&
      (priv === undefined || sameAmount(toAmount(priv), hold.priv))
    );
  };

  const applyPublic = (scope: string, at: number, pub: string) => {
    const s = shownRef.current;
    if (s.scope !== scope || at < s.pubAt || heldBack(scope, pub)) return false;
    s.pub = pub;
    s.pubAt = at;
    publishShown();
    return true;
  };

  const markPrivateFailed = (scope: string) => {
    const s = shownRef.current;
    if (s.scope !== scope || s.privFailed) return;
    s.privFailed = true;
    publishShown();
  };

  const applySnapshot = (
    scope: string,
    at: number,
    pub: string,
    priv: string | null,
    total: string | null
  ) => {
    const s = shownRef.current;
    if (s.scope !== scope || at < s.fullAt || heldBack(scope, pub, priv)) return false;
    optimisticRef.current = null;
    const pubFresh = at >= s.pubAt;
    if (pubFresh) {
      s.pub = pub;
      s.pubAt = at;
    }
    s.priv = priv;
    s.total = total;
    s.fullAt = at;
    s.privFailed = false;
    publishShown();
    return true;
  };

  const enterScope = (wallet: Wallet, net: NetworkId, cached: CachedBalance | null) => {
    if (networkIdRef.current !== net) {
      networkIdRef.current = net;
      setNetworkId(net);
    }
    activeWalletRef.current = wallet;
    setActiveWallet(wallet);
    const scope = balanceScope(net, wallet.address);
    if (shownRef.current.scope === scope) return;
    refreshEpochRef.current++;
    resetShown(scope, cached);
    pvacManager.pvacForeign = false;
    setPvacForeignState(false);
    setPvacLegacy(false);
    pvacCheckDoneRef.current = null;
  };

  useEffect(() => {
    chrome.storage.local.get([ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK], (result) => {
      const stored = (result[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK] || 'mainnet') as NetworkId;
      networkIdRef.current = stored;
      setNetworkId(stored);
    });
    const onNetworkChange = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]) {
        const newNet = (changes[ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK].newValue ||
          'mainnet') as NetworkId;
        logger.info(`[WalletContext] Network changed -> ${newNet}`);
        refreshEpochRef.current++;
        networkIdRef.current = newNet;
        setNetworkId(newNet);
        const switchedAddr = activeWalletRef.current?.address;
        resetShown(switchedAddr ? balanceScope(newNet, switchedAddr) : '');
        // Key state is per network: the old network's foreign-key or legacy verdict must not
        // show here. The refresh below re-derives both for the new network.
        pvacManager.pvacForeign = false;
        setPvacForeignState(false);
        setPvacLegacy(false);
        pvacCheckDoneRef.current = null;
        const addr = activeWalletRef.current?.address;
        if (addr) {
          logger.info(
            `[WalletContext] Triggering balance refresh for ${addr.slice(0, 8)}… on ${newNet}`
          );
          setTimeout(() => {
            refreshBalance(addr, activeWalletRef.current, true, newNet);
          }, 200);
        }
      }
    };
    chrome.storage.onChanged.addListener(onNetworkChange);
    return () => chrome.storage.onChanged.removeListener(onNetworkChange);
  }, []);

  useEffect(() => {
    checkStorageStatus(false);

    const storageListener = async (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes.wallet_unlocked && changes.wallet_unlocked.newValue === undefined) {
        dropUnlockedState();
      }
      // Skip during auth changes to prevent Old Key + New Vault race condition
      try {
        const session = await chrome.storage.session.get('processing_auth_change');
        if (session.processing_auth_change) return;
      } catch (_e) {}

      if (changes.wallet_unlocked || changes.activeWalletId || changes.vault || changes.booted) {
        if (!justMigratedRef.current) {
          checkStorageStatus(true);
        }
      }
    };
    chrome.storage.onChanged.addListener(storageListener);
    return () => {
      chrome.storage.onChanged.removeListener(storageListener);
      if (trailingRefreshRef.current) clearTimeout(trailingRefreshRef.current);
    };
  }, []);

  const checkStorageStatus = async (silent = false) => {
    if (migrationInProgressRef.current) {
      recheckRef.current = true;
      return;
    }

    try {
      if (!silent) setIsLoading(true);
      migrationInProgressRef.current = true;

      const migrationResult = await MigrationService.checkAndMigrate();

      if (!migrationResult.success && migrationResult.error === 'PASSWORD_REQUIRED') {
        logger.debug('Migration needs password - will auto-migrate at unlock');
        needsMigrationRef.current = true;
        // Fall through to normal lock screen - migration happens transparently in unlockWallet
      } else if (
        !migrationResult.success &&
        migrationResult.error === 'MIGRATION_FAILED_NO_PASSWORD'
      ) {
        logger.error('Migration failed for skipped-password user. Treating as uninitialized.');
        setIsInitialized(false);
        setIsLocked(true);
        if (!silent) setIsLoading(false);
        return;
      } else if (!migrationResult.success && migrationResult.error) {
        logger.error('Migration check failed:', migrationResult.error);
      }

      if (migrationResult.success && migrationResult.migrated) {
        logger.debug('Migration completed successfully, wallet is unlocked');
        justMigratedRef.current = true;
        setIsInitialized(true);
        setIsLocked(false);
        await loadActiveWallet();
        if (!silent) setIsLoading(false);
        setTimeout(() => {
          justMigratedRef.current = false;
        }, 1000);
        return;
      }

      const initialized = await walletStorage.isInitialized();
      setIsInitialized(initialized);

      await passwordManager.initializeUnlockStatus();
      setPasswordSkipped(await passwordManager.isPasswordSkipped());

      const unlocked = passwordManager.isUnlocked();
      setIsLocked(!unlocked);

      if (initialized && unlocked) {
        passwordManager.setupActivityTracking();
        await loadActiveWallet();
      } else {
        setActiveWallet(null);
        setWallets([]);
      }
    } catch (error) {
      logger.error('Context initialization error:', error);
    } finally {
      migrationInProgressRef.current = false;
      if (!silent) setIsLoading(false);
      if (recheckRef.current) {
        recheckRef.current = false;
        void checkStorageStatus(true);
      }
    }
  };

  const migrateLegacyWallet = async (password: string) => {
    try {
      setIsMigrating(true);
      setMigrationError(null);

      const result = await MigrationService.checkAndMigrate(password);

      if (result.success) {
        setRequiresMigrationPassword(false);
        await checkStorageStatus(false);
        return true;
      } else {
        throw new Error(result.error || 'Migration failed. Incorrect password?');
      }
    } catch (error) {
      logger.error('Manual migration failed:', error);
      setMigrationError(error.message);
      throw error;
    } finally {
      setIsMigrating(false);
    }
  };

  const clearMigrationState = useCallback(() => {
    setRequiresMigrationPassword(false);
    setMigrationError(null);
  }, []);

  const loadActiveWallet = async () => {
    try {
      const sessionKey = await passwordManager.getSessionKey();
      if (!sessionKey) {
        setIsLocked(true);
        return;
      }

      const allWallets = await walletStorage.loadAllWallets();
      setWallets(allWallets);

      if (allWallets.length === 0) {
        setActiveWallet(null);
        return;
      }

      const activeId = await walletStorage.getActiveWalletId();

      let walletData;
      if (activeId) {
        walletData = allWallets.find((w) => w.id === activeId);
      }

      if (!walletData && allWallets.length > 0) {
        await walletStorage.setActiveWallet(allWallets[0].id);
        walletData = allWallets[0];
      }

      if (walletData) {
        const gen = ++loadGenRef.current;
        const netBefore = networkIdRef.current;
        const stored = await storedNetworkId();
        const cached = await readScope(stored, walletData);
        if (loadGenRef.current !== gen) return;
        const net = networkIdRef.current !== netBefore ? networkIdRef.current : stored;
        enterScope(walletData, net, net === stored ? cached : null);
        refreshBalance(walletData.address, walletData, true, net);
      }
    } catch (error) {
      logger.error('Failed to load wallet data:', error);
      showMessage(i18n.t('toast.walletLoadFailed'), 'error');
    }
  };

  // The attempt limit lives here rather than in a screen, so the lock screen and the dApp approval
  // popups share one. A passkey unlock passes countFailure false, since its password came from the
  // authenticator: a mismatch there means a passkey set up before a password change, not a guess.
  const unlockWallet = async (password: string, opts: { countFailure?: boolean } = {}) => {
    const countFailure = opts.countFailure ?? true;
    await passwordManager.loadRateLimitState(); // another popup may have counted a miss meanwhile
    if (countFailure && passwordManager.isLockedOut()) {
      throw new LockedOutError(passwordManager.getLockoutRemainingSeconds());
    }
    const storage = await chrome.storage.local.get(['hashedPassword', 'salt']);
    const isValid = await passwordManager.verifyPassword(
      password,
      storage.hashedPassword,
      storage.salt
    );

    if (!isValid) {
      if (countFailure) await passwordManager.recordFailedAttempt();
      throw new WrongPasswordError();
    }
    await passwordManager.resetRateLimit();

    if (needsMigrationRef.current) {
      logger.debug('Auto-migrating vault during unlock...');
      const migResult = await MigrationService.checkAndMigrate(password);
      if (migResult.success) {
        needsMigrationRef.current = false;
        logger.debug(`Auto-migration complete (${migResult.count} wallets)`);
      } else {
        logger.error('Auto-migration failed:', migResult.error);
        // Non-fatal: vault may already be current version, continue unlock
      }
    }

    await passwordManager.setSessionKey(await walletStorage.unlockVault(password));
    passwordManager.setupActivityTracking();
    void stripPrivateFromLocalBalanceCache();
    void stripPrivateFromSnapshots();

    await loadActiveWallet();
    setIsLocked(false);
    chrome.runtime.sendMessage({ type: 'BROADCAST_WALLET_UNLOCKED' }).catch(() => {});
    return true;
  };

  const dropUnlockedState = () => {
    refreshEpochRef.current++;
    loadGenRef.current++;
    if (trailingRefreshRef.current) {
      clearTimeout(trailingRefreshRef.current);
      trailingRefreshRef.current = null;
    }
    pvacManager.destroy();
    clearSessionCaches();
    privacyNetworkService.clearDecryptCache();
    void clearPrivateBalanceCache();
    resetShown('');
    pvacCheckDoneRef.current = null;
    setPvacForeignState(false);
    setPvacLegacy(false);
  };

  const lockWallet = async () => {
    await passwordManager.lockWallet();
    dropUnlockedState();
    setIsLocked(true);
    setActiveWallet(null);
    setWallets([]);
    chrome.runtime.sendMessage({ type: 'BROADCAST_WALLET_LOCKED' }).catch(() => {});
  };

  // The private half and the total go to session storage only (see balanceCache.ts).
  const persistBalanceCache = useCallback(
    (network: string, addr: string, bal: string, privBal: string | null, totBal: string | null) => {
      void writeBalanceCache(network, addr, bal, privBal, totBal);
    },
    []
  );

  const refreshBalance = useCallback(
    async (
      address?: string,
      walletObj?: Wallet | null,
      force = false,
      networkOverride?: NetworkId
    ) => {
      const wallet = walletObj ?? activeWalletRef.current;
      const addr = address ?? wallet?.address;
      if (!addr) return;

      if (address && wallet && address !== wallet.address) {
        logger.debug(
          `[refreshBalance] skipped - stale address ${address.slice(0, 8)}… vs active ${wallet.address.slice(0, 8)}…`
        );
        return;
      }

      const networkAtStart = networkOverride ?? networkIdRef.current;
      const scope = balanceScope(networkAtStart, addr);

      const now = Date.now();
      const minGap = force ? 1000 : 5000;
      const last = lastRefreshRef.current;
      if (last.scope === scope && now - last.at < minGap) {
        if (!trailingRefreshRef.current && now - last.at > 250) {
          trailingRefreshRef.current = setTimeout(
            () => {
              trailingRefreshRef.current = null;
              if (shownRef.current.scope !== scope) return;
              void refreshBalance(addr, wallet, force, networkAtStart);
            },
            minGap - (now - last.at)
          );
        }
        logger.debug(
          `[refreshBalance] throttled (${((now - last.at) / 1000).toFixed(1)}s since last, force=${force})`
        );
        return;
      }
      lastRefreshRef.current = { scope, at: now };

      const epoch = ++refreshEpochRef.current;
      const t0 = Date.now();
      logger.debug(
        `[refreshBalance] #${epoch} starting for ${addr.slice(0, 8)}… (network=${networkAtStart}, force=${force})`
      );

      const isStale = () => {
        if (refreshEpochRef.current !== epoch) {
          logger.debug(`[refreshBalance] #${epoch} superseded by #${refreshEpochRef.current}`);
          return true;
        }
        if (networkIdRef.current !== networkAtStart) {
          logger.debug(
            `[refreshBalance] #${epoch} stale - network ${networkAtStart}->${networkIdRef.current}`
          );
          return true;
        }
        return false;
      };
      const scopeGone = () =>
        networkIdRef.current !== networkAtStart || shownRef.current.scope !== scope;
      const persistShown = () => {
        const s = shownRef.current;
        persistBalanceCache(networkAtStart, addr, s.pub, s.priv, s.total);
      };

      const keyScope = { networkId: networkAtStart, address: addr };

      {
        try {
          const corruptionKey = `pvac_corrupted_${networkAtStart}_${addr}`;
          const cached = await chrome.storage.local.get(corruptionKey);
          if (cached[corruptionKey]) {
            if (await getPendingKeySwitch(keyScope)) {
              logger.warn(
                `[refreshBalance] #${epoch} Cached corruption for ${addr.slice(0, 8)}... but a rotation is pending - expected, not prompting`
              );
            } else if (!isStale()) {
              logger.warn(
                `[refreshBalance] #${epoch} Cached cipher corruption for ${addr.slice(0, 8)}... (${networkAtStart}) - showing overlay immediately`
              );
              pvacManager.pvacForeign = true;
              setPvacForeignState(true);
            }
          }
        } catch {}
      }

      try {
        if (wallet?.type === 'watch') {
          const at = performance.now();
          const result = await networkService.getBalance(addr, true);
          if (scopeGone()) return;
          if (result.success) {
            const pubBal = parseFloat(result.balance.toFixed(6)).toString();
            if (!applySnapshot(scope, at, pubBal, null, null)) return;
            persistShown();
            appendSnapshot(addr, networkAtStart, parseFloat(pubBal) || 0, null).catch(() => {});
            logger.debug(
              `[refreshBalance] #${epoch} UI SET (${networkAtStart}) watch-only: pub=${pubBal}`
            );
          }
          logger.debug(`[refreshBalance] #${epoch} done in ${Date.now() - t0}ms`);
          return;
        }

        if (wallet?.privateKey) {
          let pubKey = wallet.publicKey;
          if (!pubKey) {
            const tempManager = new (
              await import('../services/crypto/CryptoManager')
            ).CryptoManager();
            tempManager.setPrivateKey(wallet.privateKey);
            pubKey = tempManager.getPublicKey();
          }

          const pubAt = performance.now();
          networkService
            .getBalance(addr, true)
            .then((r) => {
              if (scopeGone()) return;
              if (r.success) {
                const pubBal = parseFloat(r.balance.toFixed(6)).toString();
                if (!applyPublic(scope, pubAt, pubBal)) return;
                persistBalanceCache(networkAtStart, addr, pubBal, null, null);
                logger.debug(
                  `[refreshBalance] #${epoch} early pub (${networkAtStart}): ${pubBal} - ${Date.now() - t0}ms`
                );
              }
            })
            .catch(() => {});

          const encPin = await resolveNetworkPin(networkAtStart);
          if (scopeGone()) return;
          const callAt = performance.now();
          let result = await privacyNetworkService.getEncryptedBalanceDevnet(
            addr,
            wallet.privateKey,
            pubKey,
            encPin
          );
          if (scopeGone()) return;
          if (result.success && (result.readAt ?? callAt) < callAt && !isStale()) {
            const again = await privacyNetworkService.getEncryptedBalanceDevnet(
              addr,
              wallet.privateKey,
              pubKey,
              encPin
            );
            if (scopeGone()) return;
            if (again.success) result = again;
          }
          if (result.success) {
            const pubBal = parseFloat(result.public.toFixed(6)).toString();
            const readAt = result.readAt ?? callAt;

            // If decrypt was skipped (proof generation in progress), preserve the
            // current private balance to prevent overwriting optimistic updates with 0
            if (result.decryptSkipped) {
              applyPublic(scope, readAt, pubBal);
              logger.debug(
                `[refreshBalance] #${epoch} UI SET (${networkAtStart}) pub=${pubBal}, priv=KEPT (decrypt skipped) - ${Date.now() - t0}ms`
              );
            } else if (result.cipherCorrupted) {
              // A cipher this key cannot read is an unknown amount, not 0: never shown or stored.
              if (applySnapshot(scope, readAt, pubBal, null, null)) markPrivateFailed(scope);
              logger.debug(
                `[refreshBalance] #${epoch} UI SET (${networkAtStart}) pub=${pubBal}, priv=UNKNOWN (cipher unreadable) - ${Date.now() - t0}ms`
              );
            } else {
              const privBal = parseFloat(result.encrypted.toFixed(6)).toString();
              const totBal = parseFloat(result.total.toFixed(6)).toString();
              if (applySnapshot(scope, readAt, pubBal, privBal, totBal)) {
                persistShown();
                appendSnapshot(
                  addr,
                  networkAtStart,
                  parseFloat(pubBal) || 0,
                  parseFloat(privBal) || 0
                ).catch(() => {});
                logger.debug(
                  `[refreshBalance] #${epoch} UI SET (${networkAtStart}) pub=${pubBal}, priv=${privBal}, total=${totBal} - ${Date.now() - t0}ms`
                );
              }
            }

            if (isStale()) return;

            setPvacLegacy(result.cipherLegacy === true);

            // Corruption fallback: if decrypt produced garbage, trigger key switch overlay
            // Grace period: skip corruption check for 60s after encrypt/decrypt to avoid
            // false positives while the on-chain cipher is being updated
            const gracePeriodActive = Date.now() - lastPrivacyOpRef.current < 60_000;
            const rotationPending = !!(await getPendingKeySwitch(keyScope));
            if (isStale()) return;
            if (result.cipherCorrupted && !gracePeriodActive && !rotationPending) {
              logger.warn(
                `[refreshBalance] #${epoch} Cipher corrupted for ${addr.slice(0, 8)}... - triggering key switch overlay`
              );
              pvacManager.pvacForeign = true;
              setPvacForeignState(true);
              try {
                chrome.storage.local.set({ [`pvac_corrupted_${networkAtStart}_${addr}`]: true });
              } catch {}
            } else if (
              result.cipher &&
              !result.cipherCorrupted &&
              !result.decryptSkipped &&
              result.encryptedRaw > 0
            ) {
              // The blocked-ack is NOT cleared here: a held/key_bound_unavailable balance stays
              // perfectly readable.
              try {
                chrome.storage.local.remove([`pvac_corrupted_${networkAtStart}_${addr}`]);
              } catch {}
            }

            const pvacCheckKey = `${networkAtStart}:${addr}`;
            if (
              pvacManager.isReady &&
              pvacCheckDoneRef.current !== pvacCheckKey &&
              pvacManager.currentKey === wallet.privateKey
            ) {
              pvacCheckDoneRef.current = pvacCheckKey;
              logger.debug(
                `[KeySwitchCheck] Starting background PVAC key check for ${addr.slice(0, 8)}...`
              );
              const keyCheckT0 = Date.now();
              // Wait for any in-flight PVAC re-init to complete before reading pubkey.
              // Without this, a wallet switch can cause serializePubkey to return the
              // PREVIOUS wallet's key, producing a false mismatch.
              (pvacManager.initPromise ?? Promise.resolve())
                .then(() => {
                  if (isStale()) {
                    logger.debug('[KeySwitchCheck] Stale after PVAC init wait - skipping');
                    return Promise.reject(new Error('stale'));
                  }
                  return resolveNetworkPin(networkAtStart).then((pin) =>
                    Promise.all([
                      pvacManager.getPublicKeyAsync(),
                      privacyNetworkService.getPvacPubkey(addr, pin),
                      pin,
                    ])
                  );
                })
                .then(async ([localPub, remotePub, pin]) => {
                  const elapsed = Date.now() - keyCheckT0;
                  const localLen = localPub?.length ?? 0;
                  const remoteLen = remotePub?.length ?? 0;
                  const localHash = localPub ? localPub.slice(0, 40) : 'null';
                  const remoteHash = remotePub ? remotePub.slice(0, 40) : 'null';

                  logger.debug(
                    `[KeySwitchCheck] Completed in ${elapsed}ms for ${addr.slice(0, 12)}...\n` +
                      `  Local pubkey:  ${localHash}... (${localLen} chars)\n` +
                      `  Remote pubkey: ${remoteHash}... (${remoteLen} chars)\n` +
                      `  Network: ${networkAtStart} | PVAC key source: ${pvacManager.currentKey?.slice(0, 8) ?? 'none'}...`
                  );

                  if (isStale()) {
                    logger.debug('[KeySwitchCheck] Stale - skipping');
                    return;
                  }
                  if (remotePub !== null && remotePub !== localPub) {
                    // PVAC pubkey compression is non-deterministic - WASM vs native produce different sizes
                    // Compare first 1000 chars as fingerprint (the actual key data, not compression padding)
                    const fingerprintLen = Math.min(1000, Math.min(localLen, remoteLen));
                    const localFingerprint = localPub!.slice(0, fingerprintLen);
                    const remoteFingerprint = remotePub.slice(0, fingerprintLen);
                    const sizeDiff = Math.abs(localLen - remoteLen);

                    if (localFingerprint === remoteFingerprint) {
                      logger.debug(
                        `[KeySwitchCheck] Keys MATCH (fingerprint) for ${addr.slice(0, 12)}... - size differs (local=${localLen}, remote=${remoteLen}, diff=${sizeDiff}) but key content identical\n` +
                          `  This is normal: WASM and native serialize PVAC pubkeys at different compression levels`
                      );
                      pvacManager.pvacForeign = false;
                      setPvacForeignState(false);
                      return;
                    }
                    // Bytes differ, but the same logical key can serialize differently
                    // (registration-era material/profile vs the current V5 writer output).
                    // Only the secret-profile check can tell drift from a genuinely foreign key.
                    let profileMatches = false;
                    try {
                      profileMatches = await pvacManager.matchesSecretProfile(remotePub);
                    } catch (e: any) {
                      logger.warn(`[KeySwitchCheck] secret profile check failed: ${e.message}`);
                    }
                    if (isStale()) return;
                    if (profileMatches) {
                      logger.debug(
                        `[KeySwitchCheck] Keys MATCH (secret profile) for ${addr.slice(0, 12)}... - registered key derives from our secret, container version differs (local=${localLen}, remote=${remoteLen})`
                      );
                      pvacManager.pvacForeign = false;
                      setPvacForeignState(false);
                    } else {
                      let divergeIdx = 0;
                      for (let i = 0; i < fingerprintLen; i++) {
                        if (localFingerprint[i] !== remoteFingerprint[i]) {
                          divergeIdx = i;
                          break;
                        }
                        if (i === fingerprintLen - 1) divergeIdx = fingerprintLen;
                      }

                      logger.warn(
                        `[KeySwitchCheck] MISMATCH for ${addr.slice(0, 12)}...\n` +
                          `  Keys diverge at char ${divergeIdx} (local=${localLen} chars, remote=${remoteLen} chars, sizeDiff=${sizeDiff})\n` +
                          `  Local[${divergeIdx}..${divergeIdx + 20}]:  ${localPub?.slice(divergeIdx, divergeIdx + 20) ?? ''}\n` +
                          `  Remote[${divergeIdx}..${divergeIdx + 20}]: ${remotePub.slice(divergeIdx, divergeIdx + 20)}\n` +
                          `  Possible causes:\n` +
                          `    - Different seed/HD path used by another client\n` +
                          `    - Another client re-registered its own key while this wallet was inactive`
                      );

                      const rotation = await resolveRotationState(
                        { ...pin, address: addr },
                        localPub!
                      );
                      if (isStale()) return;
                      if (rotation.kind === 'pending') {
                        const waitedMin = Math.round((Date.now() - rotation.submittedAt) / 60_000);
                        logger.warn(
                          `[KeySwitchCheck] Mismatch for ${addr.slice(0, 12)}... but rotation ${rotation.txHash.slice(0, 10)}... is pending (${waitedMin}m) - suppressing overlay`
                        );
                      } else if (rotation.kind === 'stuck') {
                        logger.warn(
                          `[KeySwitchCheck] Rotation ${rotation.txHash.slice(0, 10)}... for ${addr.slice(0, 12)}... confirmed but never applied by the node - not re-prompting`
                        );
                      } else {
                        pvacManager.pvacForeign = true;
                        setPvacForeignState(true);
                      }
                    }
                  } else if (remotePub !== null) {
                    // Keys match: a pending ROTATION record is fulfilled - clear it. NEVER clear
                    // a MIGRATION record here: migrations are same-key switches, so keys match
                    // the whole time the tx is still in staging; clearing re-offered Migrate
                    // while the key_switch was pending (double-submit bait).
                    const pendingRec = await getPendingKeySwitch(keyScope);
                    if (pendingRec && pendingRec.kind !== 'migration') {
                      await clearPendingKeySwitch(keyScope, pendingRec.txId);
                    }
                    if (isStale()) return;
                    if (pvacManager.lastDecryptCorrupted) {
                      logger.warn(
                        `[KeySwitchCheck] Keys MATCH but cipher corrupted for ${addr.slice(0, 12)}... - keeping overlay\n` +
                          `  This means the on-chain balance was encrypted with a DIFFERENT key that happened to produce the same pubkey (unlikely)\n` +
                          `  Or the cipher was corrupted during a failed encrypt/key_switch operation`
                      );
                    } else {
                      pvacManager.pvacForeign = false;
                      setPvacForeignState(false);
                      logger.debug(
                        `[KeySwitchCheck] Keys MATCH for ${addr.slice(0, 12)}... - no key switch needed`
                      );
                    }
                  } else {
                    // No key on-chain yet. Registration now costs a key_switch fee, so we don't do it
                    // in the background - the first user-initiated encrypt submits it (allowRegister).
                    logger.debug(
                      `[KeySwitchCheck] No remote key for ${addr.slice(0, 12)}... - will set up on first encrypt`
                    );
                  }
                })
                .catch((err) => {
                  if (err?.message === 'stale') return;
                  if (pvacCheckDoneRef.current === pvacCheckKey) pvacCheckDoneRef.current = null;
                  logger.warn(
                    `[KeySwitchCheck] Background check failed for ${addr.slice(0, 8)}...:`,
                    err
                  );
                });
            } else if (!pvacManager.isReady) {
              logger.debug(`[KeySwitchCheck] Skipped - pvacManager not ready yet`);
            } else if (pvacManager.currentKey !== wallet.privateKey) {
              logger.debug(`[KeySwitchCheck] Skipped - PVAC context stale (different wallet key)`);
            } else {
              logger.debug(`[KeySwitchCheck] Skipped - already checked for ${addr.slice(0, 8)}...`);
            }

            return;
          }
        }

        if (wallet?.privateKey) markPrivateFailed(scope);
        const at = performance.now();
        const result = await networkService.getBalance(addr, true);
        if (scopeGone()) return;
        if (result.success) {
          const pubBal = parseFloat(result.balance.toFixed(6)).toString();
          // A failed private read is not a zero private balance: keep the last snapshot's half.
          const applied = wallet?.privateKey
            ? applyPublic(scope, at, pubBal)
            : applySnapshot(scope, at, pubBal, null, null);
          if (!applied) return;
          persistShown();
          logger.debug(
            `[refreshBalance] #${epoch} UI SET (${networkAtStart}) fallback: pub=${pubBal} - ${Date.now() - t0}ms`
          );
        } else {
          logger.debug(`[refreshBalance] #${epoch} fallback failed in ${Date.now() - t0}ms`);
        }
      } catch (error) {
        logger.error(`[refreshBalance] #${epoch} failed in ${Date.now() - t0}ms:`, error);
      }
    },
    []
  );

  const adjustBalanceOptimistic = useCallback((pubDeltaOCT: number, privDeltaOCT: number) => {
    const fmt = (n: number) => parseFloat(n.toFixed(6)).toString();
    const s = shownRef.current;
    if (!s.scope || s.pub === null) return;
    const prev = optimisticRef.current;
    const keepBase = prev && prev.scope === s.scope && Date.now() <= prev.until;
    optimisticRef.current = {
      scope: s.scope,
      pub: keepBase ? prev.pub : parseFloat(s.pub),
      priv: keepBase ? prev.priv : toAmount(s.priv),
      until: Date.now() + OPTIMISTIC_HOLD_MS,
    };
    const at = performance.now();
    s.pub = fmt(parseFloat(s.pub) + pubDeltaOCT);
    if (s.priv !== null) s.priv = fmt(parseFloat(s.priv) + privDeltaOCT);
    if (s.total !== null) s.total = fmt(parseFloat(s.total) + pubDeltaOCT + privDeltaOCT);
    s.pubAt = at;
    s.fullAt = at;
    publishShown();
  }, []);

  const pollBalance = useCallback(async () => {
    const wallet = activeWalletRef.current;
    const addr = wallet?.address;
    if (!addr) return;
    const net = networkIdRef.current;
    const scope = balanceScope(net, addr);
    const s = shownRef.current;
    if (s.scope !== scope) return;
    const needsPrivate = !!wallet.privateKey && networkCapabilities(net).privacy;
    if (s.pub === null || (needsPrivate && s.total === null)) {
      await refreshBalance(addr, wallet, false, net);
      return;
    }
    try {
      const r = await networkService.getBalance(addr, true, await resolveNetworkPin(net));
      if (!r.success || r.balance === null || shownRef.current.scope !== scope) return;
      const pub = parseFloat(r.balance.toFixed(6));
      if (sameAmount(pub, toAmount(shownRef.current.pub))) return;
      await refreshBalance(addr, wallet, false, net);
    } catch {}
  }, [refreshBalance]);

  const switchWallet = async (address: string) => {
    try {
      let targetWallet = wallets.find((w) => w.address === address);
      if (!targetWallet) {
        const freshWallets = await walletStorage.loadAllWallets();
        targetWallet = freshWallets.find((w: any) => w.address === address);
      }
      if (!targetWallet) throw new Error('Wallet not found');

      const changed = activeWalletRef.current?.address !== targetWallet.address;
      const gen = ++loadGenRef.current;
      const net = networkIdRef.current;
      const [cached] = await Promise.all([
        readScope(net, targetWallet),
        walletStorage.setActiveWallet(targetWallet.id),
      ]);
      if (loadGenRef.current !== gen) return;

      if (networkService.balanceCache) networkService.balanceCache.clear();
      networkService.txDetailCache.clear();
      privacyNetworkService.clearDecryptCache();

      enterScope(targetWallet, net, cached);
      refreshBalance(targetWallet.address, targetWallet, true, net);
      if (changed) {
        showMessage(
          i18n.t('toast.switchedTo', {
            name: targetWallet.name,
            defaultValue: 'Switched to {{name}}',
          }) || `Switched to ${targetWallet.name}`,
          'info'
        );
      }
    } catch (error) {
      showMessage(plainError(error, i18n.t('toast.switchFailed')), 'error');
    }
  };

  const refreshWallets = useCallback(async () => {
    try {
      const allWallets = await walletStorage.loadAllWallets();
      setWallets(allWallets);

      if (allWallets.length > 0) {
        const gen = loadGenRef.current;
        const activeId = await walletStorage.getActiveWalletId();
        let walletData = allWallets.find((w) => w.id === activeId);

        if (!walletData) {
          walletData = allWallets[0];
          await walletStorage.setActiveWallet(walletData.id);
        }

        const net = networkIdRef.current;
        const cached =
          shownRef.current.scope === balanceScope(net, walletData.address)
            ? null
            : await readScope(net, walletData);
        if (loadGenRef.current !== gen || networkIdRef.current !== net) return;
        enterScope(walletData, net, cached);
        refreshBalance(walletData.address, walletData, true, net);
      } else {
        setActiveWallet(null);
      }
    } catch (error) {
      logger.error('Failed to refresh wallets:', error);
    }
  }, [refreshBalance]);

  const showMessage = (
    text: string,
    type: 'success' | 'error' | 'warning' | 'processing' | 'info' = 'info'
  ) => {
    setMessage({ id: ++messageSeq.current, text, type });
  };
  const hideMessage = (id?: number) =>
    setMessage((m) => (id === undefined || m?.id === id ? null : m));

  const viewScope = activeWallet?.address ? balanceScope(networkId, activeWallet.address) : '';
  const liveShown = viewScope !== '' && shown.scope === viewScope;

  return (
    <WalletContext.Provider
      value={{
        isInitialized,
        isLocked,
        isLoading,
        activeWallet,
        wallets,
        balance: liveShown ? shown.pub : null,
        privateBalance: liveShown ? shown.priv : null,
        totalBalance: liveShown ? shown.total : null,
        privateUnavailable: liveShown && shown.privFailed && shown.total === null,
        message,
        requiresMigrationPassword,
        isMigrating,
        migrationError,
        migrateLegacyWallet,
        clearMigrationState,
        unlockWallet,
        lockWallet,
        refreshBalance,
        pollBalance,
        adjustBalanceOptimistic,
        refreshWallets,
        switchWallet,
        showMessage,
        hideMessage,
        walletStorage,
        passwordManager,
        showBalanceValues,
        setShowBalanceValues,
        passwordSkipped,
        networkId,
        pvacForeign,
        setPvacForeign,
        pvacLegacy,
        setPvacLegacy,
        markPrivacyOp,
      }}
    >
      {children}
    </WalletContext.Provider>
  );
};

export const useWallet = (): WalletContextValue => {
  const context = useContext(WalletContext);
  if (context === undefined) {
    throw new Error('useWallet must be used within a WalletProvider');
  }
  return context;
};
