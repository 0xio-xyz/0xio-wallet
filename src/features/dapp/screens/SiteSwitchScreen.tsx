import { useState } from 'react';
import { useLocation, useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { RuledList } from 'src/shared/ui/primitives';
import { useWallet } from 'src/contexts/WalletContext';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useSiteConnections } from 'src/hooks/dapp/useSiteConnections';
import { siteNetwork } from 'src/background/services/evmSites';
import ReviewFrame from '../components/ReviewFrame';
import { Note, Row, WalletValue } from '../components/ReviewParts';
import { siteChoices } from '../siteWallets';
import { evmSiteMessage } from '../siteActions';

const SiteSwitchScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { origin, walletId } = (location.state ?? {}) as { origin?: string; walletId?: string };
  const { wallets, activeWallet } = useWallet();
  const sites = useSiteConnections();
  const [chainName, setChainName] = useState('');
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
  if (!origin || !sites.loaded) return null;

  const list = siteChoices(sites.evm[origin], activeWallet?.id ?? null, wallets);
  const from = list[0];
  const to = list.find((c) => c.wallet.id === walletId);

  const change = async () => {
    if (!to || busy) return;
    setBusy(true);
    setError('');
    if (await evmSiteMessage('EVM_SITE_USE', origin, to.wallet.id)) {
      back();
      return;
    }
    setBusy(false);
    setError(t('evmDapp.switchFailed', { defaultValue: 'Could not switch. Try again.' }));
  };

  return (
    <ReviewFrame
      caps={t('evmDapp.walletChangeCaps', { defaultValue: 'Wallet change' })}
      origin={origin}
      heading={t('evmDapp.walletChangeTitle', { defaultValue: "Switch this site's wallet" })}
      error={error}
      cancel={t('common.cancel', { defaultValue: 'Cancel' })}
      action={t('evmDapp.switch', { defaultValue: 'Switch' })}
      onCancel={back}
      onAction={() => void change()}
      disabled={!to || !from || to.wallet.id === from.wallet.id}
      busy={busy}
    >
      <RuledList>
        {from && (
          <Row label={t('evmDapp.from', { defaultValue: 'From' })}>
            <WalletValue
              name={from.wallet.name}
              avatar={from.wallet.address}
              address={from.address}
            />
          </Row>
        )}
        {to && (
          <Row label={t('evmDapp.to', { defaultValue: 'To' })}>
            <WalletValue name={to.wallet.name} avatar={to.wallet.address} address={to.address} />
          </Row>
        )}
        <Row label={t('evmDapp.network', { defaultValue: 'Network' })}>{chainName}</Row>
      </RuledList>
      <div style={{ marginTop: '12px' }}>
        <Note>
          {t('evmDapp.walletChangeNote', {
            defaultValue:
              'Both stay connected. The site uses the new one first until you open another connected wallet.',
          })}
        </Note>
      </div>
    </ReviewFrame>
  );
};

export default SiteSwitchScreen;
