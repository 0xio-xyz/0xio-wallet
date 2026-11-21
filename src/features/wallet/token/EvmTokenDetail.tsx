import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ArrowDown, ArrowUp } from 'src/shared/ui/icons';
import { EvmTxRow } from 'src/shared/ui/TxRow';
import EvmTxDetailSheet from 'src/shared/ui/EvmTxDetailSheet';
import type { EvmHistoryItem } from 'src/services/evm/history';
import type { EvmToken } from 'src/services/evm/tokens';
import { useEvmChart } from 'src/hooks/wallet/useEvmPrices';
import { useEvmHistory } from 'src/hooks/wallet/useEvmHistory';
import { useOctChart } from 'src/hooks/wallet/useOctChart';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { chartsAsOct, llamaKey, type ChartRange } from 'src/services/evm/prices';
import { EvmTokenIcon, type EvmHolding } from 'src/features/wallet/components/TokenList';
import TokenDetailSheet from './TokenDetailSheet';
import { fmtUsd } from './tokenDetailUtils';

const trim = (amount: string) => {
  const [int, frac = ''] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  return cut ? `${grouped}.${cut}` : grouped;
};

const EvmTokenDetail = ({
  row,
  evmAddress,
  onClose,
}: {
  row: EvmHolding | null;
  evmAddress: string | null;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [range, setRange] = useState<ChartRange>('1D');
  const [openTx, setOpenTx] = useState<EvmHistoryItem | null>(null);
  const asOct = !!row && chartsAsOct(row.chainId, row.token);
  const key = row && !asOct ? llamaKey(row.chainId, row.token) : null;
  const { priceHistory } = useTokenPrice();
  const llamaChart = useEvmChart(key, range);
  const octChart = useOctChart(range, asOct, priceHistory);
  const { points, loading } = asOct ? octChart : llamaChart;
  const history = useEvmHistory(evmAddress, !!row);

  if (!row) return null;

  const last = points.length ? points[points.length - 1].price : null;
  const contract = row.token.address?.toLowerCase() ?? null;
  const isThis = (token: EvmToken | null) =>
    contract === null
      ? token === null || token.address === null
      : token?.address?.toLowerCase() === contract;
  const activity = history.items
    .filter(
      (i) =>
        i.chainId === row.chainId &&
        (i.moved?.length ? i.moved.some((m) => isThis(m.token)) : isThis(i.token))
    )
    .slice(0, 6);
  const rowKey = `${row.chainId}:${contract ?? 'native'}`;

  return (
    <>
      <TokenDetailSheet
        onClose={onClose}
        icon={<EvmTokenIcon row={row} size={36} />}
        title={row.token.name}
        subtitle={`${row.token.symbol} ${t('evmDetail.on', { defaultValue: 'on' })} ${row.chainName}`}
        market={{
          points,
          loading,
          range,
          onRange: setRange,
          placeholder: row.testnet ? t('evmDetail.testnet', { defaultValue: 'Testnet' }) : '',
        }}
        balance={{
          amount: trim(row.amount),
          symbol: row.token.symbol,
          value:
            row.usd !== null
              ? fmtUsd(row.usd)
              : last !== null
                ? fmtUsd(last * (parseFloat(row.amount) || 0))
                : '--',
        }}
        actions={[
          {
            id: 'send',
            label: t('action.send'),
            icon: ArrowUp,
            primary: true,
            onClick: () => navigate('/send/evm', { state: { token: rowKey } }),
          },
          {
            id: 'receive',
            label: t('action.receive'),
            icon: ArrowDown,
            onClick: () => navigate('/receive', { state: { tab: 'evm' } }),
          },
        ]}
        activity={activity.map((item) => (
          <EvmTxRow key={item.key} item={item} onClick={setOpenTx} />
        ))}
        activityEmpty={
          history.loading
            ? ''
            : t('evmDetail.noActivity', { defaultValue: 'No activity for this token yet.' })
        }
      />
      {openTx && <EvmTxDetailSheet item={openTx} onClose={() => setOpenTx(null)} />}
    </>
  );
};

export default EvmTokenDetail;
