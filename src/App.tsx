import { lazyScreen } from 'src/utils/lazyScreen';
import React, { useEffect, useMemo, Suspense, createContext, useContext } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import {
  MemoryRouter as Router,
  Navigate,
  Routes,
  Route,
  useLocation,
  useNavigate,
} from 'src/lib/router';
import { WalletProvider, useWallet } from 'src/contexts/WalletContext';
import { ThemeProvider } from 'src/contexts/ThemeContext';
import Header from 'src/shared/ui/Header';
import MessageToast from 'src/shared/ui/MessageToast';
import KeySwitchOverlay from 'src/shared/ui/KeySwitchOverlay';
import LoadingSpinner from 'src/shared/ui/LoadingSpinner';
import { useDesktopSync } from 'src/hooks/wallet/useDesktopSync';
import { pvacManager } from 'src/services/pvac/PvacManager';
import DesktopPairSheet from 'src/features/settings/components/DesktopPairSheet';
import { useStartDesktopPairing } from 'src/hooks/wallet/useStartDesktopPairing';
import { useTranslation } from 'src/i18n/react';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { Monitor } from 'src/shared/ui/icons';
import { loadCustomNetworks, syncCustomNetworks, ZeroXIOConfig } from 'src/utils/config';
import SiteChip from 'src/features/dapp/components/SiteChip';
import { logger } from 'src/utils/logger';

import MainScreen from 'src/features/wallet/screens/MainScreen';
import CollectiblesScreen from 'src/features/wallet/screens/CollectiblesScreen';
import LockScreen from 'src/features/security/screens/LockScreen';
import useRouteTransition from 'src/hooks/ui/useRouteTransition';
import OnboardingScreen from 'src/features/wallet/screens/OnboardingScreen';
import SetupScreen from 'src/features/wallet/screens/SetupScreen';
import WhatsNewSheet from 'src/features/wallet/home/WhatsNewSheet';

const WalletListScreen = lazyScreen(() => import('src/features/wallet/screens/WalletListScreen'));
const SettingsScreen = lazyScreen(() => import('src/features/settings/screens/SettingsScreen'));
const SendScreen = lazyScreen(() => import('src/features/transactions/screens/SendScreen'));
const EvmSendScreen = lazyScreen(() => import('src/features/transactions/screens/EvmSendScreen'));
const ReceiveScreen = lazyScreen(() => import('src/features/wallet/screens/ReceiveScreen'));
const HistoryScreen = lazyScreen(() => import('src/features/transactions/screens/HistoryScreen'));
const PrivacyScreen = lazyScreen(() => import('src/features/privacy/screens/PrivacyScreen'));
const BridgeScreen = lazyScreen(() => import('src/features/bridge/screens/BridgeScreen'));
const ClaimScreen = lazyScreen(() => import('src/features/bridge/screens/ClaimScreen'));
const SecurityBackupScreen = lazyScreen(
  () => import('src/features/settings/screens/SecurityBackupScreen')
);
const AddressBookScreen = lazyScreen(
  () => import('src/features/settings/screens/AddressBookScreen')
);
const PreferencesScreen = lazyScreen(
  () => import('src/features/settings/screens/PreferencesScreen')
);
const ConnectedDappsScreen = lazyScreen(
  () => import('src/features/settings/screens/ConnectedDappsScreen')
);
const ConnectedSiteScreen = lazyScreen(
  () => import('src/features/settings/screens/ConnectedSiteScreen')
);
const SiteConnectScreen = lazyScreen(() => import('src/features/dapp/screens/SiteConnectScreen'));
const SiteSwitchScreen = lazyScreen(() => import('src/features/dapp/screens/SiteSwitchScreen'));
const EvmSettingsScreen = lazyScreen(
  () => import('src/features/settings/screens/EvmSettingsScreen')
);
const NetworksScreen = lazyScreen(() => import('src/features/settings/screens/NetworksScreen'));
const TokensNftsScreen = lazyScreen(() => import('src/features/settings/screens/TokensNftsScreen'));
const NetworkDetailScreen = lazyScreen(
  () => import('src/features/settings/screens/NetworkDetailScreen')
);
const ConnectionsScreen = lazyScreen(
  () => import('src/features/settings/screens/ConnectionsScreen')
);
const DAppApprovalScreen = lazyScreen(() => import('src/features/dapp/screens/DAppApprovalScreen'));
const EvmApprovalScreen = lazyScreen(() => import('src/features/dapp/screens/EvmApprovalScreen'));
const TransactionApprovalScreen = lazyScreen(
  () => import('src/features/transactions/screens/TransactionApprovalScreen')
);
const MessageApprovalScreen = lazyScreen(
  () => import('src/features/dapp/screens/MessageApprovalScreen')
);
const TxDetailScreen = lazyScreen(() => import('src/features/transactions/screens/TxDetailScreen'));
const BackupScreen = lazyScreen(() => import('src/features/wallet/screens/BackupScreen'));

const UNDER_FOOTER_PATHS = new Set(['/', '/history']);

const HIDE_HEADER_PATHS = new Set([
  '/onboarding',
  '/setup',
  '/lock',
  '/wallet-details',
  '/collectibles',
  '/settings',
  '/send',
  '/send/evm',
  '/receive',
  '/backup',
  '/claim',
  '/privacy',
  '/bridge',
  '/bridge/claim',
  '/walletlist',
  '/history',
  '/settings/security',
  '/settings/backup',
  '/settings/appearance',
  '/settings/network',
  '/settings/connections',
  '/settings/preferences',
  '/settings/connected-dapps',
  '/settings/connected-site',
  '/site/connect',
  '/site/switch',
  '/settings/addressbook',
  '/settings/evm',
  '/settings/networks',
  '/settings/tokens-nfts',
  '/tx',
]);

const redirectFor = (path: string, isInitialized: boolean, isLocked: boolean): string | null => {
  const publicPaths = ['/onboarding', '/setup', '/wallet-details'];
  const approvalPath =
    path.startsWith('/dapp-approval/') ||
    path.startsWith('/approve-transaction/') ||
    path.startsWith('/approve-message/') ||
    path.startsWith('/evm-approval/');
  if (approvalPath || path === '/setup') return null;
  if (!isInitialized && !publicPaths.includes(path)) return '/onboarding';
  if (isInitialized && isLocked && path !== '/lock') return '/lock';
  if (isInitialized && !isLocked && (path === '/onboarding' || path === '/lock')) return '/';
  return null;
};

const RouteGuard = ({ children }: { children: React.ReactNode }) => {
  const { isInitialized, isLocked, isLoading } = useWallet();
  const navigate = useNavigate();
  const location = useLocation();
  const target = isLoading ? null : redirectFor(location.pathname, isInitialized, isLocked);

  // effect:audited - navigation guard reacts to auth/lock state changes
  useEffect(() => {
    if (target) navigate(target, { replace: true });
  }, [target, navigate]);

  if (isLoading) {
    return <LoadingSpinner fullScreen text="Loading" />;
  }

  if (target) return <div className="h-full! w-full! bg-(--bg)!" />;

  return children;
};

const LayoutContext = createContext({ isFullscreen: false });

const useLayout = () => useContext(LayoutContext);

const RouteFallback = () => (
  <div className="flex-1 flex items-center justify-center">
    <LoadingSpinner text="" />
  </div>
);

const NetworkDropdown = ({ networkId }: { networkId: string }) => {
  const { t } = useTranslation();
  const [open, setOpen] = React.useState(false);
  const [switching, setSwitching] = React.useState(false);
  const [customNets, setCustomNets] = React.useState<
    { id: string; label: string; color: string }[]
  >([]);
  const ref = React.useRef<HTMLDivElement>(null);

  useMountEffect(() => {
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handler);
    const loadCustom = () =>
      loadCustomNetworks()
        .then((nets) => {
          syncCustomNetworks(nets);
          setCustomNets(
            nets.map((n) => ({ id: n.id, label: n.name, color: n.color || '#9b8cff' }))
          );
        })
        .catch(() => {});
    loadCustom();
    const onStorage = (changes: { [key: string]: chrome.storage.StorageChange }) => {
      if (changes[ZeroXIOConfig.STORAGE.KEYS.CUSTOM_NETWORKS]) loadCustom();
    };
    chrome.storage.onChanged.addListener(onStorage);
    return () => {
      document.removeEventListener('mousedown', handler);
      chrome.storage.onChanged.removeListener(onStorage);
    };
  });

  const switchTo = async (id: string) => {
    if (id === networkId || switching) {
      logger.debug(
        `[Network] switch ignored: ${id === networkId ? 'same network' : 'already switching'}`
      );
      setOpen(false);
      return;
    }
    logger.info(`[Network] switching ${networkId} -> ${id}`);
    setSwitching(true);
    await chrome.storage.local.set({ [ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]: id });
    logger.info(`[Network] switched to ${id}`);
    setOpen(false);
    setTimeout(() => setSwitching(false), 1000);
  };

  const builtIn = [
    {
      id: 'mainnet',
      label: t('footer.mainnet', { defaultValue: 'Mainnet' }),
    },
    {
      id: 'devnet',
      label: t('footer.testnet', { defaultValue: 'Testnet' }),
    },
  ];
  const chipLabel =
    builtIn.find((n) => n.id === networkId)?.label ??
    customNets.find((n) => n.id === networkId)?.label ??
    builtIn[0].label;

  return (
    <div className="relative!" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="footer-chip press"
      >
        <span className="footer-dot" style={{ background: 'var(--fg-2)' }} />
        <span className="truncate! max-w-28!">{chipLabel}</span>
      </button>

      {open && (
        <div
          role="menu"
          className="footer-menu animate-in! fade-in! duration-150!"
          style={{ right: 0 }}
        >
          {[...builtIn, ...customNets.map((n) => ({ id: n.id, label: n.label }))].map((n) => (
            <button
              key={n.id}
              role="menuitemradio"
              aria-checked={n.id === networkId}
              onClick={() => switchTo(n.id)}
              disabled={switching}
              className="footer-menu-row"
              data-on={n.id === networkId || undefined}
            >
              <span style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--fg)' }}>
                {n.label}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const SyncIndicator = () => {
  const {
    connected: desktopConnected,
    keygenMismatch: desktopKeygenMismatch,
    reconnect,
    reconnecting,
    status: desktopStatus,
    outdated: desktopOutdated,
  } = useDesktopSync();
  const startPairing = useStartDesktopPairing();
  const { t } = useTranslation();
  const { isInitialized, isLocked, networkId, showMessage, activeWallet } = useWallet();
  const { view } = useHomeView();
  const mismatchNotified = React.useRef(false);

  const handleReconnect = async () => {
    if (reconnecting || desktopConnected) return;
    if (desktopStatus === 'not_paired' || desktopStatus === 'unverified') {
      void startPairing();
      return;
    }
    const ok = await reconnect(activeWallet?.privateKey);
    if (ok) return;
    if (pvacManager.desktopStatus === 'not_paired' || pvacManager.desktopStatus === 'unverified') {
      void startPairing();
      return;
    }
    showMessage(t(desktopOutdated() ? 'toast.desktopOutdated' : 'toast.desktopNotFound'), 'info');
  };

  // effect:audited - one-time notice when a connected desktop is found to run a divergent keygen, so
  // the user knows why proofs are computing in-browser (not silently ignoring the desktop they opened)
  React.useEffect(() => {
    if (desktopKeygenMismatch && !mismatchNotified.current) {
      mismatchNotified.current = true;
      showMessage(t('toast.desktopMismatch'), 'info');
    } else if (!desktopKeygenMismatch) {
      mismatchNotified.current = false;
    }
  }, [desktopKeygenMismatch, showMessage, t]);

  if (!isInitialized || isLocked) return null;

  const desktopTitle = desktopKeygenMismatch
    ? t('footer.desktopMismatch', {
        defaultValue: '0xio Desktop is a different version. Private proofs run in this browser.',
      })
    : desktopConnected
      ? t('footer.desktopOn', { defaultValue: '0xio Desktop is running private proofs.' })
      : desktopStatus === 'unverified'
        ? t('footer.desktopUnverified', {
            defaultValue:
              '0xio Desktop could not be verified. Private proofs run in this browser. Tap to pair again.',
          })
        : desktopStatus === 'not_paired'
          ? t('footer.desktopNotPaired', {
              defaultValue: '0xio Desktop is open but not paired. Tap to pair it.',
            })
          : desktopStatus === 'outdated'
            ? t('footer.desktopUpdate', {
                defaultValue: 'Update 0xio Desktop to pair. Private proofs run in this browser.',
              })
            : reconnecting
              ? t('footer.desktopConnecting', { defaultValue: 'Connecting to 0xio Desktop' })
              : t('footer.desktopOff', {
                  defaultValue:
                    '0xio Desktop is not running. Private proofs run in this browser. Open Desktop to run them faster.',
                });

  return (
    <div
      className="footer-bar flex! items-center! justify-between!"
      style={{ height: 'var(--footer-h)', padding: '0 var(--gutter)' }}
    >
      <SiteChip />
      <div className="flex! items-center! shrink-0!" style={{ gap: '6px' }}>
        {view !== 'evm' && (
          <button
            type="button"
            onClick={() => void handleReconnect()}
            disabled={reconnecting || desktopConnected}
            className="footer-chip press"
            title={desktopTitle}
            aria-label={desktopTitle}
            style={{ position: 'relative', cursor: desktopConnected ? 'default' : 'pointer' }}
          >
            <Monitor
              size={12}
              className={reconnecting ? 'animate-pulse!' : ''}
              style={{ color: desktopConnected ? 'var(--fg)' : 'var(--fg-3)' }}
            />
            {(desktopConnected || desktopKeygenMismatch || desktopStatus === 'unverified') && (
              <span
                className="footer-dot"
                style={{
                  position: 'absolute',
                  top: '4px',
                  right: '6px',
                  width: '5px',
                  height: '5px',
                  background: desktopConnected ? 'var(--pos)' : 'var(--fg-2)',
                }}
              />
            )}
          </button>
        )}
        <NetworkDropdown networkId={networkId} />
      </div>
    </div>
  );
};

const AppLayout = () => {
  const { isFullscreen } = useLayout();
  const location = useLocation();
  const { message, hideMessage, pvacForeign } = useWallet();

  const routeEnter = useRouteTransition(location.pathname);

  const hideHeader = useMemo(
    () =>
      HIDE_HEADER_PATHS.has(location.pathname) ||
      location.pathname.startsWith('/settings/networks/') ||
      location.pathname.startsWith('/dapp-approval/') ||
      location.pathname.startsWith('/approve-transaction/') ||
      location.pathname.startsWith('/approve-message/') ||
      location.pathname.startsWith('/evm-approval/'),
    [location.pathname]
  );

  return (
    <div
      className={`app-shell relative h-full flex flex-col overflow-hidden bg-(--bg-main) text-(--text-main) transition-colors duration-300 ${isFullscreen ? 'layout-wide' : 'layout-popup'}`}
    >
      {message && (
        <MessageToast
          key={message.id}
          message={message.text}
          type={message.type}
          onClose={() => hideMessage(message.id)}
        />
      )}
      {pvacForeign && <KeySwitchOverlay />}
      <DesktopPairSheet />

      {!hideHeader && <Header showWalletSelector={location.pathname === '/'} />}

      <div
        className={`app-content flex-1 overflow-hidden relative flex flex-col ${
          UNDER_FOOTER_PATHS.has(location.pathname) ? 'under-footer' : ''
        }`}
      >
        <Suspense fallback={<RouteFallback />}>
          <div key={location.pathname} className={`route-screen ${routeEnter}`}>
            <Routes location={location}>
              <Route path="/" element={<MainScreen />} />
              <Route path="/collectibles" element={<CollectiblesScreen />} />
              <Route path="/onboarding" element={<OnboardingScreen />} />
              <Route path="/setup" element={<SetupScreen />} />
              <Route path="/lock" element={<LockScreen />} />
              <Route path="/walletlist" element={<WalletListScreen />} />
              <Route path="/settings" element={<SettingsScreen />} />
              <Route path="/send" element={<SendScreen />} />
              <Route path="/send/evm" element={<EvmSendScreen />} />
              <Route path="/receive" element={<ReceiveScreen />} />
              <Route path="/backup" element={<BackupScreen />} />
              <Route path="/history" element={<HistoryScreen />} />
              <Route path="/claim" element={<Navigate to="/privacy" replace />} />
              <Route path="/privacy" element={<PrivacyScreen />} />
              <Route path="/bridge" element={<BridgeScreen />} />
              <Route path="/bridge/claim" element={<ClaimScreen />} />
              <Route path="/settings/security" element={<SecurityBackupScreen view="security" />} />
              <Route path="/settings/backup" element={<SecurityBackupScreen view="backup" />} />
              <Route
                path="/settings/appearance"
                element={<PreferencesScreen view="appearance" />}
              />
              <Route path="/settings/network" element={<PreferencesScreen view="network" />} />
              <Route
                path="/settings/preferences"
                element={<PreferencesScreen view="appearance" />}
              />
              <Route path="/settings/connections" element={<ConnectionsScreen />} />
              <Route path="/settings/connected-dapps" element={<ConnectedDappsScreen />} />
              <Route path="/settings/connected-site" element={<ConnectedSiteScreen />} />
              <Route path="/site/connect" element={<SiteConnectScreen />} />
              <Route path="/site/switch" element={<SiteSwitchScreen />} />
              <Route path="/settings/addressbook" element={<AddressBookScreen />} />
              <Route
                path="/settings/imported-tokens"
                element={<Navigate to="/settings/tokens-nfts" replace />}
              />
              <Route path="/settings/evm" element={<EvmSettingsScreen />} />
              <Route path="/settings/networks" element={<NetworksScreen />} />
              <Route path="/settings/networks/:chainId" element={<NetworkDetailScreen />} />
              <Route path="/settings/tokens-nfts" element={<TokensNftsScreen />} />
              <Route path="/dapp-approval/:approvalId" element={<DAppApprovalScreen />} />
              <Route
                path="/approve-transaction/:approvalId"
                element={<TransactionApprovalScreen />}
              />
              <Route path="/approve-message/:approvalId" element={<MessageApprovalScreen />} />
              <Route path="/evm-approval/:approvalId" element={<EvmApprovalScreen />} />
              <Route path="/tx" element={<TxDetailScreen />} />
            </Routes>
          </div>
        </Suspense>
      </div>

      {location.pathname === '/' && <WhatsNewSheet />}

      {![
        '/dapp-approval/',
        '/approve-transaction/',
        '/approve-message/',
        '/evm-approval/',
        '/site/',
      ].some((p) => location.pathname.startsWith(p)) && <SyncIndicator />}
    </div>
  );
};

const App = ({ isFullscreen }: { isFullscreen: boolean }) => {
  return (
    <LayoutContext.Provider value={{ isFullscreen }}>
      <Router initialEntries={[window.location.hash.replace(/^#/, '') || '/']}>
        <ThemeProvider>
          <WalletProvider>
            <RouteGuard>
              <AppLayout />
            </RouteGuard>
          </WalletProvider>
        </ThemeProvider>
      </Router>
    </LayoutContext.Provider>
  );
};

export default App;
