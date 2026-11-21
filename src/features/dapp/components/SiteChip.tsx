import React, { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { Unplug } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { useDismiss } from 'src/hooks/ui/useDismiss';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useSiteConnections } from 'src/hooks/dapp/useSiteConnections';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { networksFor, type ManagedEvmNetwork } from 'src/services/evm/registry';
import { siteChainId } from 'src/background/services/evmSites';
import { middleCut } from 'src/features/wallet/add/format';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { sanitizeText } from 'src/lib/sanitize';
import { logger } from 'src/utils/logger';
import type { Wallet } from 'src/types/wallet';
import { desktopNetworkLabel, siteChipState } from '../siteWallets';
import { desktopSiteMessage, evmSiteMessage, revokeOctraSite } from '../siteActions';
import DesktopMark from './DesktopMark';

const MenuWallet = ({
  wallet,
  address,
  on,
  onClick,
}: {
  wallet: Wallet;
  address: string;
  on?: boolean;
  onClick?: () => void;
}) => (
  <button
    type="button"
    role="menuitem"
    onClick={onClick}
    aria-disabled={!onClick || undefined}
    className="footer-menu-row"
    data-on={on || undefined}
    style={{
      flexDirection: 'row',
      alignItems: 'center',
      gap: '8px',
      cursor: onClick ? 'pointer' : 'default',
    }}
  >
    <WalletAvatar address={wallet.address} size={16} />
    <span
      className="truncate! flex-1!"
      style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg)', textAlign: 'left' }}
    >
      {sanitizeText(wallet.name)}
    </span>
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: '10.5px', color: 'var(--fg-3)' }}>
      {middleCut(address, 6, 4)}
    </span>
  </button>
);

const MenuCaps = ({ children }: { children: React.ReactNode }) => (
  <div className="tab-caps" style={{ color: 'var(--fg-3)', padding: '10px 10px 4px' }}>
    {children}
  </div>
);

const SiteChip = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, wallets, networkId, showMessage } = useWallet();
  const sites = useSiteConnections();
  const [tab, setTab] = useState<{ origin: string | null; host: string | null } | null>(null);
  const [menu, setMenu] = useState(false);
  const [chains, setChains] = useState<{
    origin: string;
    side: string;
    list: ManagedEvmNetwork[];
    current: number;
  } | null>(null);
  const [chainOpen, setChainOpen] = useState(false);
  const [chainBusy, setChainBusy] = useState<number | null>(null);
  const close = () => {
    setMenu(false);
    setChainOpen(false);
  };
  const ref = useDismiss<HTMLDivElement>(menu, close);
  const side = networkId === 'devnet' ? 'testnet' : 'mainnet';

  useMountEffect(() => {
    let live = true;
    chrome.tabs
      .query({ active: true, currentWindow: true })
      .then((tabs) => {
        if (!live) return;
        try {
          const url = new URL(tabs[0]?.url ?? '');
          const web = url.protocol === 'https:' || url.protocol === 'http:';
          setTab({ origin: web ? url.origin : null, host: web ? url.hostname : null });
        } catch {
          setTab({ origin: null, host: null });
        }
      })
      .catch(() => live && setTab({ origin: null, host: null }));
    return () => {
      live = false;
    };
  });

  if (!tab || !sites.loaded || !activeWallet) return null;

  const state = siteChipState(tab.origin, sites, activeWallet.id, wallets, networkId);

  const toggle = () => {
    if (state.kind === 'join') {
      navigate('/site/connect', { state: { origin: state.origin } });
      return;
    }
    if (menu) {
      close();
      return;
    }
    setMenu(true);
    if (state.kind !== 'evm') return;
    const at = state.origin;
    Promise.all([networksFor(networkId), siteChainId(at)])
      .then(([list, current]) => setChains({ origin: at, side, list, current }))
      .catch(() => setChains(null));
  };

  const shown =
    state.kind === 'evm' &&
    chains?.origin === state.origin &&
    chains.side === side &&
    chains.list.length > 0
      ? chains
      : null;

  const pickChain = async (chainId: number) => {
    if (state.kind !== 'evm' || !shown || chainBusy !== null) return;
    if (chainId === shown.current) {
      setChainOpen(false);
      return;
    }
    setChainBusy(chainId);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'EVM_SITE_SET_CHAIN',
        origin: state.origin,
        chainId,
        walletId: state.wallets[0].wallet.id,
        side: shown.side,
      });
      if (!res?.success) throw new Error('chain not changed');
      setChains((c) => (c && c.origin === shown.origin ? { ...c, current: chainId } : c));
      setChainOpen(false);
    } catch (e) {
      logger.error('Site chain pick from the status bar failed:', e);
      showMessage(
        t('footer.chainFailed', { defaultValue: 'Could not switch network. Try again.' }),
        'error'
      );
    } finally {
      setChainBusy(null);
    }
  };

  const disconnect = async () => {
    close();
    try {
      if (state.kind === 'evm') {
        if (!(await evmSiteMessage('EVM_SITE_DISCONNECT', state.origin))) {
          throw new Error('not disconnected');
        }
      } else if (state.kind === 'octra') {
        await revokeOctraSite(state.origin, state.site.key);
      } else if (state.kind === 'desktop') {
        if (!(await desktopSiteMessage('DESKTOP_SITE_DISCONNECT', state.site))) {
          throw new Error('not disconnected');
        }
      }
    } catch (e) {
      logger.error('Disconnect from the status bar failed:', e);
      showMessage(t('toast.revokeFailed'), 'error');
    }
  };

  const moveHere = async () => {
    if (state.kind !== 'desktop') return;
    close();
    if (!(await desktopSiteMessage('DESKTOP_SITE_MOVE', state.site))) {
      showMessage(
        t('desktopSites.moveFailed', { defaultValue: 'Could not move the site. Try again.' }),
        'error'
      );
    }
  };

  const notConnectedTitle = tab.host
    ? t('footer.notConnectedTitle', { host: tab.host, defaultValue: '{{host}} is not connected' })
    : t('footer.noSiteTitle', { defaultValue: 'No site is open in this tab' });

  const connected = state.kind === 'evm' || state.kind === 'octra' || state.kind === 'desktop';
  const host =
    state.kind === 'evm' || state.kind === 'octra' || state.kind === 'desktop' ? state.host : '';
  const inUse =
    state.kind === 'evm' ? state.wallets[0].wallet : state.kind === 'octra' ? state.wallet : null;
  const onOpen =
    state.kind === 'evm'
      ? inUse?.id === activeWallet.id
      : state.kind === 'octra'
        ? !state.site.address || state.site.address === activeWallet.address
        : false;

  return (
    <div
      ref={ref}
      className="relative! min-w-0!"
      style={{ opacity: sites.refreshing ? 0.5 : 1, transition: 'opacity 200ms ease-out' }}
    >
      {connected ? (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={menu}
          aria-haspopup="menu"
          className="footer-chip press"
          title={host}
          style={{ maxWidth: '100%' }}
        >
          {state.kind === 'desktop' ? (
            <DesktopMark size={14} />
          ) : onOpen || !inUse ? (
            <span className="footer-dot" style={{ background: 'var(--pos)' }} />
          ) : (
            <WalletAvatar address={inUse.address} size={12} />
          )}
          <span className="truncate! max-w-40!">{host}</span>
        </button>
      ) : (
        <button
          type="button"
          onClick={toggle}
          aria-expanded={state.kind === 'none' ? menu : undefined}
          aria-haspopup={state.kind === 'none' ? 'dialog' : undefined}
          className="footer-plain press"
          title={notConnectedTitle}
        >
          <Unplug size={12} style={{ color: 'var(--fg-2)' }} />
          <span>{t('footer.notConnected', { defaultValue: 'Not connected' })}</span>
        </button>
      )}
      {menu && state.kind === 'none' && (
        <div
          role="dialog"
          className="footer-menu animate-in! fade-in! duration-150!"
          style={{ left: 0, padding: '12px 12px 10px', width: '240px' }}
        >
          <div style={{ fontSize: '12.5px', fontWeight: 600, color: 'var(--fg)' }}>
            {notConnectedTitle}
          </div>
          <button
            type="button"
            onClick={() => {
              close();
              navigate('/settings/connected-dapps');
            }}
            style={{
              marginTop: '10px',
              padding: 0,
              border: 'none',
              background: 'transparent',
              cursor: 'pointer',
              fontSize: '12px',
              fontWeight: 600,
              color: 'var(--accent)',
            }}
          >
            {t('footer.connectedSites', { defaultValue: 'Connected sites' })}
          </button>
        </div>
      )}
      {menu && connected && (
        <div
          role="menu"
          className="footer-menu animate-in! fade-in! duration-150!"
          style={{ left: 0, width: '260px', maxHeight: '420px', overflowY: 'auto' }}
        >
          <div
            className="truncate!"
            style={{ padding: '9px 10px 0', fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}
          >
            {host}
          </div>
          {state.kind === 'desktop' ? (
            <>
              <div
                className="truncate!"
                style={{ padding: '2px 10px 0', fontSize: '11px', color: 'var(--fg-3)' }}
              >
                {state.origin}
              </div>
              <MenuCaps>{t('desktopSites.signsWith', { defaultValue: 'Signs with' })}</MenuCaps>
              <div
                className="footer-menu-row"
                data-on
                style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}
              >
                <DesktopMark size={22} />
                <span className="flex! flex-col! min-w-0!" style={{ gap: '2px' }}>
                  <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>
                    {t('desktopSites.desktop', { defaultValue: '0xio Desktop' })}
                  </span>
                  <span className="flex! items-center! min-w-0!" style={{ gap: '5px' }}>
                    <WalletAvatar address={state.site.wallet.seed} size={10} />
                    <span
                      className="truncate!"
                      style={{ fontSize: '10.5px', color: 'var(--fg-2)' }}
                    >
                      {sanitizeText(state.site.wallet.name)}
                    </span>
                    <span
                      style={{
                        fontFamily: 'var(--font-mono)',
                        fontSize: '10.5px',
                        color: 'var(--fg-3)',
                      }}
                    >
                      {middleCut(state.site.address, 6, 4)}
                    </span>
                  </span>
                </span>
              </div>
              <div
                className="footer-menu-row"
                style={{ marginTop: '4px', flexDirection: 'row', alignItems: 'center' }}
              >
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>
                  {t('footer.chain', { defaultValue: 'Network' })}
                </span>
                <span style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--fg-2)' }}>
                  {desktopNetworkLabel(state.site.network)}
                </span>
              </div>
              <button
                type="button"
                role="menuitem"
                onClick={() => void moveHere()}
                className="footer-menu-row"
                style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}
              >
                <WalletAvatar address={activeWallet.address} size={16} />
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>
                  {t('desktopSites.moveHere', { defaultValue: 'Move to this browser' })}
                </span>
              </button>
            </>
          ) : (
            <MenuCaps>
              {t('footer.connectedWallets', { defaultValue: 'Connected wallets' })}
            </MenuCaps>
          )}
          {state.kind === 'evm' &&
            state.wallets.map((c, i) => (
              <MenuWallet
                key={c.wallet.id}
                wallet={c.wallet}
                address={c.address}
                on={i === 0}
                onClick={
                  i === 0
                    ? undefined
                    : () => {
                        close();
                        navigate('/site/switch', {
                          state: { origin: state.origin, walletId: c.wallet.id },
                        });
                      }
                }
              />
            ))}
          {state.kind === 'octra' && state.wallet && (
            <MenuWallet wallet={state.wallet} address={state.wallet.address} on />
          )}
          {state.kind === 'evm' && state.others.length > 0 && (
            <>
              <MenuCaps>
                {t('footer.connectAnother', { defaultValue: 'Connect another wallet' })}
              </MenuCaps>
              {state.others.map((c) => (
                <MenuWallet
                  key={c.wallet.id}
                  wallet={c.wallet}
                  address={c.address}
                  onClick={() => {
                    close();
                    navigate('/site/connect', {
                      state: { origin: state.origin, walletId: c.wallet.id },
                    });
                  }}
                />
              ))}
            </>
          )}
          {shown && (
            <>
              <button
                type="button"
                role="menuitem"
                aria-expanded={chainOpen}
                onClick={() => setChainOpen((o) => !o)}
                className="footer-menu-row"
                style={{
                  marginTop: '4px',
                  flexDirection: 'row',
                  alignItems: 'center',
                  gap: '10px',
                }}
              >
                <span style={{ fontSize: '12px', fontWeight: 600, color: 'var(--fg)' }}>
                  {t('footer.chain', { defaultValue: 'Network' })}
                </span>
                <span
                  className="truncate!"
                  style={{ marginLeft: 'auto', fontSize: '11.5px', color: 'var(--fg-2)' }}
                >
                  {shown.list.find((n) => n.chainId === shown.current)?.name ??
                    t('networks.chainLabel', { id: shown.current, defaultValue: 'Chain {{id}}' })}
                </span>
              </button>
              {chainOpen && (
                <div
                  role="group"
                  aria-label={t('footer.chain', { defaultValue: 'Network' })}
                  className="animate-in! fade-in! duration-200!"
                  style={{ maxHeight: '196px', overflowY: 'auto', padding: '2px 0' }}
                >
                  {shown.list.map((n) => (
                    <button
                      key={n.chainId}
                      type="button"
                      role="menuitemradio"
                      aria-checked={n.chainId === shown.current}
                      onClick={() => void pickChain(n.chainId)}
                      disabled={chainBusy !== null}
                      className="footer-menu-row"
                      data-on={n.chainId === shown.current || undefined}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: '8px' }}
                    >
                      <NetworkLogo network={n} size={16} />
                      <span
                        className="truncate!"
                        style={{ fontSize: '12px', fontWeight: 500, color: 'var(--fg)' }}
                      >
                        {n.name}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}
          <button
            type="button"
            role="menuitem"
            onClick={() => void disconnect()}
            className="footer-menu-row"
            style={{ marginTop: '4px', color: 'var(--neg)' }}
          >
            <span style={{ fontSize: '12px', fontWeight: 600 }}>
              {t('footer.disconnect', { defaultValue: 'Disconnect' })}
            </span>
          </button>
        </div>
      )}
    </div>
  );
};

export default SiteChip;
