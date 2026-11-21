import { useRef, useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { walletStorage } from 'src/services/wallet/WalletStorage';
import { middleCut } from 'src/features/wallet/add/format';
import { useManagedEvmNetworks } from 'src/hooks/wallet/useManagedNetworks';
import { canUseEvm, isEvmOn } from 'src/services/evm/walletEvm';
import Header from 'src/shared/ui/Header';
import ActiveWalletCard from 'src/features/settings/components/ActiveWalletCard';
import { RuledList, ListRow, ToggleRow } from 'src/shared/ui/primitives';
import { logger } from 'src/utils/logger';

const EvmSettingsScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { activeWallet, wallets, refreshWallets, showMessage, networkId } = useWallet();
  const { networks } = useManagedEvmNetworks(networkId);
  const [busy, setBusy] = useState(false);
  const working = useRef(false);

  const evm = activeWallet?.metadata?.evm;
  const evmPossible = canUseEvm(activeWallet, wallets);
  const on = isEvmOn(activeWallet, wallets);

  const toggle = async () => {
    if (!activeWallet || !evmPossible || working.current) return;
    working.current = true;
    setBusy(true);
    try {
      await walletStorage.setEvmEnabled(activeWallet.id, !on);
      await refreshWallets();
    } catch (e) {
      logger.error('EVM switch failed:', e);
      showMessage(
        e instanceof Error && e.message === 'EVM needs a recovery phrase'
          ? t('settings.evmNoSource', {
              defaultValue:
                'The phrase wallet this account came from is not here. Import that phrase to use EVM.',
            })
          : t('settings.evmSwitchFailed', {
              defaultValue: 'Could not update the EVM setting. Try again.',
            }),
        'error'
      );
    } finally {
      working.current = false;
      setBusy(false);
    }
  };

  const sub = !evmPossible ? (
    t('settings.evmNeedsPhrase', { defaultValue: 'Needs a recovery phrase' })
  ) : on && evm ? (
    <span style={{ fontFamily: 'var(--font-mono)' }}>{middleCut(evm.address, 8, 6)}</span>
  ) : (
    t('settings.evmOff', { defaultValue: 'Off' })
  );

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <Header title="EVM" showBack showSettings={false} />
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '14px var(--gutter) 24px' }}
      >
        {activeWallet && (
          <ActiveWalletCard
            name={activeWallet.name}
            address={activeWallet.address}
            onClick={() => navigate('/walletlist')}
            style={{ marginBottom: '14px' }}
          />
        )}
        <RuledList>
          <ToggleRow
            label={t('settings.evmAddress', { defaultValue: 'EVM address' })}
            sub={sub}
            checked={on}
            onChange={() => void toggle()}
            disabled={!evmPossible || busy}
          />
        </RuledList>

        {on && (
          <>
            <RuledList style={{ marginTop: '14px' }}>
              <ListRow
                label={t('networks.title', { defaultValue: 'Networks' })}
                hint={
                  networks
                    ? t('networks.onShort', {
                        count: networks.filter((n) => n.enabled).length,
                        defaultValue: '{{count}} on',
                      })
                    : undefined
                }
                onClick={() => navigate('/settings/networks')}
              />
            </RuledList>
          </>
        )}
      </div>
    </div>
  );
};

export default EvmSettingsScreen;
