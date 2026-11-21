import { useState } from 'react';
import { useLocation, useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useSiteConnections } from 'src/hooks/dapp/useSiteConnections';
import { siteNetwork } from 'src/background/services/evmSites';
import ReviewFrame from '../components/ReviewFrame';
import EvmConnectBody from '../components/EvmConnectBody';
import AddWalletForSite from '../components/AddWalletForSite';
import { connectHeading, evmChoices, siteChoices, type ConnectMode } from '../siteWallets';
import { evmSiteMessage } from '../siteActions';

const SiteConnectScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { origin, walletId } = (location.state ?? {}) as { origin?: string; walletId?: string };
  const { wallets, activeWallet } = useWallet();
  const sites = useSiteConnections();
  const [chainName, setChainName] = useState('');
  const [pick, setPick] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  useMountEffect(() => {
    if (!origin) return;
    let live = true;
    siteNetwork(origin)
      .then((n) => live && setChainName(n.name))
      .catch(() => {});
    return () => {
      live = false;
    };
  });

  const back = () => (window.history.length > 1 ? navigate(-1) : navigate('/'));
  if (!origin) return null;

  const site = sites.evm[origin];
  const connected = siteChoices(site, activeWallet?.id ?? null, wallets);
  const free = evmChoices(wallets).filter((c) => !site?.accounts[c.wallet.id]);
  const named = free.find((c) => c.wallet.id === walletId);
  const openFree = free.find((c) => c.wallet.id === activeWallet?.id);
  const openHasEvm = evmChoices(wallets).some((c) => c.wallet.id === activeWallet?.id);
  const fixed = named ?? (walletId ? undefined : openFree);
  const mode: ConnectMode = fixed
    ? { kind: 'fixed', choice: fixed }
    : free.length
      ? { kind: 'pick' }
      : { kind: 'empty' };
  const picked = mode.kind === 'pick' && free.some((c) => c.wallet.id === pick) ? pick : null;
  const target = mode.kind === 'fixed' ? mode.choice.wallet.id : picked;

  const connect = async () => {
    if (mode.kind === 'empty') {
      setAdding(true);
      return;
    }
    if (!target || busy) return;
    setBusy(true);
    setError('');
    if (await evmSiteMessage('EVM_SITE_CONNECT', origin, target)) {
      back();
      return;
    }
    setBusy(false);
    setError(t('evmDapp.connectFailed', { defaultValue: 'Could not connect. Try again.' }));
  };

  return (
    <>
      <ReviewFrame
        caps={t('evmDapp.connectCaps', { defaultValue: 'Connection request' })}
        origin={origin}
        heading={connectHeading(mode, t)}
        error={error}
        cancel={
          mode.kind === 'empty'
            ? t('common.close', { defaultValue: 'Close' })
            : t('evmDapp.cancel', { defaultValue: 'Reject' })
        }
        action={
          mode.kind === 'empty'
            ? t('evmDapp.addTitle', { defaultValue: 'Add a wallet' })
            : t('evmDapp.connect', { defaultValue: 'Connect' })
        }
        onCancel={back}
        onAction={() => void connect()}
        disabled={mode.kind === 'pick' && !picked}
        busy={busy}
      >
        <EvmConnectBody
          origin={origin}
          chainName={chainName}
          mode={mode}
          open={openHasEvm ? null : (activeWallet ?? null)}
          choices={free}
          pick={picked}
          onPick={setPick}
          connected={mode.kind === 'fixed' ? connected : []}
          wallets={wallets}
        />
      </ReviewFrame>
      <AddWalletForSite
        open={adding}
        onClose={() => setAdding(false)}
        onAdded={(id) => setPick(id)}
      />
    </>
  );
};

export default SiteConnectScreen;
