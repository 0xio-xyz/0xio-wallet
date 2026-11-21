import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { ChevronDown } from 'src/shared/ui/icons';
import { useWallet } from 'src/contexts/WalletContext';
import { networkService } from 'src/services/network/NetworkService';
import { Sheet, PrimaryButton } from 'src/shared/ui/primitives';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { useReviewScope } from 'src/hooks/transactions/useReviewScope';
import FeeSheet from 'src/features/transactions/components/FeeSheet';
import { feePresets, resolveSendOu } from 'src/features/transactions/sendStage';
import FeeValue from 'src/shared/ui/FeeValue';
import { useLiveFee } from 'src/hooks/wallet/useLiveFee';
import { FEE_UNAVAILABLE, reviewedFeeError } from 'src/utils/octra/dappTx';
import RecipientField from 'src/features/transactions/components/RecipientField';
import { MICRO_OCT } from 'src/features/wallet/nft/xpectrum/config';
import { groupThousands } from 'src/features/wallet/nft/nftData';
import type { Listing } from 'src/features/wallet/nft/xpectrum/market';
import {
  type RunOutcome,
  readListingFresh,
  runApprove,
  runCancel,
  runChangePrice,
  runList,
  runSend,
} from 'src/features/wallet/nft/piece/marketRun';
import {
  cleanAmount,
  fmtMicro,
  fmtOct,
  fmtUsd,
  middleCut,
  splitOct,
} from 'src/features/wallet/nft/piece/format';

export type FlowMode = 'list' | 'change' | 'cancel' | 'send';
type Step = 'price' | 'approve' | 'review' | 'cancel' | 'recipient' | 'sendReview';
type Phase = 'idle' | 'busy' | 'done' | 'pending' | 'failed';

const ouToOct = (ou: string) => (parseInt(ou, 10) || 0) / MICRO_OCT;

interface Props {
  mode: FlowMode;
  contract: string;
  tokenId: string;
  name: string;
  collection: string;
  thumb: React.ReactNode;
  market: string | null;
  listing: Listing | null;
  approved: boolean;
  octUsd: number | null;
  onApproved: () => void;
  onListing: (l: Listing | null | undefined) => void;
  onSent: () => void;
  onClose: () => void;
}

export function NftFlowSheet(props: Props) {
  const { mode, contract, tokenId, name, collection, thumb, market, listing, octUsd } = props;
  const { t } = useTranslation();
  const { activeWallet, networkId } = useWallet();
  const review = useReviewScope();

  const firstStep: Step = mode === 'cancel' ? 'cancel' : mode === 'send' ? 'recipient' : 'price';
  const [step, setStep] = useState<Step>(firstStep);
  const [phase, setPhase] = useState<Phase>('idle');
  const [stage, setStage] = useState(0);
  const [error, setError] = useState('');
  const [note, setNote] = useState('');
  const [price, setPrice] = useState('');
  const [unit, setUnit] = useState<'OCT' | 'USD'>('OCT');
  /** The price fixed in micro-OCT when leaving the price step: the review lists exactly this. */
  const [micro, setMicro] = useState<number | null>(null);
  const [viaApprove, setViaApprove] = useState(false);
  const [to, setTo] = useState('');
  const [customOu, setCustomOu] = useState('');
  const [showOu, setShowOu] = useState(false);
  const callFee = useLiveFee(
    'call',
    networkId,
    step === 'approve' || step === 'review' || step === 'cancel' || step === 'sendReview'
  );
  const liveOu = callFee.quote?.recommended ?? null;
  const ou = resolveSendOu(customOu, liveOu);

  const signs = (s: Step) =>
    s === 'approve' || s === 'review' || s === 'cancel' || s === 'sendReview';
  const goto = (s: Step) => {
    setStep(s);
    setPhase('idle');
    setError('');
    setNote('');
    if (signs(s)) review.bind(activeWallet?.address, networkId);
  };

  // The cancel review is the first thing shown: bind it as it opens.
  useMountEffect(() => {
    if (signs(firstStep)) review.bind(activeWallet?.address, networkId);
  });

  const busy = phase === 'busy';
  const change = mode === 'change';
  const needsApprove = mode === 'list' && !props.approved;
  const callFeeOct = liveOu ? ouToOct(liveOu) : null;

  const typed = parseFloat(price);
  const typedOct =
    Number.isFinite(typed) && typed > 0
      ? unit === 'USD'
        ? octUsd
          ? typed / octUsd
          : NaN
        : typed
      : NaN;
  const typedMicro = Number.isFinite(typedOct) ? Math.round(typedOct * MICRO_OCT) : null;
  const priceOk =
    typedMicro !== null && typedMicro > 0 && !(change && listing && typedMicro === listing.price);

  const swapUnit = (next: 'OCT' | 'USD') => {
    if (next === unit || !octUsd) return;
    if (typed > 0) {
      setPrice(
        next === 'USD'
          ? String(Math.round(typed * octUsd * 100) / 100)
          : String(Math.round((typed / octUsd) * 1e6) / 1e6)
      );
    }
    setUnit(next);
  };

  const fromPrice = () => {
    if (!priceOk || typedMicro === null) return;
    setMicro(typedMicro);
    if (needsApprove) {
      setViaApprove(true);
      goto('approve');
    } else goto('review');
  };

  const signer = () => {
    if (!activeWallet?.privateKey)
      throw new Error(t('nft.walletUnavailable', { defaultValue: 'Wallet not available' }));
    return { from: activeWallet.address, privateKey: activeWallet.privateKey };
  };

  const finish = (out: RunOutcome, after?: () => void) => {
    if (out.status === 'done') {
      setPhase('done');
      after?.();
    } else if (out.status === 'needsApproval') {
      setViaApprove(true);
      goto('approve');
    } else if (out.status === 'pending') {
      setNote(out.message);
      setPhase('pending');
    } else {
      setError(out.error);
      setPhase('failed');
    }
  };

  const confirm = async () => {
    if (busy) return;
    const reviewed = review.take();
    reviewed.catch(() => {});
    setPhase('busy');
    setStage(0);
    setError('');
    let out: RunOutcome;
    try {
      const signOu = step === 'sendReview' ? ou : liveOu;
      if (!signOu) throw new Error(FEE_UNAVAILABLE);
      const scope = await reviewed;
      const feeError = reviewedFeeError(
        BigInt(signOu),
        await networkService.getRecommendedFeeStrict('call', scope)
      );
      if (feeError) throw new Error(feeError);
      const ctx = { ...signer(), scope, ou: signOu };
      const args = { ctx, market: market ?? '', contract, tokenId, t };
      if (step === 'approve') {
        out = await runApprove(args);
        finish(out, props.onApproved);
        return;
      }
      if (step === 'sendReview') {
        out = await runSend({ ctx, networkId, market, contract, tokenId, to: to.trim(), t });
        finish(out);
        return;
      }
      if (!market)
        throw new Error(t('nft.walletUnavailable', { defaultValue: 'Wallet not available' }));
      if (step === 'cancel') {
        if (!listing)
          throw new Error(
            t('nft.notListedAnyMore', { defaultValue: 'This piece is not listed any more.' })
          );
        out = await runCancel({ ...args, listing });
      } else if (change) {
        out = await runChangePrice({ ...args, listing, micro: micro ?? 0, onStage: setStage });
      } else {
        out = await runList({ ...args, micro: micro ?? 0 });
      }
      finish(out);
      props.onListing(await readListingFresh(market, contract, tokenId));
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : t('nft.transferFailed', { defaultValue: 'Transfer failed' })
      );
      setPhase('failed');
    }
  };

  const close = () => {
    if (busy) return;
    if (phase === 'done' && step === 'sendReview') props.onSent();
    else props.onClose();
  };

  const title =
    step === 'approve'
      ? t('nft.approveXpectrum', { defaultValue: 'Approve Xpectrum' })
      : mode === 'change'
        ? t('nft.changePrice', { defaultValue: 'Change price' })
        : mode === 'cancel'
          ? t('nft.cancelListing', { defaultValue: 'Cancel listing' })
          : mode === 'send'
            ? t('nft.transfer', { defaultValue: 'Transfer' })
            : t('nft.listForSale', { defaultValue: 'List for sale' });

  const showBadge =
    mode === 'list' && (step === 'approve' || viaApprove || (step === 'price' && needsApprove));
  const second = step === 'review';
  const badge = showBadge ? (
    <span className="flex! items-center!" style={{ gap: '8px', paddingTop: '3px' }}>
      <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
        {second
          ? t('nft.step2of2', { defaultValue: 'Step 2 of 2' })
          : t('nft.step1of2', { defaultValue: 'Step 1 of 2' })}
      </span>
      <span className="flex! items-center!" style={{ gap: '5px' }}>
        {[true, second].map((on, i) => (
          <i
            key={i}
            style={{
              width: '6px',
              height: '6px',
              borderRadius: '50%',
              background: on ? 'var(--accent)' : 'var(--line-2)',
            }}
          />
        ))}
      </span>
    </span>
  ) : (
    <span />
  );

  const usd = (oct: number) => fmtUsd(oct, octUsd);
  const feeAmount = (oct: number | null, prefix = '') => (
    <FeeValue
      state={callFee.state}
      text={oct === null ? null : amount(oct, prefix)}
      ageMs={callFee.ageMs}
    />
  );
  const amount = (oct: number, prefix = '') => (
    <>
      {prefix}
      {fmtOct(oct)} OCT
      {usd(oct) && <span style={{ color: 'var(--fg-3)', marginLeft: '6px' }}>{usd(oct)}</span>}
    </>
  );

  const stages = change ? 3 : 1;
  const busyLabel =
    step === 'approve'
      ? t('nft.approving', { defaultValue: 'Approving' })
      : step === 'sendReview'
        ? t('nft.transferring', { defaultValue: 'Transferring' })
        : step === 'cancel'
          ? t('nft.takingDown', { defaultValue: 'Delisting' })
          : change
            ? [
                t('nft.takingDown', { defaultValue: 'Delisting' }),
                t('nft.approving', { defaultValue: 'Approving' }),
                t('nft.listingAgain', { defaultValue: 'Listing at the new price' }),
              ][stage]
            : t('nft.listing', { defaultValue: 'Listing' });
  const doneLabel =
    step === 'approve'
      ? t('nft.approved', { defaultValue: 'Approved' })
      : step === 'sendReview'
        ? t('nft.transferred', { defaultValue: 'Transferred' })
        : step === 'cancel'
          ? t('nft.takenDown', { defaultValue: 'Delisted' })
          : change
            ? t('nft.priceChanged', { defaultValue: 'Price changed' })
            : t('nft.listed', { defaultValue: 'Listed' });

  const pill = (
    <div
      role="progressbar"
      aria-label={phase === 'done' ? doneLabel : busyLabel}
      className="relative! overflow-hidden! flex! items-center! justify-center!"
      style={{
        height: '44px',
        borderRadius: '10px',
        background: 'var(--bg-1)',
        fontSize: '13px',
        fontWeight: 600,
        color: 'var(--fg)',
      }}
    >
      {phase === 'done' ? (
        <i
          className="absolute! inset-0!"
          style={{ background: 'color-mix(in oklab, var(--accent) 22%, transparent)' }}
        />
      ) : (
        <i
          key={stage}
          className="nft-fill absolute! inset-0!"
          style={
            {
              background: 'color-mix(in oklab, var(--accent) 22%, transparent)',
              '--nft-fill-from': stage / stages,
              '--nft-fill-to': (stage + 0.9) / stages,
            } as React.CSSProperties
          }
        />
      )}
      <span className="relative!">{phase === 'done' ? doneLabel : busyLabel}</span>
    </div>
  );

  const pair = (left: React.ReactNode, right: React.ReactNode) => (
    <div className="grid! grid-cols-2!" style={{ gap: '10px' }}>
      {left}
      {right}
    </div>
  );

  const footer = (confirmLabel: string, opts: { danger?: boolean; backLabel?: string } = {}) => {
    if (phase === 'busy') return pill;
    if (phase === 'done') {
      return (
        <div className="flex! flex-col!" style={{ gap: '10px' }}>
          {pill}
          {step === 'approve' ? (
            <PrimaryButton onClick={() => goto('review')}>
              {t('common.continue', { defaultValue: 'Continue' })}
            </PrimaryButton>
          ) : (
            <PrimaryButton secondary onClick={close}>
              {t('common.done', { defaultValue: 'Done' })}
            </PrimaryButton>
          )}
        </div>
      );
    }
    if (phase === 'pending') {
      return (
        <PrimaryButton secondary onClick={props.onClose}>
          {t('common.done', { defaultValue: 'Done' })}
        </PrimaryButton>
      );
    }
    if (phase === 'failed') {
      return pair(
        <PrimaryButton secondary onClick={props.onClose}>
          {t('common.close', { defaultValue: 'Close' })}
        </PrimaryButton>,
        <PrimaryButton onClick={() => goto(step)}>
          {t('nft.tryAgain', { defaultValue: 'Try again' })}
        </PrimaryButton>
      );
    }
    const back = () => {
      if (step === 'approve') goto('price');
      else if (step === 'review') goto(viaApprove && !props.approved ? 'approve' : 'price');
      else if (step === 'sendReview') goto('recipient');
      else props.onClose();
    };
    return pair(
      <PrimaryButton secondary onClick={back}>
        {opts.backLabel ?? t('common.back', { defaultValue: 'Back' })}
      </PrimaryButton>,
      <PrimaryButton
        danger={opts.danger}
        disabled={!(step === 'sendReview' ? ou : liveOu)}
        onClick={() => void confirm()}
      >
        {confirmLabel}
      </PrimaryButton>
    );
  };

  const recess = (rows: [string, React.ReactNode][]) => (
    <div style={{ background: 'var(--bg-1)', borderRadius: '14px', padding: '2px 14px' }}>
      {rows.map(([k, v]) => (
        <div
          key={k}
          className="flex! justify-between!"
          style={{
            gap: '14px',
            padding: '11px 0',
            fontSize: '13px',
            borderTop: 'none',
          }}
        >
          <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>{k}</span>
          <span
            className="text-right!"
            style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}
          >
            {v}
          </span>
        </div>
      ))}
    </div>
  );

  const explain = (text: string) => (
    <p style={{ margin: 0, fontSize: '12px', lineHeight: 1.5, color: 'var(--fg-2)' }}>{text}</p>
  );
  const errorLine = (error || note) && (
    <p
      style={{
        margin: 0,
        fontSize: '11px',
        lineHeight: 1.5,
        color: error ? 'var(--neg)' : 'var(--fg-2)',
      }}
    >
      {error || note}
    </p>
  );

  const miniRow = (
    <div className="flex! items-center!" style={{ gap: '12px' }}>
      <span
        className="relative! shrink-0! overflow-hidden! bg-(--bg-1)!"
        style={{ width: '44px', height: '44px', borderRadius: '10px' }}
      >
        {thumb}
      </span>
      <span className="flex! flex-col! min-w-0!" style={{ gap: '2px' }}>
        <span
          className="truncate!"
          style={{ fontSize: '14px', fontWeight: 600, color: 'var(--fg)' }}
        >
          {name}
        </span>
        <span className="truncate!" style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
          {collection}
        </span>
      </span>
    </div>
  );

  let body: React.ReactNode = null;
  let foot: React.ReactNode = null;

  if (step === 'price') {
    const other =
      typed > 0
        ? unit === 'OCT'
          ? usd(typed)
          : Number.isFinite(typedOct)
            ? `${fmtOct(typedOct)} OCT`
            : null
        : null;
    body = (
      <div className="flex! flex-col! items-center!" style={{ gap: '10px', padding: '10px 0' }}>
        <div className="flex! items-baseline! justify-center!" style={{ gap: '8px' }}>
          <input
            aria-label={t('nft.price', { defaultValue: 'Price' })}
            value={groupThousands(price)}
            onChange={(e) => {
              const caret = e.target.selectionStart ?? e.target.value.length;
              let v = e.target.value;
              if ((e.nativeEvent as InputEvent).data === ',' && v[caret - 1] === ',') {
                v = `${v.slice(0, caret - 1)}.${v.slice(caret)}`;
              }
              const next = v.replace(/,/g, '');
              setPrice((prev) => cleanAmount(next, prev));
              setError('');
            }}
            onPaste={(e) => {
              e.preventDefault();
              const pasted = e.clipboardData.getData('text');
              setPrice((prev) => cleanAmount(pasted, prev));
              setError('');
            }}
            placeholder="0"
            inputMode="decimal"
            autoComplete="off"
            autoFocus
            size={Math.max(1, groupThousands(price).length)}
            className="bg-transparent! outline-none! text-right! placeholder:text-content-muted!"
            style={{
              maxWidth: '240px',
              border: 'none',
              padding: 0,
              color: 'var(--fg)',
              fontSize: '40px',
              fontWeight: 700,
              letterSpacing: '-0.02em',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--fg-2)' }}>{unit}</span>
        </div>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)', height: '18px' }}>
          {other ?? ''}
        </span>
        {octUsd && (
          <div
            role="group"
            aria-label={t('nft.currency', { defaultValue: 'Currency' })}
            className="inline-flex!"
            style={{ padding: '3px', gap: '3px', borderRadius: '999px', background: 'var(--bg-1)' }}
          >
            {(['OCT', 'USD'] as const).map((c) => (
              <button
                key={c}
                aria-pressed={unit === c}
                onClick={() => swapUnit(c)}
                className="transition-colors!"
                style={{
                  height: '28px',
                  padding: '0 12px',
                  borderRadius: '999px',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: '12.5px',
                  fontWeight: 600,
                  background: unit === c ? 'var(--bg-2)' : 'transparent',
                  color: unit === c ? 'var(--fg)' : 'var(--fg-2)',
                }}
              >
                {c}
              </button>
            ))}
          </div>
        )}
        <span style={{ fontSize: '12px', color: 'var(--fg-3)', height: '18px' }}>
          {change && listing
            ? t('nft.listedNow', {
                price: fmtMicro(listing.price),
                defaultValue: 'Listed now at {{price}} OCT',
              })
            : ''}
        </span>
      </div>
    );
    foot = (
      <PrimaryButton onClick={fromPrice} disabled={!priceOk}>
        {needsApprove
          ? t('nft.continueToApprove', { defaultValue: 'Continue to approve' })
          : t('nft.review', { defaultValue: 'Review' })}
      </PrimaryButton>
    );
  } else if (step === 'approve') {
    body = (
      <>
        {explain(
          t('nft.approveExplain', {
            defaultValue:
              'Xpectrum can take this piece only when someone buys it at your price. Listing it then hands it to Xpectrum to hold. Cancel any time to get it back.',
          })
        )}
        {recess([
          [
            t('nft.lets', { defaultValue: 'Operator' }),
            t('nft.xpectrumMarket', { defaultValue: 'Xpectrum market' }),
          ],
          [
            t('nft.for', { defaultValue: 'For' }),
            t('nft.thisPieceOnly', { defaultValue: 'This piece only' }),
          ],
          [t('nft.networkFee', { defaultValue: 'Network fee' }), feeAmount(callFeeOct)],
        ])}
      </>
    );
    foot = footer(t('nft.approve', { defaultValue: 'Approve' }));
  } else if (step === 'review') {
    const oct = (micro ?? 0) / MICRO_OCT;
    const [whole, dec] = splitOct(oct);
    body = (
      <>
        <div className="flex! flex-col! items-center!" style={{ gap: '2px', padding: '6px 0' }}>
          <span className="flex! items-baseline!" style={{ gap: '8px' }}>
            <span
              style={{
                fontSize: '40px',
                fontWeight: 700,
                letterSpacing: '-0.02em',
                color: 'var(--fg)',
                fontVariantNumeric: 'tabular-nums',
              }}
            >
              {whole}
              <span style={{ color: 'var(--fg-3)' }}>{dec}</span>
            </span>
            <span style={{ fontSize: '18px', fontWeight: 600, color: 'var(--fg-2)' }}>OCT</span>
          </span>
          {usd(oct) && <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{usd(oct)}</span>}
        </div>
        {recess([
          [t('nft.marketplaceLabel', { defaultValue: 'Marketplace' }), 'Xpectrum'],
          [
            t('nft.whileListed', { defaultValue: 'While listed' }),
            t('nft.xpectrumHolds', { defaultValue: 'Held by Xpectrum' }),
          ],
          change
            ? [
                t('nft.transactions', { defaultValue: 'Transactions' }),
                t('nft.upTo3', { defaultValue: 'Up to 3: delist, approve, relist' }),
              ]
            : [
                t('nft.listingRow', { defaultValue: 'Listing' }),
                t('nft.oneTransaction', { defaultValue: 'One transaction' }),
              ],
          [
            t('nft.networkFee', { defaultValue: 'Network fee' }),
            feeAmount(
              callFeeOct !== null && change ? callFeeOct * 3 : callFeeOct,
              change ? `${t('nft.upTo', { defaultValue: 'Up to' })} ` : ''
            ),
          ],
        ])}
      </>
    );
    foot = footer(
      change
        ? t('nft.changePrice', { defaultValue: 'Change price' })
        : t('nft.list', { defaultValue: 'List' })
    );
  } else if (step === 'cancel') {
    body = (
      <>
        {explain(
          t('nft.cancelExplain', {
            defaultValue: 'Xpectrum hands the piece back to you and the listing comes down.',
          })
        )}
        {recess([
          [
            t('nft.listedAt', { defaultValue: 'Listed at' }),
            listing ? amount(listing.price / MICRO_OCT) : '…',
          ],
          [t('nft.networkFee', { defaultValue: 'Network fee' }), feeAmount(callFeeOct)],
        ])}
      </>
    );
    foot = footer(t('nft.cancelListing', { defaultValue: 'Cancel listing' }), {
      danger: true,
      backLabel: t('nft.keepListed', { defaultValue: 'Keep it listed' }),
    });
  } else if (step === 'recipient') {
    const valid = /^oct[1-9A-HJ-NP-Za-km-z]{44}$/.test(to.trim());
    body = (
      <>
        <RecipientField
          value={to}
          onChange={(v) => {
            setTo(v);
            setError('');
          }}
          ownAddress={activeWallet?.address}
          label={t('nft.to', { defaultValue: 'To' })}
        />
        <button
          onClick={() =>
            callFee.state === 'failed'
              ? callFee.retry()
              : callFee.quote
                ? setShowOu(true)
                : undefined
          }
          className="group! flex! items-center! justify-between! w-full!"
          style={{ background: 'none', border: 'none', padding: '2px 0', cursor: 'pointer' }}
        >
          <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
            {t('nft.networkFee', { defaultValue: 'Network fee' })}
          </span>
          <span
            className="flex! items-center! group-hover:text-(--fg)! transition-colors!"
            style={{
              gap: '4px',
              fontSize: '12px',
              fontWeight: 500,
              color: 'var(--fg-2)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {ou ? (
              <>
                {ou === customOu ? amount(ouToOct(ou)) : feeAmount(ouToOct(ou))}
                {callFee.quote && <ChevronDown size={12} />}
              </>
            ) : (
              <FeeValue state={callFee.state} retry />
            )}
          </span>
        </button>
      </>
    );
    foot = pair(
      <PrimaryButton secondary onClick={props.onClose}>
        {t('common.back', { defaultValue: 'Back' })}
      </PrimaryButton>,
      <PrimaryButton
        disabled={!valid || !ou}
        onClick={() => {
          if (to.trim() === activeWallet?.address)
            setError(
              t('nft.ownAddress', {
                defaultValue: 'Cannot transfer to your own address',
              })
            );
          else goto('sendReview');
        }}
      >
        {t('nft.review', { defaultValue: 'Review' })}
      </PrimaryButton>
    );
  } else {
    body = recess([
      [
        t('nft.to', { defaultValue: 'To' }),
        <span className="font-mono!" key="to" style={{ fontSize: '12px' }}>
          {middleCut(to.trim())}
        </span>,
      ],
      [t('nft.networkFee', { defaultValue: 'Network fee' }), feeAmount(ou ? ouToOct(ou) : null)],
    ]);
    foot = footer(t('nft.transfer', { defaultValue: 'Transfer' }));
  }

  return (
    <>
      <Sheet
        open
        onClose={close}
        dismissible={!busy}
        zIndexClass="z-picker!"
        title={title}
        action={badge}
        onSubmit={step === 'price' ? fromPrice : undefined}
        footer={foot}
      >
        <div className="flex! flex-col!" style={{ gap: '14px', overflow: 'visible' }}>
          {miniRow}
          {body}
          {errorLine}
        </div>
      </Sheet>
      {mode === 'send' && (
        <FeeSheet
          open={showOu}
          value={ou ?? ''}
          presets={feePresets(callFee.quote)}
          defaultOu={liveOu ?? undefined}
          minOu={callFee.quote?.minimum}
          octUsdPrice={octUsd}
          onSave={setCustomOu}
          onClose={() => setShowOu(false)}
        />
      )}
    </>
  );
}
