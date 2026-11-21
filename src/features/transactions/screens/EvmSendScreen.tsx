import { useRef, useState } from 'react';
import { useLocation, useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import type { TFunction } from 'src/i18n/core';
import { ChevronDown } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { useEvmBalances } from 'src/hooks/wallet/useEvmBalances';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';
import { evmRowUsd, useEvmPrices } from 'src/hooks/wallet/useEvmPrices';
import { useRecipientContacts } from 'src/hooks/wallet/useRecipientContacts';
import { llamaKey } from 'src/services/evm/prices';
import Header from 'src/shared/ui/Header';
import SendResult from 'src/features/transactions/components/SendResult';
import {
  ReviewAmount,
  ReviewCard,
  ReviewFooter,
  ReviewNote,
  ReviewRow,
} from 'src/features/transactions/components/ReviewParts';
import { FieldNote, PrimaryButton, Sheet, TextButton, quietField } from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { EvmTokenIcon } from 'src/features/wallet/components/TokenList';
import { middleCut } from 'src/features/wallet/add/format';
import { toChecksumAddress } from 'src/services/evm/accounts';
import type { EvmBalanceRow } from 'src/services/evm/balances';
import { recordSentTokens } from 'src/services/evm/detectedTokens';
import { networkTxUrl } from 'src/services/evm/registry';
import {
  FeeCeilingError,
  estimateFees,
  getNonce,
  prepareTransfer,
  watchTransaction,
} from 'src/services/evm/send';
import { signAndSubmit, type SubmittedTx } from 'src/services/evm/signer';
import { isEvmAddress } from 'src/services/evm/tx';
import {
  endStageOf,
  nonceChanged,
  recipientIssue,
  scopeChanged,
  type EvmEndStage,
  type EvmReviewBinding,
} from 'src/features/transactions/evmSendGuards';
import { cleanAmountInput, fromUnits, toUnits } from 'src/utils/amount';
import FeeFigureText from 'src/features/bridge/components/FeeFigureText';
import { feeFigure } from 'src/features/bridge/bridgeUsd';
import { useNativePrice } from 'src/hooks/wallet/useNativePrice';
import { logger } from 'src/utils/logger';

type Stage = 'form' | 'review' | 'sending' | 'pending' | EvmEndStage;

const keyOf = (r: Pick<EvmBalanceRow, 'chainId' | 'token'>) =>
  `${r.chainId}:${r.token.address?.toLowerCase() ?? 'native'}`;

const trim = (amount: string, places = 6) => {
  const [int, frac = ''] = amount.split('.');
  const cut = frac.slice(0, places).replace(/0+$/, '');
  if (!cut && /[1-9]/.test(frac) && int === '0') return `< 0.${'0'.repeat(places - 1)}1`;
  return cut ? `${int}.${cut}` : int;
};

const addressProblem = (
  value: string,
  tokenAddress: string | null,
  t: TFunction
): string | null => {
  const v = value.trim();
  if (!v) return null;
  if (!isEvmAddress(v)) {
    return t('evmSend.badAddress', {
      defaultValue: 'Invalid address. Enter 0x followed by 40 hex characters.',
    });
  }
  const mixed = v.slice(2) !== v.slice(2).toLowerCase() && v.slice(2) !== v.slice(2).toUpperCase();
  if (mixed && toChecksumAddress(v) !== v) {
    return t('evmSend.badChecksum', {
      defaultValue: 'Invalid address checksum. Check that it was copied correctly.',
    });
  }
  const issue = recipientIssue(v, tokenAddress);
  if (issue === 'zero') {
    return t('evmSend.zeroAddress', {
      defaultValue: 'This is the zero address. Funds sent there are lost.',
    });
  }
  if (issue === 'contract') {
    return t('evmSend.toContract', {
      defaultValue: 'This is the token contract. Tokens sent there are lost.',
    });
  }
  return null;
};

const EvmSendScreen = () => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const location = useLocation();
  const { activeWallet, networkId } = useWallet();
  const { evmOn, evmAddress } = useHomeView();
  const prices = useTokenPrice();
  const balances = useEvmBalances(evmAddress, networkId, evmOn);
  const networks = balances.networks;

  const wanted = (location.state as { token?: string } | null)?.token ?? null;
  const [picked, setPicked] = useState<string | null>(wanted);
  const [picking, setPicking] = useState(false);
  const [contactsOpen, setContactsOpen] = useState(false);
  const { contacts } = useRecipientContacts(contactsOpen, evmAddress ?? undefined, 'evm');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [stage, setStage] = useState<Stage>('form');
  const [reviewed, setReviewed] = useState<EvmReviewBinding | null>(null);
  const nativePrice = useNativePrice(reviewed?.network ?? null);
  const [sent, setSent] = useState<{ bound: EvmReviewBinding; tx: SubmittedTx } | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runRef = useRef(0);
  const maxRunRef = useRef(0);
  const bound = useRef<EvmReviewBinding | null>(null);
  const sendingRef = useRef(false);
  const watchRef = useRef<AbortController | null>(null);

  const rows = balances.rows;
  const row =
    rows.find((r) => keyOf(r) === picked) ??
    rows.find((r) => r.raw !== '0' && r.token.address === null) ??
    rows[0] ??
    null;
  const network = row ? (networks.find((n) => n.chainId === row.chainId) ?? null) : null;
  const decimals = row?.token.decimals ?? 18;
  const ethPrice = prices.getPrice('ETH') || 0;
  const rowKey = row ? llamaKey(row.chainId, row.token) : null;
  const llama = useEvmPrices(rowKey ? [rowKey] : []);
  const usdOf = (n: number, r: EvmBalanceRow | null) =>
    r ? evmRowUsd(r, n, rowKey ? llama[rowKey] : undefined, ethPrice) : null;
  const fmtUsd = (n: number | null) =>
    n === null
      ? ''
      : `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

  const toProblem = addressProblem(to, row?.token.address ?? null, t);
  let units = 0n;
  try {
    units = amount ? toUnits(amount, decimals) : 0n;
  } catch {
    units = 0n;
  }
  const balanceUnits = row ? BigInt(row.raw || '0') : 0n;
  const over = units > balanceUnits;
  const ready =
    !!row && !!network && isEvmAddress(to.trim()) && !toProblem && units > 0n && !over && !busy;

  const feeProblem = (e: unknown) =>
    e instanceof FeeCeilingError
      ? t('evmSend.feeTooHigh', {
          defaultValue: 'The network fee is abnormally high. Check the RPC in Settings.',
        })
      : null;

  const setMax = async () => {
    if (!row || !network) return;
    const run = ++maxRunRef.current;
    if (row.token.address !== null) {
      setAmount(fromUnits(balanceUnits, decimals));
      return;
    }
    try {
      const fees = await estimateFees(network);
      if (run !== maxRunRef.current) return;
      const reserve = (21_000n * fees.maxFeePerGas * 12n) / 10n;
      setAmount(balanceUnits > reserve ? fromUnits(balanceUnits - reserve, decimals) : '0');
    } catch (e) {
      if (run !== maxRunRef.current) return;
      setProblem(
        feeProblem(e) ??
          t('evmSend.feeFailed', { defaultValue: 'Network fee unavailable. Try again.' })
      );
    }
  };

  const review = async () => {
    if (!ready || !row || !network || !evmAddress || !activeWallet) return;
    const run = ++runRef.current;
    maxRunRef.current++;
    setBusy(true);
    setProblem(null);
    try {
      const p = await prepareTransfer({
        network,
        from: evmAddress,
        to: to.trim(),
        token: row.token,
        amount: units,
      });
      if (run !== runRef.current) return;
      const native = rows.find((r) => r.chainId === row.chainId && r.token.address === null);
      const nativeBalance = native ? BigInt(native.raw || '0') : 0n;
      if (p.totalNative > nativeBalance) {
        setProblem(
          t('evmSend.noGas', {
            defaultValue: 'Insufficient {{symbol}} on {{chain}} for network fee',
            symbol: network.nativeSymbol,
            chain: network.name,
          })
        );
        return;
      }
      const usdNow = usdOf(parseFloat(amount) || 0, row);
      const binding: EvmReviewBinding = {
        walletId: activeWallet.id,
        evmIndex: activeWallet.metadata?.evm?.index ?? 0,
        from: evmAddress,
        chainId: network.chainId,
        rpcUrl: network.rpcUrl,
        to: to.trim(),
        amount: units,
        amountText: amount,
        tokenKey: keyOf(row),
        token: row.token,
        network,
        prepared: p,
        usd: usdNow !== null ? fmtUsd(usdNow) : null,
      };
      bound.current = binding;
      setReviewed(binding);
      setStage('review');
    } catch (e) {
      logger.warn('[EvmSend] prepare failed', e);
      if (run !== runRef.current) return;
      setProblem(
        feeProblem(e) ??
          t('evmSend.prepareFailed', {
            defaultValue: 'Could not prepare this transfer. Check the address and amount.',
          })
      );
    } finally {
      if (run === runRef.current) setBusy(false);
    }
  };

  const backToForm = (message: string) => {
    bound.current = null;
    setReviewed(null);
    setProblem(message);
    setStage('form');
  };

  const send = async () => {
    const b = bound.current;
    if (!b || sendingRef.current) return;
    if (
      scopeChanged(b, {
        walletId: activeWallet?.id ?? null,
        evmIndex: activeWallet?.metadata?.evm?.index ?? 0,
        from: evmAddress,
        chainId: network?.chainId ?? null,
        rpcUrl: network?.rpcUrl ?? null,
        to,
        amount: units,
        tokenKey: row ? keyOf(row) : null,
      })
    ) {
      backToForm(
        t('evmSend.scopeChanged', { defaultValue: 'The wallet or network changed. Review again.' })
      );
      return;
    }
    sendingRef.current = true;
    setStage('sending');
    let submitted: SubmittedTx;
    try {
      const pendingNonce = await getNonce(b.network, b.from);
      if (nonceChanged(b, pendingNonce)) {
        backToForm(
          t('evmSend.nonceChanged', {
            defaultValue: 'Another transaction was sent from this address. Review again.',
          })
        );
        return;
      }
      submitted = await signAndSubmit(b.network, b.prepared.tx, {
        id: b.walletId,
        evmIndex: b.evmIndex,
        evmAddress: b.from,
      });
    } catch (e) {
      logger.warn('[EvmSend] send failed', e);
      backToForm(
        e instanceof Error && /locked/i.test(e.message)
          ? t('evmSend.locked', { defaultValue: 'Unlock 0xio and try again.' })
          : t('evmSend.sendFailed', { defaultValue: 'Transfer not sent. Try again.' })
      );
      return;
    } finally {
      sendingRef.current = false;
    }
    bound.current = null;
    setSent({ bound: b, tx: submitted });
    const { to: contract, data } = b.prepared.tx;
    if (contract && data !== '0x') void recordSentTokens(b.chainId, b.from, [contract]);
    setStage('pending');
    const watch = new AbortController();
    watchRef.current = watch;
    let end: EvmEndStage = 'stuck';
    try {
      const result = await watchTransaction(
        b.network,
        {
          hash: submitted.hash,
          nonce: submitted.nonce,
          from: b.from,
          ...(submitted.acknowledged ? {} : { raw: submitted.raw }),
        },
        { signal: watch.signal }
      );
      end = endStageOf(result.state);
    } catch (e) {
      if (watch.signal.aborted) return;
      logger.warn('[EvmSend] watching the transfer failed', e);
    }
    setStage(end);
    balances.refresh();
  };

  if (sent && stage !== 'form' && stage !== 'review' && stage !== 'sending') {
    const { bound: b, tx } = sent;
    const link = networkTxUrl(b.network, tx.hash);
    const title =
      stage === 'pending'
        ? t('evmSend.pending', { defaultValue: 'Sending' })
        : stage === 'done'
          ? t('evmSend.sent', { defaultValue: 'Sent' })
          : stage === 'failed'
            ? t('evmSend.failed', { defaultValue: 'Failed' })
            : stage === 'replaced'
              ? t('evmSend.replaced', { defaultValue: 'Replaced or dropped' })
              : t('evmSend.stuck', { defaultValue: 'Pending' });
    const note =
      stage === 'replaced'
        ? t('evmSend.replacedNote', {
            defaultValue:
              'Another transaction from this address took its place, or the network dropped it. Check your balance before sending again.',
          })
        : stage === 'stuck'
          ? t('evmSend.stuckNote', {
              defaultValue:
                'Not confirmed yet. It may still confirm. Check the explorer before sending again.',
            })
          : stage === 'pending' && !tx.acknowledged
            ? t('evmSend.noReply', {
                defaultValue: 'Network timeout. Tracking the transaction on chain.',
              })
            : undefined;
    return (
      <SendResult
        mood={stage === 'pending' ? 'loading' : 'awake'}
        title={title}
        line={
          <>
            {trim(b.amountText)} {b.token.symbol} {t('evmSend.toShort', { defaultValue: 'to' })}{' '}
            {middleCut(b.to, 6, 4)}
          </>
        }
        note={note}
        link={link}
        onDone={() => {
          watchRef.current?.abort();
          navigate('/', { replace: true });
        }}
      />
    );
  }

  if (!evmOn || !evmAddress) {
    return (
      <div className="flex! h-full! flex-col! bg-(--bg)!">
        <Header title={t('action.send')} showBack showSettings={false} />
        <div style={{ padding: '24px var(--gutter)', fontSize: '13px', color: 'var(--fg-2)' }}>
          {t('evmSend.evmOff', {
            defaultValue: 'Turn on EVM for this wallet in Settings to send on EVM networks.',
          })}
        </div>
      </div>
    );
  }

  const usd = usdOf(parseFloat(amount) || 0, row);

  return (
    <div className="flex! h-full! flex-col! bg-(--bg)!">
      <Header
        title={t('evmSend.title', { defaultValue: 'Send on EVM' })}
        showBack
        showSettings={false}
      />
      <div
        className="flex-1! overflow-y-auto! scrollbar-hide!"
        style={{ padding: '8px var(--gutter) 16px' }}
      >
        <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
          {t('evmSend.asset', { defaultValue: 'Asset' })}
        </span>
        <button
          type="button"
          onClick={() => setPicking(true)}
          disabled={rows.length === 0}
          className="press flex! w-full! items-center! bg-(--bg-1)! hover:bg-(--bg-2)!"
          style={{
            marginTop: '8px',
            gap: '12px',
            padding: '12px 14px',
            borderRadius: '18px',
            border: 'none',
            boxShadow: 'var(--raise-shadow)',
            cursor: 'pointer',
            textAlign: 'left',
          }}
        >
          {row ? (
            <>
              <EvmTokenIcon row={row} size={32} />
              <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
                <span style={{ fontSize: '14px', color: 'var(--fg)' }}>{row.token.symbol}</span>
                <span style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>{row.chainName}</span>
              </span>
              <span className="flex! flex-col! items-end!" style={{ gap: '3px' }}>
                <span
                  style={{
                    fontSize: '13px',
                    color: 'var(--fg)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {trim(row.amount)}
                </span>
                <span style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
                  {t('evmSend.available', { defaultValue: 'available' })}
                </span>
              </span>
              <ChevronDown size={15} style={{ color: 'var(--fg-3)' }} />
            </>
          ) : (
            <span style={{ fontSize: '13px', color: 'var(--fg-3)', padding: '6px 0' }}>
              {balances.loading
                ? t('evmSend.loading', { defaultValue: 'Loading balances' })
                : t('evmSend.noAssets', { defaultValue: 'No EVM balances yet' })}
            </span>
          )}
        </button>

        <div style={{ marginTop: '22px' }}>
          <div className="flex! items-center! justify-between!">
            <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
              {t('evmSend.to', { defaultValue: 'To' })}
            </span>
            <TextButton onClick={() => setContactsOpen(true)} size={12}>
              {t('evmSend.contacts', { defaultValue: 'Contacts' })}
            </TextButton>
          </div>
          <input
            value={to}
            onChange={(e) => setTo(e.target.value.slice(0, 64))}
            placeholder={t('evmSend.toPlaceholder', { defaultValue: '0x address' })}
            aria-label={t('evmSend.to', { defaultValue: 'To' })}
            spellCheck={false}
            autoComplete="off"
            className={`${quietField} ${toProblem ? 'border-(--neg)!' : ''}`}
            style={{
              marginTop: '8px',
              height: '48px',
              borderRadius: '16px',
              fontFamily: 'var(--font-mono)',
              fontSize: '12.5px',
            }}
          />
          <FieldNote tone="neg">{toProblem ?? ''}</FieldNote>
        </div>

        <div style={{ marginTop: '10px' }}>
          <div className="flex! items-center! justify-between!">
            <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
              {t('evmSend.amount', { defaultValue: 'Amount' })}
            </span>
            <TextButton onClick={() => void setMax()} size={12}>
              {t('evmSend.max', { defaultValue: 'Max' })}
            </TextButton>
          </div>
          <div
            className="flex! items-baseline! bg-(--bg-1)!"
            style={{ marginTop: '8px', padding: '14px 16px', borderRadius: '18px', gap: '8px' }}
          >
            <input
              value={amount}
              onChange={(e) => {
                const next = cleanAmountInput(e.target.value, Math.min(decimals, 18), 15);
                if (next === null) return;
                maxRunRef.current++;
                setAmount(next);
              }}
              inputMode="decimal"
              placeholder="0"
              aria-label={t('evmSend.amount', { defaultValue: 'Amount' })}
              className="outline-none!"
              style={{
                flex: 1,
                minWidth: 0,
                border: 'none',
                background: 'transparent',
                color: 'var(--fg)',
                fontSize: '30px',
                fontWeight: 300,
                letterSpacing: '-0.03em',
                fontVariantNumeric: 'tabular-nums',
              }}
            />
            <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>{row?.token.symbol}</span>
          </div>
          <FieldNote tone={over ? 'neg' : 'muted'}>
            {over
              ? t('evmSend.overBalance', { defaultValue: 'Insufficient balance' })
              : usd !== null && amount
                ? fmtUsd(usd)
                : ''}
          </FieldNote>
        </div>
      </div>

      <div style={{ padding: '0 var(--gutter) 20px' }}>
        <FieldNote tone="neg">{problem ?? ''}</FieldNote>
        <PrimaryButton
          onClick={() => void review()}
          disabled={!ready}
          loading={busy}
          style={BIG_BUTTON}
        >
          {t('evmSend.review', { defaultValue: 'Review' })}
        </PrimaryButton>
      </div>

      <Sheet
        open={contactsOpen}
        onClose={() => setContactsOpen(false)}
        title={t('evmSend.contactsTitle', { defaultValue: 'Send to' })}
      >
        {contacts.length === 0 ? (
          <p
            style={{
              margin: '4px 4px 8px',
              fontSize: '12.5px',
              lineHeight: 1.5,
              color: 'var(--fg-3)',
            }}
          >
            {t('evmSend.noContacts', {
              defaultValue: 'No 0x contacts yet. Add them to the address book in Settings.',
            })}
          </p>
        ) : (
          contacts.map((c) => (
            <button
              key={c.id}
              type="button"
              onClick={() => {
                setTo(c.address);
                setContactsOpen(false);
              }}
              className="press flex! w-full! flex-col! items-start! rounded-[14px]! hover:bg-(--bg-2)!"
              style={{
                gap: '3px',
                padding: '10px 12px',
                border: 'none',
                background: 'transparent',
                cursor: 'pointer',
                textAlign: 'left',
              }}
            >
              <span style={{ fontSize: '13.5px', color: 'var(--fg)' }}>{c.name}</span>
              <span
                style={{ fontSize: '11.5px', color: 'var(--fg-3)', fontFamily: 'var(--font-mono)' }}
              >
                {middleCut(c.address, 8, 6)}
              </span>
            </button>
          ))
        )}
      </Sheet>

      <Sheet
        open={picking}
        onClose={() => setPicking(false)}
        title={t('evmSend.pickAsset', { defaultValue: 'Select asset' })}
      >
        {rows.map((r) => (
          <button
            key={keyOf(r)}
            type="button"
            onClick={() => {
              maxRunRef.current++;
              setPicked(keyOf(r));
              setAmount('');
              setPicking(false);
            }}
            className={`press flex! w-full! items-center! rounded-[14px]! hover:bg-(--bg-2)! ${
              row && keyOf(r) === keyOf(row) ? 'bg-(--bg-2)!' : ''
            }`}
            style={{
              gap: '12px',
              padding: '10px',
              border: 'none',
              background: undefined,
              cursor: 'pointer',
              textAlign: 'left',
            }}
          >
            <EvmTokenIcon row={r} size={30} />
            <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
              <span style={{ fontSize: '14px', color: 'var(--fg)' }}>{r.token.symbol}</span>
              <span style={{ fontSize: '11.5px', color: 'var(--fg-3)' }}>{r.chainName}</span>
            </span>
            <span
              style={{ fontSize: '13px', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}
            >
              {trim(r.amount)}
            </span>
          </button>
        ))}
      </Sheet>

      <Sheet
        open={stage === 'review' || stage === 'sending'}
        onClose={() => setStage('form')}
        dismissible={stage === 'review'}
        title={t('evmSend.reviewTitle', { defaultValue: 'Review send' })}
        footer={
          <ReviewFooter
            onBack={() => setStage('form')}
            onSend={() => void send()}
            sending={stage === 'sending'}
          />
        }
      >
        {reviewed && (
          <>
            <ReviewAmount
              amount={trim(reviewed.amountText)}
              symbol={reviewed.token.symbol}
              usd={reviewed.usd}
            />
            <ReviewCard>
              <ReviewRow label={t('evmSend.to', { defaultValue: 'To' })} value={reviewed.to} />
              <ReviewRow
                label={t('evmSend.network', { defaultValue: 'Network' })}
                value={reviewed.network.name}
              />
              <ReviewRow
                label={t('evmSend.networkFee', { defaultValue: 'Network fee' })}
                value={
                  <FeeFigureText
                    fee={feeFigure(
                      reviewed.prepared.feeWei,
                      18,
                      `${trim(fromUnits(reviewed.prepared.feeWei, 18), 8)} ${reviewed.network.nativeSymbol}`,
                      nativePrice
                    )}
                  />
                }
              />
              {reviewed.token.address === null && (
                <ReviewRow
                  label={t('evmSend.total', { defaultValue: 'Max total' })}
                  value={
                    <FeeFigureText
                      fee={feeFigure(
                        reviewed.prepared.totalNative,
                        18,
                        `${trim(fromUnits(reviewed.prepared.totalNative, 18), 8)} ${reviewed.network.nativeSymbol}`,
                        nativePrice
                      )}
                    />
                  }
                />
              )}
            </ReviewCard>
            <ReviewNote>
              {t('evmSend.reviewNote', {
                defaultValue:
                  'EVM transfers are public and irreversible. The final fee is usually below the max fee.',
              })}
            </ReviewNote>
          </>
        )}
      </Sheet>
    </div>
  );
};

export default EvmSendScreen;
