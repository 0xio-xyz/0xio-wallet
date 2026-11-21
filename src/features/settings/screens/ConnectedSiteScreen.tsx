import { useState } from 'react';
import { useLocation, useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { Plus } from 'src/shared/ui/icons';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import Header from 'src/shared/ui/Header';
import WalletAvatar from 'src/shared/ui/WalletAvatar';
import { OctraGlyph } from 'src/shared/ui/ChainGlyph';
import {
  ListRow,
  PrimaryButton,
  RuledList,
  SectionLabel,
  Sheet,
  TextButton,
} from 'src/shared/ui/primitives';
import { useWallet } from 'src/contexts/WalletContext';
import { useSiteConnections } from 'src/hooks/dapp/useSiteConnections';
import { networksFor, type ManagedEvmNetwork } from 'src/services/evm/registry';
import { evmMetaOf } from 'src/services/evm/walletEvm';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { Row, SiteMark, WalletRow, WalletValue } from 'src/features/dapp/components/ReviewParts';
import {
  evmChoices,
  hostOf,
  siteChainFor,
  siteDisplayWallets,
} from 'src/features/dapp/siteWallets';
import { evmSiteMessage, revokeOctraSite } from 'src/features/dapp/siteActions';
import { logger } from 'src/utils/logger';
import type { Wallet } from 'src/types/wallet';
import DesktopSitePage from '../components/DesktopSitePage';

const ConnectedSiteScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { origin, kind, network } = (location.state ?? {}) as {
    origin?: string;
    kind?: 'evm' | 'octra' | 'desktop';
    network?: string;
  };
  const { wallets, activeWallet, networkId, showMessage } = useWallet();
  const sites = useSiteConnections();
  const [networks, setNetworks] = useState<ManagedEvmNetwork[]>([]);
  const [netOpen, setNetOpen] = useState(false);
  const [netBusy, setNetBusy] = useState<number | null>(null);
  const [removing, setRemoving] = useState<Wallet | null>(null);
  const [ending, setEnding] = useState(false);
  const [busy, setBusy] = useState(false);
  const side = networkId === 'devnet' ? 'testnet' : 'mainnet';

  useMountEffect(() => {
    let live = true;
    networksFor(networkId)
      .then((list) => live && setNetworks(list))
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  const back = () => navigate('/settings/connected-dapps', { replace: true });

  if (!origin) return null;
  if (kind === 'desktop') {
    const site = sites.desktop.find((d) => d.origin === origin && d.network === network) ?? null;
    return <DesktopSitePage site={site} onDone={back} />;
  }
  const evm = kind === 'evm' ? sites.evm[origin] : undefined;
  const octra = kind === 'octra' ? sites.octra.find((s) => s.origin === origin) : undefined;
  const list = evm ? siteDisplayWallets(evm, activeWallet?.id ?? null, wallets) : [];
  const octraWallet = octra?.address
    ? (wallets.find((w) => w.address === octra.address) ?? null)
    : null;
  const shown = evm ? list : octraWallet ? [octraWallet] : [];
  const others = evm ? evmChoices(wallets).filter((c) => !evm.accounts[c.wallet.id]) : [];
  const chainId = siteChainFor(evm, side);
  const net = networks.find((n) => n.chainId === chainId);
  const gone = sites.loaded && !evm && !octra;
  const addressOf = (w: Wallet) =>
    evm ? (evm.accounts[w.id]?.address ?? evmMetaOf(w)?.address ?? w.address) : w.address;

  const remove = async () => {
    if (!removing || busy) return;
    setBusy(true);
    const ok = await evmSiteMessage('EVM_SITE_DISCONNECT', origin, removing.id);
    setBusy(false);
    setRemoving(null);
    if (!ok) showMessage(t('toast.revokeFailed'), 'error');
  };

  const disconnect = async () => {
    if (busy) return;
    setBusy(true);
    try {
      if (evm) {
        if (!(await evmSiteMessage('EVM_SITE_DISCONNECT', origin))) throw new Error('kept');
      } else if (octra) {
        await revokeOctraSite(origin, octra.key);
      }
      setEnding(false);
      back();
    } catch (e) {
      logger.error('Disconnecting a site failed:', e);
      showMessage(t('toast.revokeFailed'), 'error');
    } finally {
      setBusy(false);
    }
  };

  const pickChain = async (id: number) => {
    if (!evm || netBusy !== null || !list[0]) return;
    if (id === chainId) {
      setNetOpen(false);
      return;
    }
    setNetBusy(id);
    try {
      const res = await chrome.runtime.sendMessage({
        type: 'EVM_SITE_SET_CHAIN',
        origin,
        chainId: id,
        walletId: list[0].id,
        side,
      });
      if (!res?.success) throw new Error('chain not changed');
      setNetOpen(false);
    } catch (e) {
      logger.error('Site chain pick failed:', e);
      showMessage(
        t('footer.chainFailed', { defaultValue: 'Could not switch network. Try again.' }),
        'error'
      );
    } finally {
      setNetBusy(null);
    }
  };

  return (
    <div className="h-full! overflow-hidden! flex! flex-col! bg-(--bg)! text-(--fg)!">
      <Header title={hostOf(origin)} showBack showSettings={false} onBack={back} />

      <div
        className="flex-1! overflow-y-auto! scrollbar-hide! flex! flex-col!"
        style={{ padding: '4px var(--gutter) 16px' }}
      >
        {gone ? null : (
          <>
            <SectionLabel first>
              {t('connectedSite.wallets', { defaultValue: 'Wallets' })}
            </SectionLabel>
            <RuledList>
              {shown.map((w, i) => (
                <WalletRow
                  key={w.id}
                  wallet={w}
                  address={addressOf(w)}
                  evm={!!evm}
                  selected={i === 0}
                  right={
                    evm && shown.length > 1 ? (
                      <TextButton muted onClick={() => setRemoving(w)}>
                        {t('connectedSite.remove', { defaultValue: 'Remove' })}
                      </TextButton>
                    ) : undefined
                  }
                />
              ))}
              {evm && others.length > 0 && (
                <ListRow
                  leading={
                    <span
                      className="grid! place-items-center!"
                      style={{ width: '30px', height: '30px' }}
                    >
                      <Plus size={14} style={{ color: 'var(--fg-2)' }} />
                    </span>
                  }
                  label={t('footer.connectAnother', { defaultValue: 'Connect another wallet' })}
                  onClick={() => navigate('/site/connect', { state: { origin } })}
                />
              )}
            </RuledList>

            <SectionLabel>{t('evmDapp.network', { defaultValue: 'Network' })}</SectionLabel>
            <RuledList>
              {evm ? (
                <ListRow
                  leading={net ? <NetworkLogo network={net} size={22} /> : undefined}
                  label={
                    net?.name ??
                    t('networks.chainLabel', { id: chainId, defaultValue: 'Chain {{id}}' })
                  }
                  onClick={() => setNetOpen(true)}
                />
              ) : (
                <ListRow leading={<OctraGlyph size={18} />} label="Octra" chevron={false} />
              )}
            </RuledList>
          </>
        )}
      </div>

      {!gone && (
        <div className="shrink-0!" style={{ padding: '8px var(--gutter) 20px' }}>
          <PrimaryButton secondary onClick={() => setEnding(true)} style={{ color: 'var(--neg)' }}>
            {t('evmDapp.disconnect', { defaultValue: 'Disconnect' })}
          </PrimaryButton>
        </div>
      )}

      <Sheet
        open={!!removing}
        onClose={() => setRemoving(null)}
        dismissible={!busy}
        title={t('connectedSite.removeTitle', { defaultValue: 'Remove from this site' })}
        footer={
          <div className="flex!" style={{ gap: '10px' }}>
            <PrimaryButton secondary onClick={() => setRemoving(null)} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </PrimaryButton>
            <PrimaryButton danger onClick={() => void remove()} loading={busy}>
              {t('connectedSite.remove', { defaultValue: 'Remove' })}
            </PrimaryButton>
          </div>
        }
      >
        {removing && (
          <RuledList>
            <Row label={t('evmDapp.wallet', { defaultValue: 'Wallet' })}>
              <WalletValue
                name={removing.name}
                avatar={removing.address}
                address={addressOf(removing)}
              />
            </Row>
          </RuledList>
        )}
      </Sheet>

      <Sheet
        open={ending}
        onClose={() => setEnding(false)}
        dismissible={!busy}
        title={t('connectedSite.endTitle', { defaultValue: 'Disconnect this site' })}
        footer={
          <div className="flex!" style={{ gap: '10px' }}>
            <PrimaryButton secondary onClick={() => setEnding(false)} disabled={busy}>
              {t('common.cancel', { defaultValue: 'Cancel' })}
            </PrimaryButton>
            <PrimaryButton danger onClick={() => void disconnect()} loading={busy}>
              {t('evmDapp.disconnect', { defaultValue: 'Disconnect' })}
            </PrimaryButton>
          </div>
        }
      >
        <div className="flex! items-center!" style={{ gap: '10px', padding: '4px' }}>
          <SiteMark origin={origin} size={28} />
          <span className="truncate! flex-1!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
            {hostOf(origin)}
          </span>
          <span className="flex! items-center! shrink-0!">
            {shown.slice(0, 2).map((w, i) => (
              <span
                key={w.id}
                style={{
                  marginLeft: i ? '-5px' : 0,
                  borderRadius: '6px',
                  boxShadow: '0 0 0 2px var(--bg-1)',
                }}
              >
                <WalletAvatar address={w.address} size={18} />
              </span>
            ))}
            {shown.length > 2 && (
              <span style={{ fontSize: '11px', color: 'var(--fg-3)', marginLeft: '5px' }}>
                +{shown.length - 2}
              </span>
            )}
          </span>
        </div>
        <p
          style={{ margin: '12px 4px 0', fontSize: '12px', lineHeight: 1.5, color: 'var(--fg-2)' }}
        >
          {shown.length > 1
            ? t('connectedSite.endNoteMany', {
                n: shown.length,
                defaultValue:
                  'All {{n}} wallets are removed from this site. Pending transactions and token approvals stay on chain.',
              })
            : t('connectedSite.endNoteOne', {
                defaultValue:
                  'The wallet is removed from this site. Pending transactions and token approvals stay on chain.',
              })}
        </p>
      </Sheet>

      <Sheet
        open={netOpen}
        onClose={() => setNetOpen(false)}
        title={t('evmDapp.network', { defaultValue: 'Network' })}
      >
        <RuledList>
          {networks.map((n) => (
            <button
              key={n.chainId}
              type="button"
              aria-pressed={n.chainId === chainId}
              disabled={netBusy !== null}
              onClick={() => void pickChain(n.chainId)}
              className={`w-full! flex! items-center! rounded-[14px]! transition-colors! duration-200! ${
                n.chainId === chainId ? 'bg-(--bg-2)!' : 'hover:bg-(--bg-2)!'
              }`}
              style={{
                minHeight: '44px',
                padding: '0 12px',
                gap: '10px',
                border: 'none',
                background: n.chainId === chainId ? undefined : 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <NetworkLogo network={n} size={22} />
              <span className="truncate!" style={{ fontSize: '13px', color: 'var(--fg)' }}>
                {n.name}
              </span>
            </button>
          ))}
        </RuledList>
      </Sheet>
    </div>
  );
};

export default ConnectedSiteScreen;
