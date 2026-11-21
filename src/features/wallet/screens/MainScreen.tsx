import { useEffect, useState } from 'react'; // effect:audited - see below
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import BalanceCard from 'src/features/wallet/components/BalanceCard';
import ActionGrid from 'src/features/wallet/components/ActionGrid';
import TokenList from 'src/features/wallet/components/TokenList';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { useEvmBalances } from 'src/hooks/wallet/useEvmBalances';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import {
  evmRowUsd,
  isTrustedStable,
  useEvmPriceState,
  useEvmValueSeries,
} from 'src/hooks/wallet/useEvmPrices';
import { useOctraTokens } from 'src/hooks/wallet/useOctraTokens';
import { useEvmDetected } from 'src/hooks/wallet/useTokenPrefs';
import {
  octraNative,
  pricedHoldings,
  sortEvmHoldings,
  type EvmHolding,
} from 'src/features/wallet/home/pricedHoldings';
import { networkCapabilities } from 'src/utils/network';
import { llamaKey } from 'src/services/evm/prices';
import EvmTokenDetail from 'src/features/wallet/token/EvmTokenDetail';
import OctraTokenDetail, { type TokenSelection } from 'src/features/wallet/token/OctraTokenDetail';
import LoadingSpinner from 'src/shared/ui/LoadingSpinner';
import KeyBlockedTag from 'src/shared/ui/KeyBlockedTag';
import HomeTag from 'src/shared/ui/HomeTag';
import { useNavigate } from 'src/lib/router';
import useRebackupNeeded from 'src/hooks/wallet/useRebackupNeeded';
import useBackupPending from 'src/hooks/wallet/useBackupPending';
import { usePvacBlocked } from 'src/hooks/privacy/usePvacBlocked';
import { useSetupPrivate } from 'src/hooks/privacy/useSetupPrivate';
import { usePrivateStatus } from 'src/hooks/privacy/usePrivateStatus';
import { homeTagOrder } from 'src/features/wallet/home/homeTags';
import PrivateHoldSheet from 'src/features/wallet/home/PrivateHoldSheet';
import MoveFundsSheet from 'src/features/wallet/home/MoveFundsSheet';
import SetupPrivateSheet from 'src/features/wallet/home/SetupPrivateSheet';

const MainScreen = () => {
  const [selectedToken, setSelectedToken] = useState<TokenSelection | null>(null);
  const [selectedEvm, setSelectedEvm] = useState<string | null>(null);
  const { t } = useTranslation();
  const {
    activeWallet,
    refreshBalance,
    isLoading,
    networkId,
    balance,
    totalBalance,
    privateUnavailable,
  } = useWallet();
  const navigate = useNavigate();
  const rebackup = useRebackupNeeded(activeWallet);
  const backupPending = useBackupPending(activeWallet);
  const keyBlocked = usePvacBlocked();
  const setupPrivate = useSetupPrivate();
  const privateStatus = usePrivateStatus();
  const { view, evmOn, evmAddress } = useHomeView();
  const tokenPrices = useTokenPrice();
  const evm = useEvmBalances(evmAddress, networkId, evmOn && view !== 'oct');
  useEvmDetected(
    evmAddress,
    evm.networks.map((n) => n.chainId),
    evmOn && view !== 'oct',
    'stale'
  );
  const ethPrice = tokenPrices.getPrice('ETH') || 0;
  const { prices: llama, settled: llamaSettled } = useEvmPriceState(
    evm.rows.map((r) => llamaKey(r.chainId, r.token)).filter((k): k is string => !!k)
  );
  const evmRows: EvmHolding[] = sortEvmHoldings(
    evm.rows.map((r) => {
      const amount = parseFloat(r.amount) || 0;
      const key = llamaKey(r.chainId, r.token);
      const usd = evmRowUsd(r, amount, key ? llama[key] : undefined, ethPrice);
      return {
        ...r,
        usd,
        priceLoading: usd === null && !!key && !r.testnet && !llamaSettled,
      };
    })
  );
  const octra = useOctraTokens(activeWallet?.address, networkId, view !== 'evm');
  const native = octraNative(
    balance,
    totalBalance,
    !!activeWallet?.privateKey && networkCapabilities(networkId).privacy,
    privateUnavailable || privateStatus?.kind === 'empty' || privateStatus?.kind === 'held'
  );
  const evmShown = evmOn && view !== 'oct';
  const priced = pricedHoldings({
    view,
    networkId,
    octPrice: tokenPrices.getPrice('OCT'),
    octTotal: native.value,
    octMissing: native.missing,
    octra,
    evm: { on: evmShown, rows: evmRows, loading: evm.loading, failedChains: evm.failedChains },
  });
  const evmSeries = useEvmValueSeries(
    evmRows
      .filter((r) => !r.testnet)
      .map((r) => ({
        key: llamaKey(r.chainId, r.token),
        amount: parseFloat(r.amount) || 0,
        stable: isTrustedStable(r),
      }))
  );
  const evmRowKey = (r: EvmHolding) => `${r.chainId}:${r.token.address?.toLowerCase() ?? 'native'}`;
  const shownEvm = evmRows.find((r) => evmRowKey(r) === selectedEvm) ?? null;
  const tags = homeTagOrder({
    padded: !!activeWallet?.metadata?.isPadded,
    backup: backupPending || rebackup,
    keyBlocked: keyBlocked && view !== 'evm',
    privateHold: privateStatus?.kind === 'held' && view !== 'evm',
    setupPrivate: !!setupPrivate.feeRaw && view !== 'evm',
  });
  const scopeKey = `${networkId ?? ''}:${activeWallet?.address ?? ''}`;

  // A sheet belongs to the wallet and network it opened for; a switch closes it. The setup
  // sheet keeps the fee it opened with: the figure shown is the figure paid.
  const [sheet, setSheet] = useState<{
    id: 'moveFunds' | 'setupPrivate' | 'privateHold';
    scope: string;
    feeRaw?: string;
  } | null>(null);
  const closeSheet = () => setSheet(null);
  const shownSheet = sheet?.scope === scopeKey ? sheet : null;

  // effect:audited - triggers balance refresh when active wallet switches; cross-component sync
  useEffect(() => {
    if (activeWallet?.address) {
      refreshBalance(activeWallet.address, activeWallet);
    }
  }, [activeWallet?.address]);

  if (isLoading && !activeWallet) {
    return <LoadingSpinner fullScreen text={t('main.loadingWallet')} />;
  }

  return (
    <div className="screen-container flex! flex-col! bg-(--bg-main) h-full px-(--gutter)! pt-0! pb-0!">
      <div className="shrink-0">
        <div className="relative!">
          <BalanceCard evmSeries={evmSeries} view={view} priced={priced} />
          {tags.length > 0 && (
            <div className="home-tags">
              {tags.map((id) => {
                switch (id) {
                  case 'moveFunds':
                    return (
                      <HomeTag
                        key={id}
                        tone="red"
                        onClick={() => setSheet({ id: 'moveFunds', scope: scopeKey })}
                      >
                        {t('main.moveFunds', { defaultValue: 'Move funds' })}
                      </HomeTag>
                    );
                  case 'backUp':
                    return (
                      <HomeTag
                        key={id}
                        tone="amber"
                        onClick={() =>
                          backupPending
                            ? navigate('/backup')
                            : navigate('/settings/backup', { state: { rebackup: true } })
                        }
                      >
                        {t('main.backUp', { defaultValue: 'Back up' })}
                      </HomeTag>
                    );
                  case 'keyBlocked':
                    return <KeyBlockedTag key={`${id}:${scopeKey}`} />;
                  case 'privateHold':
                    return (
                      <HomeTag
                        key={id}
                        tone="blue"
                        onClick={() => setSheet({ id: 'privateHold', scope: scopeKey })}
                      >
                        {t('main.privateHold', { defaultValue: 'Private on hold' })}
                      </HomeTag>
                    );
                  case 'setupPrivate':
                    return (
                      <HomeTag
                        key={id}
                        tone="blue"
                        dot
                        onClick={() =>
                          setSheet({
                            id: 'setupPrivate',
                            scope: scopeKey,
                            feeRaw: setupPrivate.feeRaw ?? undefined,
                          })
                        }
                      >
                        {t('main.setupPrivate', { defaultValue: 'Set up private' })}
                      </HomeTag>
                    );
                }
              })}
            </div>
          )}
        </div>
        <div style={{ marginTop: '8px' }}>
          <ActionGrid view={view} evmOn={evmOn} />
        </div>
      </div>

      <div className="flex-1 flex flex-col min-h-0">
        <TokenList
          onSelectToken={setSelectedToken}
          view={view}
          octra={octra}
          priced={priced}
          evm={{
            rows: evmRows,
            onSelect: (row) => setSelectedEvm(evmRowKey(row)),
            networks: evm.networks,
            failedChains: evm.failedChains,
            refresh: evm.refresh,
          }}
        />
      </div>

      {selectedToken && (
        <OctraTokenDetail selection={selectedToken} onClose={() => setSelectedToken(null)} />
      )}
      <EvmTokenDetail row={shownEvm} evmAddress={evmAddress} onClose={() => setSelectedEvm(null)} />

      <MoveFundsSheet open={shownSheet?.id === 'moveFunds'} onClose={closeSheet} />
      <PrivateHoldSheet
        open={shownSheet?.id === 'privateHold'}
        reason={privateStatus?.reason ?? null}
        onClose={closeSheet}
      />
      {activeWallet && shownSheet?.id === 'setupPrivate' && shownSheet.feeRaw && (
        <SetupPrivateSheet
          open
          wallet={activeWallet}
          networkId={networkId}
          feeRaw={shownSheet.feeRaw}
          onClose={closeSheet}
          onDone={() => {
            closeSheet();
            setupPrivate.recheck();
          }}
        />
      )}
    </div>
  );
};

export default MainScreen;
