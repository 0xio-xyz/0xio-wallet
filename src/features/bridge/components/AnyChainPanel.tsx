import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { ChevronDown } from 'src/shared/ui/icons';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { FieldNote, PrimaryButton, Sheet, TextButton, quietField } from 'src/shared/ui/primitives';
import { orderByHeld, searchChains, searchTokens } from 'src/features/bridge/anyChainSearch';
import { useHeldByChain } from 'src/features/bridge/useHeldByChain';
import { bridgeErrorText } from 'src/features/bridge/bridgeErrors';
import { useWallet } from 'src/contexts/WalletContext';
import { useLiveQuote } from 'src/features/bridge/useLiveQuote';
import {
  NO_AMOUNTS,
  amountNote,
  drivenAmount,
  fieldValues,
  freshQuoteProblem,
  receiveMaxPay,
  type AmountField,
  type Amounts,
  type Order,
} from 'src/features/bridge/anyChainAmounts';
import { formatUsd, useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { useEvmPrices } from 'src/hooks/wallet/useEvmPrices';
import { llamaKey } from 'src/services/evm/prices';
import { amountUsd, fmtFeeUsd } from 'src/features/bridge/bridgeUsd';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { middleCut } from 'src/features/wallet/add/format';
import { OCT_DECIMALS, cleanAmountInput, fromUnits } from 'src/utils/amount';
import { isOctAddress } from 'src/utils/octra/address';
import { logger } from 'src/utils/logger';
import {
  chainLogos,
  chainNetwork,
  feesUsd,
  fetchChains,
  fetchQuote,
  MIN_OUT_RAW,
  NATIVE_TOKEN,
  payRawOf,
  quoteTxs,
  requestIdOf,
  tokenBalance,
  tokenLogos,
  type AnyChain,
  type AnyQuote,
  type AnyToken,
  type QuoteTx,
} from 'src/services/bridge/relay/anyChain';
import { checkQuote } from 'src/services/bridge/relay/check';
import type { BridgeTransfer } from 'src/services/bridge/transfers';
import type { PreparedTransfer } from 'src/services/evm/send';
import { estimateFees, waitForReceipt } from 'src/services/evm/send';
import { applyFeeChoice, stillCovers, type FeeChoice } from 'src/services/evm/feeChoice';
import NetworkFeeRow from 'src/features/bridge/components/NetworkFeeRow';
import { reportBridge } from 'src/services/bridge/track';
import { prepareCall, signAndBroadcast } from 'src/services/evm/signer';

interface Priced {
  order: Order;
  tx: QuoteTx;
  prepared: PreparedTransfer;
  outRaw: bigint;
  payRaw: bigint;
}

type Review = (
  | (Priced & { stage: 'approve' })
  | (Priced & { stage: 'deposit'; quote: AnyQuote })
) & {
  fee?: FeeChoice;
  feeRaised?: boolean;
};

/** The 0xio app fee on this route, as the proxy charges it (25 bps). */
const APP_FEE_LABEL = '0.25%';

const fmt = (raw: bigint, decimals: number, places = 6) => {
  const [int, frac = ''] = fromUnits(raw, decimals).split('.');
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  return cut ? `${grouped}.${cut}` : grouped;
};

const Monogram = ({ text }: { text: string }) => (
  <span
    className="grid! shrink-0! place-items-center! rounded-full! bg-(--bg-3)!"
    style={{ width: '30px', height: '30px', fontSize: '11px', fontWeight: 600, color: 'var(--fg)' }}
  >
    {text.slice(0, 2).toUpperCase()}
  </span>
);

const Logo = ({ sources, text }: { sources: string[]; text: string }) => {
  const id = sources.join(' ');
  const [failed, setFailed] = useState({ id, count: 0 });
  const count = failed.id === id ? failed.count : 0;
  const src = sources[count];
  if (!src) return <Monogram text={text} />;
  return (
    <img
      src={src}
      alt=""
      width={30}
      height={30}
      draggable={false}
      onError={() => setFailed({ id, count: count + 1 })}
      className="shrink-0! rounded-full!"
      style={{ width: '30px', height: '30px', objectFit: 'cover' }}
    />
  );
};

const Row = ({ label, value }: { label: string; value: React.ReactNode }) => (
  <div className="flex! items-start! justify-between!" style={{ padding: '10px 4px', gap: '14px' }}>
    <span className="tab-caps" style={{ color: 'var(--fg-3)', paddingTop: '2px', flexShrink: 0 }}>
      {label}
    </span>
    <span
      style={{
        fontSize: '13px',
        color: 'var(--fg)',
        textAlign: 'right',
        overflowWrap: 'anywhere',
        fontVariantNumeric: 'tabular-nums',
      }}
    >
      {value}
    </span>
  </div>
);

const AnyChainPanel = ({
  octAddress,
  wallet,
  onStarted,
}: {
  octAddress: string;
  wallet: { id: string; evmIndex: number; evmAddress: string };
  onStarted: (t: BridgeTransfer) => void;
}) => {
  const { t } = useTranslation();
  const { showMessage, networkId } = useWallet();
  const [chains, setChains] = useState<AnyChain[]>([]);
  const [chainId, setChainId] = useState<number | null>(null);
  const [tokenAddr, setTokenAddr] = useState<string>(NATIVE_TOKEN);
  const [balance, setBalance] = useState<bigint | null>(null);
  const [amounts, setAmounts] = useState<Amounts>(NO_AMOUNTS);
  const [customTo, setCustomTo] = useState<string | null>(null);
  const [picker, setPicker] = useState<'chain' | 'token' | null>(null);
  const [query, setQuery] = useState('');
  const held = useHeldByChain(wallet?.evmAddress);
  const [review, setReview] = useState<Review | null>(null);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const balanceRun = useRef(0);

  const chain = chains.find((c) => c.id === chainId) ?? null;
  const nativeKey = chain ? llamaKey(chain.id, { address: null }) : null;
  const nativePrices = useEvmPrices(nativeKey ? [nativeKey] : []);
  const nativePrice = nativeKey ? nativePrices[nativeKey] : undefined;
  const { getPrice } = useTokenPrice();
  const token =
    chain?.tokens.find((x) => x.address.toLowerCase() === tokenAddr.toLowerCase()) ?? null;
  const recipient = (customTo ?? octAddress).trim();
  const recipientOk = isOctAddress(recipient);
  const payDecimals = token?.decimals ?? 18;
  const { mode, raw } = drivenAmount(amounts, payDecimals);
  const quoting =
    !!chain && !!token && recipientOk && raw > 0n && (mode === 'spend' || raw >= MIN_OUT_RAW);
  const live = useLiveQuote(
    quoting && chain && token
      ? {
          user: wallet.evmAddress,
          originChainId: chain.id,
          originCurrency: token.address,
          octraRecipient: recipient,
          amountRaw: raw.toString(),
          mode,
        }
      : null
  );
  const values = fieldValues(amounts, live, payDecimals);
  const note = amountNote({
    amounts,
    raw,
    balance,
    quoting,
    outRaw: live.outRaw,
    payRaw: live.payRaw,
    loading: live.loading,
    failed: live.failed,
  });
  const noteNeg = note === 'over' || (note === 'min' && (mode === 'receive' || !live.loading));
  const canReview =
    quoting &&
    !noteNeg &&
    !busy &&
    (mode === 'spend' || (live.payRaw !== null && !live.loading && !live.failed));

  const readBalance = async (c: AnyChain, tok: AnyToken) => {
    const run = ++balanceRun.current;
    setBalance(null);
    try {
      const b = await tokenBalance(c, tok, wallet.evmAddress);
      if (run === balanceRun.current) setBalance(b);
    } catch (e) {
      logger.warn('[AnyChain] balance read failed', e);
    }
  };

  const choose = (c: AnyChain, tokAddr = NATIVE_TOKEN) => {
    const tok =
      c.tokens.find((x) => x.address.toLowerCase() === tokAddr.toLowerCase()) ?? c.tokens[0];
    setChainId(c.id);
    setTokenAddr(tok?.address ?? NATIVE_TOKEN);
    setAmounts(NO_AMOUNTS);
    setProblem(null);
    if (tok) void readBalance(c, tok);
  };

  useMountEffect(() => {
    fetchChains()
      .then((list) => {
        const usable = list.filter((c) => c.rpc && c.tokens.length > 0);
        setChains(usable);
        const first =
          usable.find((c) => c.id === 8453) ?? usable.find((c) => c.id === 1) ?? usable[0];
        if (first) choose(first);
      })
      .catch((e) => {
        logger.warn('[AnyChain] chains failed', e);
        setProblem(
          t('anyChain.chainsFailed', {
            defaultValue: 'Could not load chains. Try again later.',
          })
        );
      });
  });

  const fail = (e: unknown, network: string, fallback: string) => {
    logger.warn('[AnyChain]', e);
    const msg = e instanceof Error ? e.message : '';
    showMessage(
      /Nothing was sent|Relay|swap service|signature step|price dropped/i.test(msg)
        ? msg
        : bridgeErrorText(e, t, network, fallback),
      'error'
    );
  };

  const nativeEnough = async (c: AnyChain, p: PreparedTransfer) => {
    const native = c.tokens.find((x) => x.address === NATIVE_TOKEN) ?? {
      address: NATIVE_TOKEN,
      symbol: 'ETH',
      name: 'Ether',
      decimals: 18,
      logo: null,
    };
    const have = await tokenBalance(c, native, wallet.evmAddress);
    if (have >= p.totalNative) return true;
    showMessage(
      t('anyChain.noGas', {
        defaultValue: 'Insufficient {{symbol}} on {{chain}} for network fee',
        symbol: native.symbol,
        chain: c.name,
      }),
      'error'
    );
    return false;
  };

  const orderNow = (): Order | null => {
    if (mode === 'spend') {
      return { mode, amountRaw: raw, shownOutRaw: live.outRaw ?? undefined, maxPayRaw: raw };
    }
    if (live.payRaw === null) return null;
    return { mode, amountRaw: raw, maxPayRaw: receiveMaxPay(BigInt(live.payRaw), balance) };
  };

  const startReview = async (order: Order | null) => {
    if (!chain || !token || !order) return;
    setBusy(true);
    setProblem(null);
    try {
      const quote = await fetchQuote({
        user: wallet.evmAddress,
        originChainId: chain.id,
        originCurrency: token.address,
        octraRecipient: recipient,
        amountRaw: order.amountRaw.toString(),
        mode: order.mode,
      });
      const outRaw = BigInt(quote.outRaw);
      const quotedPay = payRawOf(quote.quote);
      const payRaw = quotedPay === null ? null : BigInt(quotedPay);
      const problemNow = freshQuoteProblem(order, outRaw, payRaw);
      if (problemNow === 'min') {
        setProblem(t('anyChain.min', { defaultValue: 'Minimum receive amount is 1 OCT' }));
        return;
      }
      if (problemNow === 'dropped') {
        showMessage(
          t('anyChain.dropped', {
            defaultValue: 'Quote dropped by more than 1% (now {{amount}} OCT). Review again.',
            amount: fmt(outRaw, 6),
          }),
          'error'
        );
        return;
      }
      if (problemNow === 'moved') {
        showMessage(
          payRaw === null
            ? t('anyChain.quoteFailed', { defaultValue: 'Quote unavailable. Try again.' })
            : t('anyChain.moved', {
                defaultValue:
                  'Quote changed by more than 1% (now {{amount}} {{symbol}}). Review again.',
                amount: fmt(payRaw, token.decimals),
                symbol: token.symbol,
              }),
          'error'
        );
        return;
      }
      await checkQuote({
        quote: quote.quote,
        outRaw: quote.outRaw,
        user: wallet.evmAddress,
        octraRecipient: recipient,
        chainId: chain.id,
        token,
        maxPayRaw: order.maxPayRaw.toString(),
      });
      const txs = quoteTxs(quote.quote);
      const next = txs[0];
      const network = chainNetwork(chains.find((c) => c.id === next.data.chainId) ?? chain);
      const prepared = await prepareCall(network, {
        from: wallet.evmAddress,
        to: next.data.to,
        value: BigInt(next.data.value ?? '0'),
        data: next.data.data,
        gasLimit: next.data.gas ? (BigInt(next.data.gas) * 12n) / 10n : undefined,
      });
      if (!(await nativeEnough(chains.find((c) => c.id === next.data.chainId) ?? chain, prepared)))
        return;
      const priced = { order, tx: next, prepared, outRaw, payRaw: payRaw ?? order.maxPayRaw };
      setReview(
        next.kind === 'approve'
          ? { ...priced, stage: 'approve' }
          : { ...priced, stage: 'deposit', quote }
      );
    } catch (e) {
      fail(
        e,
        chain.name,
        t('anyChain.quoteFailed', { defaultValue: 'Quote unavailable. Try again.' })
      );
    } finally {
      setBusy(false);
    }
  };

  const confirm = async () => {
    if (!review || !chain || !token) return;
    const network = chainNetwork(chains.find((c) => c.id === review.tx.data.chainId) ?? chain);
    const sourceChain = chains.find((c) => c.id === review.tx.data.chainId) ?? chain;
    setBusy(true);
    setProblem(null);
    try {
      const signs = applyFeeChoice(review.prepared, review.fee);
      if (
        signs.totalNative > review.prepared.totalNative &&
        !(await nativeEnough(sourceChain, signs))
      )
        return;
      const fresh = await estimateFees(network).catch((e: unknown): null => {
        logger.warn('[AnyChain] fee check before signing failed, signing the reviewed fee', e);
        return null;
      });
      if (fresh && !stillCovers(signs.tx, fresh)) {
        setReview({
          ...review,
          prepared: { ...review.prepared, fees: fresh },
          fee: review.fee && 'speed' in review.fee ? review.fee : undefined,
          feeRaised: true,
        });
        return;
      }
      const hash = await signAndBroadcast(network, signs.tx, wallet);
      if (review.stage === 'approve') {
        const receipt = await waitForReceipt(network, hash, { timeoutMs: 180_000 }).catch(
          (e: unknown): null => {
            logger.warn('[AnyChain] approval still confirming', e);
            return null;
          }
        );
        setReview(null);
        if (!receipt) {
          showMessage(
            t('anyChain.approveSlow', {
              defaultValue: 'Approval sent and still confirming. Review again in a moment.',
            }),
            'info'
          );
          return;
        }
        if (receipt.status !== 'success') {
          showMessage(
            t('anyChain.approveFailed', { defaultValue: 'Approval failed. Nothing was sent.' }),
            'error'
          );
          return;
        }
        setBusy(false);
        await startReview({ ...review.order, shownOutRaw: undefined });
        return;
      }
      const requestId = requestIdOf(review.quote.quote);
      const now = Date.now();
      onStarted({
        id: `a2o-${now}`,
        direction: 'a2o',
        amountRaw: review.quote.outRaw,
        octAddress,
        evmAddress: wallet.evmAddress,
        recipient,
        createdAt: now,
        updatedAt: now,
        status: 'swapping',
        relayRequestId: requestId ?? undefined,
        depositHash: hash,
        sourceChain: chain.name,
        sourcePaid: `${fmt(review.payRaw, token.decimals, 8)} ${token.symbol}`,
        sourceExplorer: chain.explorer,
      });
      if (requestId) {
        reportBridge(
          {
            kind: 'any_swap',
            txHash: requestId,
            amountRaw: review.quote.outRaw,
            octraAddr: recipient,
            ethAddr: wallet.evmAddress,
          },
          networkId
        );
      }
      setReview(null);
      setAmounts(NO_AMOUNTS);
      showMessage(t('bridge.sent.burn', { defaultValue: 'Bridging to Octra' }), 'info');
    } catch (e) {
      setReview(null);
      fail(
        e,
        network.name,
        t('bridge.sendFailed', { defaultValue: 'Transaction not sent. Try again.' })
      );
    } finally {
      setBusy(false);
    }
  };

  const pickRow = (
    key: string,
    logos: string[],
    label: string,
    sub: string,
    pick: () => void,
    right?: string
  ) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        pick();
        setPicker(null);
      }}
      className="press flex! w-full! items-center! rounded-[14px]! hover:bg-(--bg-2)!"
      style={{
        gap: '12px',
        padding: '10px',
        border: 'none',
        background: 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
      }}
    >
      <Logo sources={logos} text={label} />
      <span className="flex! min-w-0! flex-col!" style={{ gap: '2px' }}>
        <span style={{ fontSize: '13.5px', color: 'var(--fg)' }}>{label}</span>
        {sub && (
          <span className="truncate!" style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>
            {sub}
          </span>
        )}
      </span>
      {right && (
        <span
          style={{
            marginLeft: 'auto',
            fontSize: '12.5px',
            color: 'var(--fg-2)',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {right}
        </span>
      )}
    </button>
  );

  const fees = review?.stage === 'deposit' ? feesUsd(review.quote.quote) : null;
  const quotedPayUsd =
    review?.stage === 'deposit' ? Number(review.quote.quote.details?.currencyIn?.amountUsd) : NaN;
  const payUsd =
    review && Number.isFinite(quotedPayUsd) && quotedPayUsd > 0
      ? quotedPayUsd
      : review && token?.address === NATIVE_TOKEN && nativePrice
        ? Number(fromUnits(review.payRaw, token.decimals)) * nativePrice
        : null;
  const payLogos = {
    chain: chain ? chainLogos(chain) : [],
    token: chain && token ? tokenLogos(chain, token) : [],
  };

  const amountBox = (
    field: AmountField,
    label: string,
    symbol: string,
    action?: React.ReactNode
  ) => {
    const driving = amounts.driver === field;
    return (
      <div>
        <div className="flex! items-center! justify-between!" style={{ height: '16px' }}>
          <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
            {label}
          </span>
          {action}
        </div>
        <div
          className="flex! items-center! bg-(--bg-1)!"
          style={{
            marginTop: '6px',
            height: '48px',
            padding: '0 16px',
            borderRadius: '16px',
            gap: '8px',
          }}
        >
          <input
            value={values[field]}
            onChange={(e) => {
              const next = cleanAmountInput(
                e.target.value,
                field === 'pay' ? Math.min(payDecimals, 18) : OCT_DECIMALS,
                15
              );
              if (next !== null) setAmounts({ driver: field, text: next });
            }}
            disabled={!token}
            inputMode="decimal"
            placeholder="0"
            aria-label={label}
            className="outline-none!"
            style={{
              flex: 1,
              minWidth: 0,
              border: 'none',
              background: 'transparent',
              color: driving ? 'var(--fg)' : 'var(--fg-2)',
              opacity: !driving && live.loading ? 0.5 : 1,
              transition: 'opacity 200ms ease-out, color 200ms ease-out',
              fontSize: '24px',
              fontWeight: 300,
              letterSpacing: '-0.03em',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{symbol}</span>
        </div>
      </div>
    );
  };

  const noteText = (): string => {
    switch (note) {
      case 'balance':
        return balance !== null && token
          ? t('anyChain.balance', {
              defaultValue: 'Balance {{amount}} {{symbol}} on {{chain}}',
              amount: fmt(balance, token.decimals),
              symbol: token.symbol,
              chain: chain?.name ?? '',
            })
          : '';
      case 'over':
        return t('anyChain.over', { defaultValue: 'Insufficient balance' });
      case 'min':
        return mode === 'receive'
          ? t('anyChain.minReceive', { defaultValue: 'Minimum amount is 1 OCT' })
          : t('anyChain.min', { defaultValue: 'Minimum receive amount is 1 OCT' });
      case 'fees':
        return live.feesUsd !== null
          ? t('anyChain.feesAbout', {
              defaultValue: 'Estimated fees {{fees}}',
              fees: formatUsd(live.feesUsd),
            })
          : '';
      case 'noPrice':
        return t('anyChain.noPrice', { defaultValue: 'No quote for this amount' });
      case 'pricing':
        return t('anyChain.pricing', { defaultValue: 'Fetching quote' });
      default:
        return '';
    }
  };

  return (
    <div className="flex! min-h-0! flex-1! flex-col!">
      <div className="flex! shrink-0!" style={{ gap: '8px' }}>
        {(['chain', 'token'] as const).map((kind) => (
          <button
            key={kind}
            type="button"
            disabled={chains.length === 0}
            onClick={() => {
              setQuery('');
              setPicker(kind);
            }}
            className="press flex! flex-1! items-center! bg-(--bg-1)! hover:bg-(--bg-2)!"
            style={{
              gap: '10px',
              padding: '8px 12px',
              borderRadius: '16px',
              border: 'none',
              cursor: 'pointer',
              textAlign: 'left',
              minWidth: 0,
            }}
          >
            <Logo
              sources={payLogos[kind]}
              text={(kind === 'chain' ? chain?.name : token?.symbol) ?? '?'}
            />
            <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '2px' }}>
              <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
                {kind === 'chain'
                  ? t('anyChain.chain', { defaultValue: 'Chain' })
                  : t('anyChain.token', { defaultValue: 'Token' })}
              </span>
              <span className="truncate!" style={{ fontSize: '13.5px', color: 'var(--fg)' }}>
                {(kind === 'chain' ? chain?.name : token?.symbol) ?? '...'}
              </span>
            </span>
            <ChevronDown size={14} style={{ color: 'var(--fg-3)' }} />
          </button>
        ))}
      </div>

      <div className="flex! shrink-0! flex-col!" style={{ marginTop: '12px', gap: '10px' }}>
        {amountBox(
          'pay',
          t('anyChain.pay', { defaultValue: 'You bridge' }),
          token?.symbol ?? '',
          <TextButton
            size={12}
            onClick={() =>
              balance !== null &&
              token &&
              setAmounts({
                driver: 'pay',
                text: fromUnits(
                  token.address === NATIVE_TOKEN ? (balance * 97n) / 100n : balance,
                  token.decimals
                ),
              })
            }
          >
            {t('bridge.max', { defaultValue: 'Max' })}
          </TextButton>
        )}
        {amountBox(
          'receive',
          t('anyChain.receive', { defaultValue: 'You get (estimated)' }),
          'OCT'
        )}
      </div>
      <div className="shrink-0!">
        <FieldNote tone={noteNeg ? 'neg' : 'muted'}>
          <span
            style={{
              opacity: live.loading && note !== 'over' && note !== 'balance' ? 0.5 : 1,
              transition: 'opacity 200ms ease-out',
            }}
          >
            {noteText()}
          </span>
        </FieldNote>
      </div>

      <div className="shrink-0!" style={{ marginTop: '4px' }}>
        <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {t('anyChain.receiveOn', { defaultValue: 'OCT arrives at' })}
        </span>
        {customTo === null ? (
          <div
            className="flex! items-center! justify-between! bg-(--bg-1)!"
            style={{
              marginTop: '6px',
              height: '44px',
              padding: '0 14px',
              borderRadius: '16px',
              gap: '10px',
            }}
          >
            <span
              style={{ fontSize: '12.5px', color: 'var(--fg)', fontFamily: 'var(--font-mono)' }}
            >
              {middleCut(octAddress, 10, 8)}
            </span>
            <TextButton size={12} onClick={() => setCustomTo('')}>
              {t('bridge.change', { defaultValue: 'Change' })}
            </TextButton>
          </div>
        ) : (
          <div className="relative!">
            <input
              autoFocus
              value={customTo}
              onChange={(e) => setCustomTo(e.target.value.replace(/\s+/g, '').slice(0, 47))}
              onKeyDown={(e) => {
                if (e.key === 'Escape') {
                  e.stopPropagation();
                  setCustomTo(null);
                }
              }}
              placeholder="oct address"
              aria-label={t('anyChain.receiveOn', { defaultValue: 'OCT arrives at' })}
              spellCheck={false}
              autoComplete="off"
              className={`${quietField} ${customTo && !recipientOk ? 'border-(--neg)!' : ''}`}
              style={{
                marginTop: '6px',
                height: '44px',
                borderRadius: '16px',
                fontFamily: 'var(--font-mono)',
                fontSize: '12.5px',
                paddingRight: '76px',
              }}
            />
            <span
              className="absolute! flex! items-center!"
              style={{ right: '14px', top: '6px', height: '44px' }}
            >
              <TextButton size={12} onClick={() => setCustomTo(null)}>
                {t('common.cancel', { defaultValue: 'Cancel' })}
              </TextButton>
            </span>
          </div>
        )}
      </div>

      <div
        className="shrink-0! rounded-2xl! bg-(--bg-1)!"
        style={{ marginTop: '10px', padding: '2px 14px' }}
      >
        {[
          [
            t('anyChain.arrivesLabel', { defaultValue: 'Arrives' }),
            t('anyChain.arrivesValue', { defaultValue: 'Usually in a few minutes' }),
          ],
          [t('anyChain.feeLabel', { defaultValue: '0xio fee' }), APP_FEE_LABEL],
        ].map(([k, v]) => (
          <div
            key={k}
            className="flex! items-center! justify-between!"
            style={{ height: '30px', fontSize: '11.5px', gap: '12px' }}
          >
            <span style={{ color: 'var(--fg-3)' }}>{k}</span>
            <span style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>{v}</span>
          </div>
        ))}
      </div>

      <div className="mt-auto! shrink-0!">
        <FieldNote tone="neg">{problem ?? ''}</FieldNote>
        <PrimaryButton
          onClick={() => void startReview(orderNow())}
          disabled={!canReview}
          loading={busy && !review}
          style={BIG_BUTTON}
        >
          {t('bridge.reviewBridge', { defaultValue: 'Review bridge' })}
        </PrimaryButton>
      </div>

      <Sheet
        open={picker !== null}
        onClose={() => setPicker(null)}
        pinned={
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value.slice(0, 64))}
            placeholder={
              picker === 'chain'
                ? t('anyChain.searchChains', { defaultValue: 'Search chains' })
                : t('anyChain.searchTokens', { defaultValue: 'Search tokens or chains' })
            }
            aria-label={
              picker === 'chain'
                ? t('anyChain.searchChains', { defaultValue: 'Search chains' })
                : t('anyChain.searchTokens', { defaultValue: 'Search tokens or chains' })
            }
            spellCheck={false}
            autoComplete="off"
            className={quietField}
          />
        }
        title={
          picker === 'chain'
            ? t('anyChain.pickChain', { defaultValue: 'Bridge from chain' })
            : t('anyChain.pickToken', { defaultValue: 'Token to bridge' })
        }
      >
        {picker === 'chain' &&
          orderByHeld(searchChains(chains, query), held).map((c) =>
            pickRow(
              String(c.id),
              chainLogos(c),
              c.name,
              '',
              () => choose(c),
              held[c.id] ? formatUsd(held[c.id]) : undefined
            )
          )}
        {picker === 'token' &&
          (() => {
            const found = searchTokens(chains, chain, query);
            return (
              <>
                {chain &&
                  found.here.map((tk) =>
                    pickRow(tk.address, tokenLogos(chain, tk), tk.symbol, tk.name, () =>
                      choose(chain, tk.address)
                    )
                  )}
                {found.elsewhere.length > 0 && (
                  <span
                    className="tab-caps"
                    style={{ display: 'block', color: 'var(--fg-3)', padding: '14px 10px 6px' }}
                  >
                    {t('anyChain.otherChains', { defaultValue: 'On other chains' })}
                  </span>
                )}
                {found.elsewhere.map((h) =>
                  pickRow(
                    `${h.chain.id}:${h.token.address}`,
                    tokenLogos(h.chain, h.token),
                    h.token.symbol,
                    t('anyChain.tokenOnChain', {
                      defaultValue: '{{name}} on {{chain}}',
                      name: h.token.name,
                      chain: h.chain.name,
                    }),
                    () => choose(h.chain, h.token.address)
                  )
                )}
                {found.here.length === 0 && found.elsewhere.length === 0 && (
                  <p
                    style={{
                      margin: 0,
                      padding: '18px 10px',
                      fontSize: '12px',
                      color: 'var(--fg-3)',
                      textAlign: 'center',
                    }}
                  >
                    {t('anyChain.noMatch', { defaultValue: 'No results' })}
                  </p>
                )}
              </>
            );
          })()}
        {picker === 'chain' && searchChains(chains, query).length === 0 && (
          <p
            style={{
              margin: 0,
              padding: '18px 10px',
              fontSize: '12px',
              color: 'var(--fg-3)',
              textAlign: 'center',
            }}
          >
            {t('anyChain.noMatch', { defaultValue: 'No results' })}
          </p>
        )}
      </Sheet>

      <Sheet
        open={!!review}
        onClose={() => !busy && setReview(null)}
        dismissible={!busy}
        title={
          review?.stage === 'approve'
            ? t('anyChain.reviewApprove', {
                defaultValue: 'Review {{symbol}} approval',
                symbol: token?.symbol ?? '',
              })
            : t('anyChain.reviewDeposit', { defaultValue: 'Review bridge' })
        }
        footer={
          <div className="flex!" style={{ gap: '10px' }}>
            <PrimaryButton
              secondary
              onClick={() => setReview(null)}
              disabled={busy}
              style={BIG_BUTTON}
            >
              {t('common.reject', { defaultValue: 'Reject' })}
            </PrimaryButton>
            <PrimaryButton onClick={() => void confirm()} loading={busy} style={BIG_BUTTON}>
              {review?.stage === 'approve'
                ? t('bridge.allow', { defaultValue: 'Approve' })
                : t('anyChain.payAction', { defaultValue: 'Bridge to Octra' })}
            </PrimaryButton>
          </div>
        }
      >
        {review && chain && token && (
          <>
            {review.stage === 'deposit' && (
              <div style={{ padding: '4px 4px 16px' }}>
                <div
                  style={{
                    fontSize: '34px',
                    fontWeight: 300,
                    letterSpacing: '-0.04em',
                    color: 'var(--fg)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {fmt(review.outRaw, OCT_DECIMALS)}{' '}
                  <span style={{ fontSize: '16px', color: 'var(--fg-3)', letterSpacing: 0 }}>
                    OCT
                  </span>
                </div>
                <div
                  style={{
                    height: '16px',
                    marginTop: '2px',
                    fontSize: '12px',
                    lineHeight: '16px',
                    color: 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {amountUsd(review.outRaw, OCT_DECIMALS, getPrice('OCT')) ?? ''}
                </div>
              </div>
            )}
            <div className="rounded-[18px]! bg-(--bg-2)!" style={{ padding: '4px 10px' }}>
              <Row
                label={t('anyChain.pay', { defaultValue: 'You bridge' })}
                value={
                  <>
                    {`${fmt(review.payRaw, token.decimals, 8)} ${token.symbol}`}
                    {payUsd !== null && (
                      <span style={{ display: 'block', fontSize: '11.5px', color: 'var(--fg-3)' }}>
                        {formatUsd(payUsd)}
                      </span>
                    )}
                  </>
                }
              />
              {review.stage === 'approve' && (
                <Row
                  label={t('anyChain.receive', { defaultValue: 'You get (estimated)' })}
                  value={`${fmt(review.outRaw, OCT_DECIMALS)} OCT`}
                />
              )}
              <Row label={t('anyChain.chain', { defaultValue: 'Chain' })} value={chain.name} />
              {review.stage === 'deposit' && (
                <Row label={t('anyChain.to', { defaultValue: 'OCT to' })} value={recipient} />
              )}
              {review.stage === 'approve' && (
                <Row
                  label={t('bridge.spender', { defaultValue: 'Spender' })}
                  value={review.tx.data.to}
                />
              )}
              <NetworkFeeRow
                label={t('bridge.networkFee', { defaultValue: 'Network fee' })}
                prepared={review.prepared}
                choice={review.fee}
                onChoice={(fee) => setReview((r) => (r ? { ...r, fee } : r))}
                chainId={review.prepared.tx.chainId}
                nativeSymbol={chainNetwork(chain).nativeSymbol}
                nativePrice={nativePrice}
                disabled={busy}
              />
              {fees !== null && (
                <Row
                  label={t('anyChain.fees', { defaultValue: 'Route fees' })}
                  value={fmtFeeUsd(fees)}
                />
              )}
            </div>
            <p
              style={{
                margin: '12px 4px 0',
                fontSize: '11.5px',
                lineHeight: 1.5,
                color: 'var(--fg-3)',
              }}
            >
              {review.feeRaised
                ? t('bridge.feeRaised', {
                    defaultValue: 'Network fee went up. Review the new fee.',
                  })
                : review.stage === 'approve'
                  ? t('anyChain.approveNote', {
                      defaultValue:
                        'Approves Relay to spend this amount of {{symbol}}. Bridging is the next step and has its own review.',
                      symbol: token.symbol,
                    })
                  : t('anyChain.depositNote', {
                      defaultValue:
                        'Checked before signing. OCT goes to the Octra address above and refunds come back to your 0x address.',
                    })}
            </p>
          </>
        )}
      </Sheet>
    </div>
  );
};

export default AnyChainPanel;
