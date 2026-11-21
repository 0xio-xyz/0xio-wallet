import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import AddNetworkSheet from 'src/features/settings/components/AddNetworkSheet';
import { inputProps } from 'src/features/settings/components/networkForm';
import { Caps } from 'src/features/settings/components/networkParts';
import { NetworkLogo } from 'src/features/wallet/components/EvmNetworkPicker';
import { useManagedEvmNetworks, useSettledOrder } from 'src/hooks/wallet/useManagedNetworks';
import type { ManagedEvmNetwork } from 'src/services/evm/registry';
import Header from 'src/shared/ui/Header';
import { ListRow, RuledList, Toggle, quietField } from 'src/shared/ui/primitives';
import { getNetworkConfig } from 'src/utils/network';

const OCTRA_LOGO = '/chains/octra/logo.webp';

const EvmRow = ({
  network,
  on,
  onOpen,
  onToggle,
}: {
  network: ManagedEvmNetwork;
  on: boolean;
  onOpen: () => void;
  onToggle: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <div
      className="flex! items-center! rounded-[14px]! transition-colors! duration-200! hover:bg-(--bg-2)!"
      style={{ gap: '12px', paddingRight: '12px' }}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex! min-w-0! flex-1! items-center!"
        style={{
          gap: '10px',
          padding: '9px 0 9px 12px',
          minHeight: '50px',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          textAlign: 'left',
        }}
      >
        <span style={{ opacity: on ? 1 : 0.55, transition: 'opacity 200ms ease-out' }}>
          <NetworkLogo network={network} size={26} />
        </span>
        <span className="flex! min-w-0! flex-col!" style={{ gap: '2px' }}>
          <span
            className="truncate!"
            style={{
              fontSize: '13px',
              color: on ? 'var(--fg)' : 'var(--fg-2)',
              transition: 'color 200ms ease-out',
            }}
          >
            {network.name}
          </span>
          <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {t('networks.chainLabel', { id: network.chainId, defaultValue: 'Chain {{id}}' })}
          </span>
        </span>
      </button>
      <Toggle checked={on} onChange={onToggle} label={network.name} />
    </div>
  );
};

const NetworksScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { networkId, showMessage } = useWallet();
  const { networks, setEnabled } = useManagedEvmNetworks(networkId);
  const ordered = useSettledOrder(networks);
  const [query, setQuery] = useState('');
  const [adding, setAdding] = useState(false);

  const side = networkId === 'devnet' ? 'devnet' : 'mainnet';
  const list = ordered ?? [];
  const onCount = list.filter((n) => n.enabled).length;
  const q = query.trim().toLowerCase();
  const shown = list.filter(
    (n) => !q || n.name.toLowerCase().includes(q) || String(n.chainId).includes(q)
  );
  const octraShown = !q || 'octra'.includes(q) || q.includes('octra');

  const octraSub =
    networkId === 'mainnet' || networkId === 'devnet'
      ? t('networks.octraDefaultRpc', {
          name:
            networkId === 'devnet'
              ? t('networks.devnet', { defaultValue: 'Devnet' })
              : t('networks.mainnet', { defaultValue: 'Mainnet' }),
          defaultValue: '{{name}} RPC (default)',
        })
      : getNetworkConfig(networkId).name;

  const toggle = async (n: ManagedEvmNetwork) => {
    const ok = await setEnabled(n.chainId, !n.enabled);
    if (!ok) {
      showMessage(
        t('networks.saveFailed', { defaultValue: 'Could not save. Try again.' }),
        'error'
      );
    }
  };

  return (
    <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
      <Header
        title={t('networks.title', { defaultValue: 'Networks' })}
        showBack
        showSettings={false}
      />
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '6px var(--gutter) 24px' }}
      >
        <input
          {...inputProps}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder={t('networks.search', {
            count: list.length + 1,
            defaultValue: 'Search {{count}} networks',
          })}
          aria-label={t('networks.searchLabel', { defaultValue: 'Search networks' })}
          className={quietField}
        />

        {octraShown && (
          <>
            <Caps>Octra</Caps>
            <RuledList>
              <ListRow
                leading={
                  <img
                    src={OCTRA_LOGO}
                    alt=""
                    width={26}
                    height={26}
                    className="rounded-full! shrink-0!"
                  />
                }
                label="Octra"
                sub={octraSub}
                onClick={() => navigate('/settings/network')}
              />
            </RuledList>
          </>
        )}

        {(shown.length > 0 || !q) && (
          <>
            <Caps
              right={
                ordered ? (
                  <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                    {t('networks.onCount', {
                      on: onCount,
                      total: list.length,
                      defaultValue: '{{on}} of {{total}} on',
                    })}
                  </span>
                ) : undefined
              }
            >
              EVM
            </Caps>
            {ordered && (
              <RuledList>
                {shown.map((n) => (
                  <EvmRow
                    key={n.chainId}
                    network={n}
                    on={n.enabled}
                    onOpen={() => navigate(`/settings/networks/${n.chainId}`)}
                    onToggle={() => void toggle(n)}
                  />
                ))}
              </RuledList>
            )}
          </>
        )}

        {q && !octraShown && shown.length === 0 && (
          <p
            style={{
              margin: 0,
              padding: '18px 4px 0',
              fontSize: '12px',
              color: 'var(--fg-3)',
            }}
          >
            {t('networks.noMatch', { defaultValue: 'No matching networks' })}
          </p>
        )}

        <button
          type="button"
          onClick={() => setAdding(true)}
          className="press flex! w-full! items-center! justify-center! rounded-[22px]! transition-colors! duration-200! hover:bg-(--bg-1)!"
          style={{
            marginTop: '14px',
            height: '44px',
            border: 'none',
            background: 'transparent',
            color: 'var(--fg-2)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: 'pointer',
          }}
        >
          {t('networks.addNetwork', { defaultValue: '+ Add network' })}
        </button>
      </div>

      <AddNetworkSheet open={adding} onClose={() => setAdding(false)} side={side} known={list} />
    </div>
  );
};

export default NetworksScreen;
