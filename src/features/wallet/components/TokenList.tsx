import { usePrivateStatus } from 'src/hooks/privacy/usePrivateStatus';
import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import type { TokenSelection } from 'src/features/wallet/token/OctraTokenDetail';
import { useTranslation } from 'src/i18n/react';
import { formatUsd, useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { RefreshCw, Plus } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import ImportTokenSheet from 'src/features/wallet/components/ImportTokenSheet';
import { formatUnits } from 'src/utils/amount';
import type { HomeView } from 'src/hooks/wallet/useHomeView';
import type { OctraTokens } from 'src/hooks/wallet/useOctraTokens';
import { chainLogoUrl } from 'src/services/evm/chains';
import { useDismiss } from 'src/hooks/ui/useDismiss';
import OutlineTag from 'src/shared/ui/OutlineTag';
import type { ContractToken, ListedToken } from 'src/services/tokens/octraTokens';
import type { EvmHolding, PricedHoldings } from 'src/features/wallet/home/pricedHoldings';

export type { EvmHolding } from 'src/features/wallet/home/pricedHoldings';

export interface EvmListData {
  rows: EvmHolding[];
  onSelect?: (row: EvmHolding) => void;
  networks: { chainId: number; name: string; logoChainId: number }[];
  failedChains: number[];
  refresh: () => void;
}

const fmtUsd = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fmtAmount = (amount: string) => {
  const [int, frac = ''] = amount.split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  return cut ? `${grouped}.${cut}` : grouped;
};

export const EvmTokenIcon = ({
  row,
  size = 30,
}: {
  row: Pick<EvmHolding, 'chainId' | 'token'>;
  size?: number;
}) => {
  const badge = chainLogoUrl(
    row.chainId === 11155111 ? 1 : row.chainId === 46630 ? 4663 : row.chainId
  );
  const [broken, setBroken] = useState<string | null>(null);
  const logo = row.token.logo && row.token.logo !== broken ? row.token.logo : null;
  return (
    <span className="relative! shrink-0!" style={{ width: `${size}px`, height: `${size}px` }}>
      {logo ? (
        <img
          src={logo}
          alt=""
          onError={() => setBroken(logo)}
          width={size}
          height={size}
          className="rounded-full! object-cover!"
          style={{ width: `${size}px`, height: `${size}px` }}
        />
      ) : (
        <span
          className="grid! place-items-center! rounded-full! bg-(--bg-2)!"
          style={{ width: `${size}px`, height: `${size}px`, fontSize: '11px', fontWeight: 700 }}
        >
          {row.token.symbol.slice(0, 3)}
        </span>
      )}
      {badge && (
        <img
          src={badge}
          alt=""
          width={14}
          height={14}
          className="absolute! rounded-full!"
          style={{
            right: '-3px',
            bottom: '-3px',
            background: 'var(--bg)',
            boxShadow: '0 0 0 2px var(--bg)',
          }}
        />
      )}
    </span>
  );
};

const formatBalance = (balance: string | number) => {
  if (!balance || balance === '0.00') return '0';

  const num = parseFloat(String(balance));
  if (isNaN(num)) return String(balance);

  const formatted = num.toFixed(3);
  return parseFloat(formatted).toString();
};

const UNKNOWN_AMOUNT = '---';

const TokenList = ({
  onSelectToken,
  view = 'oct',
  evm,
  octra,
  priced,
}: {
  onSelectToken?: (sel: TokenSelection) => void;
  view?: HomeView;
  evm?: EvmListData;
  octra: OctraTokens;
  priced: PricedHoldings;
}) => {
  const { t } = useTranslation();
  const [chainFilter, setChainFilter] = useState<string>('all');
  const [filterOpen, setFilterOpen] = useState(false);
  const filterRef = useDismiss<HTMLDivElement>(filterOpen, () => setFilterOpen(false));
  const evmRows = evm?.rows ?? [];
  const sumUsd = (rows: EvmHolding[]) =>
    rows.some((r) => r.usd != null) ? rows.reduce((n, r) => n + (r.usd ?? 0), 0) : null;
  const filterOptions: { id: string; label: string; logo: string | null; usd: number | null }[] = [
    {
      id: 'all',
      label:
        view === 'evm'
          ? t('home.allEvm', { defaultValue: 'All EVM' })
          : t('home.all', { defaultValue: 'All' }),
      logo: null,
      usd: view === 'evm' ? sumUsd(evmRows) : null,
    },
    ...(view === 'all'
      ? [{ id: 'oct', label: 'Octra', logo: '/chains/octra/logo.webp', usd: null }]
      : []),
    ...(evm?.networks ?? []).map((n) => ({
      id: String(n.chainId),
      label: n.name,
      logo: chainLogoUrl(n.logoChainId),
      usd: sumUsd(evmRows.filter((r) => r.chainId === n.chainId)),
    })),
  ];
  const activeFilter = filterOptions.some((o) => o.id === chainFilter) ? chainFilter : 'all';
  const filterLabel = filterOptions.find((o) => o.id === activeFilter)?.label ?? '';
  const showOctraRows = view !== 'evm' && (activeFilter === 'all' || activeFilter === 'oct');
  const shownEvmRows =
    view === 'oct' || activeFilter === 'oct'
      ? []
      : activeFilter === 'all'
        ? evmRows
        : evmRows.filter((r) => String(r.chainId) === activeFilter);
  const navigate = useNavigate();
  const {
    balance: publicBalance,
    privateBalance,
    showBalanceValues,
    activeWallet,
    refreshBalance,
  } = useWallet();
  const tokenPrices = useTokenPrice();
  const privateStatus = usePrivateStatus();
  const privateShown = privateBalance ?? (privateStatus?.kind === 'empty' ? '0' : null);
  const privateHeld = privateBalance === null && privateStatus?.kind === 'held';

  const [isRefreshing, setIsRefreshing] = useState(false);
  const [showImportForm, setShowImportForm] = useState(false);
  const tokens = octra.tokens;
  const importedTokens = octra.imported ?? [];
  const detectedTokens = octra.detected;

  const ctLogo = (t: ContractToken): string | undefined =>
    t.logoURI ?? octra.logoByAddress.get(t.contractAddress.toLowerCase());

  const contractRow = (ct: ContractToken, remove?: () => Promise<void>) => (
    <div
      key={ct.contractAddress}
      onClick={() =>
        onSelectToken?.({
          symbol: ct.symbol,
          name: ct.name,
          contract: ct.contractAddress,
          balance: ct.balance,
          logo: ctLogo(ct) ?? undefined,
          remove,
        })
      }
      className="group! relative! flex! items-center! justify-between! rounded-lg! transition-colors! duration-150! hover:bg-(--bg-1)! cursor-pointer!"
      style={{ padding: '10px 8px', minHeight: '50px' }}
    >
      <div
        className="flex! items-center! relative! z-raised! min-w-0! flex-1!"
        style={{ gap: '10px' }}
      >
        <div
          className="shrink-0! rounded-full! flex! items-center! justify-center! border!"
          style={{
            width: '30px',
            height: '30px',
            backgroundColor: 'var(--bg-2)',
            borderColor: 'var(--line)',
          }}
        >
          {ctLogo(ct) ? (
            <img
              src={ctLogo(ct)}
              alt=""
              className="w-full! h-full! rounded-full! object-cover!"
              onError={(e) => {
                const img = e.currentTarget;
                img.style.display = 'none';
                const fb = img.nextElementSibling as HTMLElement | null;
                if (fb) fb.style.display = 'block';
              }}
            />
          ) : null}
          <span
            className="text-[11px]! font-bold! uppercase! text-(--fg)"
            style={{ display: ctLogo(ct) ? 'none' : 'block' }}
          >
            {ct.symbol.slice(0, 3)}
          </span>
        </div>
        <div className="flex! flex-col! min-w-0!">
          <span className="text-(--fg) text-[13px]! font-semibold! truncate!">{ct.symbol}</span>
          <span className="text-content-muted text-[11px]! font-normal! font-mono!">
            {ct.contractAddress.slice(0, 8)}…{ct.contractAddress.slice(-4)}
          </span>
        </div>
      </div>

      <div className="flex! flex-col! items-end! relative! z-raised! shrink-0! pl-3!">
        <span
          className="text-(--fg) text-[13px]! font-semibold! tabular-nums!"
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {showBalanceValues ? formatUnits(ct.balance, ct.decimals) : '••••'}
        </span>
        <span className="text-content-muted text-[11px]! font-normal! truncate! max-w-30!">
          {ct.name}
        </span>
      </div>
    </div>
  );

  const handleRefresh = async () => {
    setIsRefreshing(true);
    if (activeWallet?.address) refreshBalance(activeWallet.address, activeWallet, true);
    evm?.refresh();
    await octra.refresh();
    setTimeout(() => setIsRefreshing(false), 500);
  };

  const TokenIcon = ({ token, isPrivate }: { token: ListedToken; isPrivate: boolean }) => {
    return (
      <div
        className="shrink-0! rounded-full! flex! items-center! justify-center! relative! overflow-hidden!"
        style={{
          width: '30px',
          height: '30px',
          backgroundColor: 'transparent',
        }}
      >
        {token.logoURI ? (
          <img
            src={token.logoURI}
            alt={token.symbol}
            crossOrigin="anonymous"
            className="object-contain! relative! z-raised! token-logo-img!"
            style={{ width: '30px', height: '30px' }}
            onError={(e) => {
              const target = e.target as HTMLImageElement;
              target.style.display = 'none';
              (target.nextSibling as HTMLElement).style.display = 'block';
            }}
          />
        ) : null}

        <div
          className="hidden! font-bold! uppercase! relative! z-raised!"
          style={{
            display: token.logoURI ? 'none' : 'block',
            fontSize: '11px',
            color: isPrivate ? 'var(--color-accent)' : 'var(--fg)',
          }}
        >
          {token.symbol.slice(0, 3)}
        </div>
      </div>
    );
  };

  return (
    <div className="flex! flex-col! mt-0! flex-1! min-h-0!">
      <div
        className="shrink-0! flex! justify-between! items-center!"
        style={{ padding: '6px 0', height: '36px', marginTop: '4px' }}
      >
        <div className="flex! items-center!" style={{ gap: '18px' }}>
          <span className="tab-caps text-(--fg)!">{t('token.tokens')}</span>
          <button
            onClick={() => navigate('/collectibles')}
            className="tab-caps transition-colors! text-content-muted hover:text-(--fg)!"
            title={t('token.nfts')}
          >
            {t('token.nfts')}
          </button>
        </div>

        <div className="flex! items-center! gap-2!">
          {view !== 'oct' && evm && evm.networks.length > 0 && (
            <div ref={filterRef} className="relative!">
              <button
                type="button"
                onClick={() => setFilterOpen((o) => !o)}
                aria-expanded={filterOpen}
                aria-haspopup="menu"
                className="footer-chip press"
                style={{ marginRight: '2px' }}
              >
                {filterLabel}
              </button>
              {filterOpen && (
                <div
                  role="menu"
                  className="footer-menu animate-in! fade-in! duration-150!"
                  style={{ right: 0, top: 'calc(100% + 6px)', bottom: 'auto', width: '220px' }}
                >
                  {filterOptions.map((o) => (
                    <button
                      key={o.id}
                      role="menuitemradio"
                      aria-checked={o.id === activeFilter}
                      onClick={() => {
                        setChainFilter(o.id);
                        setFilterOpen(false);
                      }}
                      className="footer-menu-row"
                      data-on={o.id === activeFilter || undefined}
                      style={{ flexDirection: 'row', alignItems: 'center', gap: '9px' }}
                    >
                      {o.logo ? (
                        <img src={o.logo} alt="" width={18} height={18} className="rounded-full!" />
                      ) : (
                        <span style={{ width: '18px' }} />
                      )}
                      <span
                        style={{ flex: 1, fontSize: '12.5px', fontWeight: 600, color: 'var(--fg)' }}
                      >
                        {o.label}
                      </span>
                      {o.usd != null && showBalanceValues && (
                        <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                          {fmtUsd(o.usd)}
                        </span>
                      )}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          <button
            onClick={() => setShowImportForm(true)}
            className="text-content-muted hover:text-(--text-main) transition-colors!"
            title={t('token.importToken')}
          >
            <Plus className="w-3.5! h-3.5!" />
          </button>
          <button
            onClick={handleRefresh}
            className={`text-content-muted hover:text-(--text-main) transition-colors! ${isRefreshing ? 'animate-spin!' : ''}`}
          >
            <RefreshCw className="w-3.5! h-3.5!" />
          </button>
        </div>
      </div>

      {showImportForm && (
        <ImportTokenSheet onClose={() => setShowImportForm(false)} octra={octra} />
      )}

      <div
        className="footer-clear flex-1! overflow-y-auto! scrollbar-hide! min-h-0!"
        style={{ padding: '4px 0 12px', margin: '0 -8px' }}
      >
        {showOctraRows && (
          <>
            {tokens.map((token, index) => {
              const isPrivate = !!token.extensions?.isPrivate;
              const isNative = !isPrivate && !!token.tags?.includes('native');

              const nativeAmount = isPrivate ? privateShown : isNative ? publicBalance : null;
              const held = isPrivate && privateHeld;
              const balanceDisplay =
                isPrivate || isNative
                  ? (nativeAmount ?? UNKNOWN_AMOUNT)
                  : octra.balances
                    ? formatUnits(octra.balances[token.address] ?? '0', token.decimals ?? 0)
                    : UNKNOWN_AMOUNT;
              const contractUsd = priced.contractUsd[token.address];
              const usdDisplay =
                balanceDisplay === UNKNOWN_AMOUNT
                  ? '--'
                  : isPrivate || isNative
                    ? (tokenPrices.getUsdValue('OCT', parseFloat(nativeAmount ?? '0') || 0) ?? '--')
                    : contractUsd == null
                      ? '--'
                      : formatUsd(contractUsd);

              return (
                <div
                  key={`${token.address}-${index}`}
                  onClick={() => {
                    if (isNative || isPrivate) {
                      onSelectToken?.({
                        symbol: token.symbol,
                        name: token.name,
                        isPrivate,
                        logo: token.logoURI,
                      });
                    } else {
                      onSelectToken?.({
                        symbol: token.symbol,
                        name: token.name,
                        contract: token.address,
                        balance: balanceDisplay,
                        logo: token.logoURI,
                      });
                    }
                  }}
                  className="group! relative! flex! items-center! justify-between! rounded-lg! transition-colors! duration-150! hover:bg-(--bg-1)! cursor-pointer!"
                  style={{ padding: '10px 8px', minHeight: '50px' }}
                >
                  <div
                    className="flex! items-center! relative! z-raised! min-w-0! flex-1!"
                    style={{ gap: '10px' }}
                  >
                    <TokenIcon token={token} isPrivate={isPrivate} />

                    <div className="flex! flex-col! min-w-0!">
                      <div className="flex! items-center! gap-1.5! min-w-0!">
                        <span className="text-(--fg) text-[13px]! font-semibold! truncate!">
                          {token.symbol}
                        </span>
                        {isPrivate && (
                          <OutlineTag label={t('token.encrypted', { defaultValue: 'Encrypted' })} />
                        )}
                      </div>
                      <span className="text-content-muted text-[11px]! font-normal! truncate!">
                        {token.name}
                      </span>
                    </div>
                  </div>

                  <div className="flex! flex-col! items-end! relative! z-raised! shrink-0! pl-3!">
                    <span
                      className={`${held ? 'text-(--fg-3)' : 'text-(--fg)'} text-[13px]! font-semibold! tabular-nums!`}
                      style={{ fontVariantNumeric: 'tabular-nums' }}
                    >
                      {held
                        ? t('token.onHold', { defaultValue: 'On hold' })
                        : showBalanceValues
                          ? balanceDisplay === UNKNOWN_AMOUNT || !(isPrivate || isNative)
                            ? balanceDisplay
                            : formatBalance(balanceDisplay)
                          : '••••'}
                    </span>
                    {!held && (
                      <span className="text-content-muted text-[11px]! font-normal!">
                        {showBalanceValues ? usdDisplay : '••••'}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}

            {detectedTokens.map((ct) => contractRow(ct))}

            {importedTokens.length > 0 && (
              <>
                <div className="px-2! pt-3! pb-1!">
                  <span className="text-[11px]! font-medium! text-content-muted">
                    {t('token.importedTokens')}
                  </span>
                </div>
                {importedTokens.map((ct) =>
                  contractRow(ct, () => octra.removeImported(ct.contractAddress))
                )}
              </>
            )}
          </>
        )}

        {view !== 'oct' &&
          shownEvmRows.map((row) => (
            <div
              key={`${row.chainId}-${row.token.address ?? 'native'}`}
              onClick={() => evm?.onSelect?.(row)}
              className="group! relative! flex! items-center! justify-between! rounded-lg! hover:bg-(--bg-1)! transition-colors! duration-150! cursor-pointer!"
              style={{ padding: '10px 8px', minHeight: '50px' }}
            >
              <div
                className="flex! items-center! relative! z-raised! min-w-0! flex-1!"
                style={{ gap: '10px' }}
              >
                <EvmTokenIcon row={row} />
                <div className="flex! flex-col! min-w-0!">
                  <span className="text-(--fg) text-[13px]! font-semibold! truncate!">
                    {row.token.symbol}
                  </span>
                  <span className="text-content-muted text-[11px]! font-normal! truncate!">
                    {row.chainName}
                  </span>
                </div>
              </div>
              <div className="flex! flex-col! items-end! relative! z-raised! shrink-0! pl-3!">
                <span
                  className="text-(--fg) text-[13px]! font-semibold! tabular-nums!"
                  style={{ fontVariantNumeric: 'tabular-nums' }}
                >
                  {showBalanceValues ? fmtAmount(row.amount) : '••••'}
                </span>
                <span className="text-content-muted text-[11px]! font-normal!">
                  {!showBalanceValues ? '••••' : row.usd == null ? '--' : fmtUsd(row.usd)}
                </span>
              </div>
            </div>
          ))}
        {showOctraRows && octra.listUnavailable && (
          <p style={{ margin: '6px 8px 0', fontSize: '11px', color: 'var(--fg-3)' }}>
            {t('token.listUnavailable', {
              defaultValue: 'Could not load the token list. Some tokens may be missing.',
            })}
          </p>
        )}
        {view !== 'oct' && evm && evm.failedChains.length > 0 && (
          <p style={{ margin: '6px 8px 0', fontSize: '11px', color: 'var(--fg-3)' }}>
            {t('home.evmChainsUnreachable', {
              names: evm.networks
                .filter((n) => evm.failedChains.includes(n.chainId))
                .map((n) => n.name)
                .join(' and '),
              defaultValue: '{{names}} unreachable. Some balances may be missing.',
            })}
          </p>
        )}
      </div>
    </div>
  );
};

export default TokenList;
