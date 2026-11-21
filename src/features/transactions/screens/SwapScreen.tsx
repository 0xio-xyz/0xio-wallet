import React, { useState, useRef, useEffect } from 'react';
import { useNavigate } from 'src/lib/router';
import { ArrowDown, Info } from 'src/shared/ui/icons';
import Header from 'src/shared/ui/Header';
import ConfirmActionButton from 'src/shared/ui/ConfirmActionButton';
import { useWallet } from 'src/contexts/WalletContext';
import { networkCapabilities } from 'src/utils/network';
import { getChains, getPrice } from '../swap/solverApi';
import { useSwapQuote } from '../swap/useSwapQuote';
import { lockOctToEth, pollSwapStatus } from '../swap/swapLock';
import type { ChainsConfig, SwapDirection } from '../swap/types';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { QuoteFreshnessRing } from '../components/QuoteFreshnessRing';
import { SwapProgressStepper } from '../components/SwapProgressStepper';
import { cleanAmountInput, fromUnits } from 'src/utils/amount';
import { useLiveFee } from 'src/hooks/wallet/useLiveFee';
import FeeValue from 'src/shared/ui/FeeValue';
import i18n from 'src/i18n/core';

type Step = 'idle' | 'locking' | 'polling' | 'complete' | 'error';
const SLIPPAGE_OPTIONS = ['0.1', '0.5', '1.0'];
const MIN_OCT = 1;
const isValidEth = (a: string) => /^0x[0-9a-fA-F]{40}$/.test(a.trim());

const CARD = 'bg-(--bg-card)! border! border-(--border-color)! rounded-xl! p-3!';
const LABEL = 'text-[10px]! font-semibold! text-content-muted! uppercase! tracking-wide!';
const BTN_SHELL =
  'w-full! h-11! rounded-xl! border! flex! items-center! justify-center! gap-2! font-semibold! text-[13px]! transition-colors! cursor-pointer!';

const fmtRate = (r: number | string): string => {
  const n = typeof r === 'number' ? r : parseFloat(r);
  return Number.isFinite(n) && n > 0 ? parseFloat(n.toPrecision(4)).toString() : String(r);
};

const SwapScreen = () => {
  const navigate = useNavigate();
  const { activeWallet, balance, networkId } = useWallet();
  const isDevnet = networkCapabilities(networkId).swap;
  const balanceNum = parseFloat(balance || '0');

  const [direction, setDirection] = useState<SwapDirection>('oct_to_eth');
  const [amount, setAmount] = useState('');
  const [slippage, setSlippage] = useState('0.5');
  const [destEth, setDestEth] = useState('');
  const [chains, setChains] = useState<ChainsConfig | null>(null);
  const [octUsd, setOctUsd] = useState<number | null>(null);
  const [step, setStep] = useState<Step>('idle');
  const [failStage, setFailStage] = useState<0 | 1 | null>(null);
  const [swapStatus, setSwapStatus] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [txHash, setTxHash] = useState<string | null>(null);
  const [switchingNet, setSwitchingNet] = useState(false);
  const stoppedRef = useRef(false);

  const from = direction === 'oct_to_eth' ? 'OCT' : 'ETH';
  const to = direction === 'oct_to_eth' ? 'ETH' : 'OCT';
  const { quote, loading: quoteLoading, refreshNonce } = useSwapQuote(from, to, amount);

  useMountEffect(() => {
    getChains()
      .then((c) => setChains(c))
      .catch(() => {});
    getPrice()
      .then((p) => setOctUsd(p?.OCT?.usd ?? null))
      .catch(() => {});
  });

  // effect:audited - stop the solver poll loop if the screen unmounts mid-swap.
  useEffect(
    () => () => {
      stoppedRef.current = true;
    },
    []
  );

  const maxSwap = chains?.solver?.max_swap_oct ?? 10000;
  const vault = chains?.solver?.vault;
  const receive = quote?.receive ?? null;
  const amt = parseFloat(amount);
  const liquidityShort = quote?.liquidity?.sufficient === false;
  const quoteOk = !!quote?.intent_hash && !quote?.error && !liquidityShort;

  const lockFee = useLiveFee('call', networkId);
  const lockOu = lockFee.quote?.recommended ?? null;
  const lockFeeOct = lockOu ? Number(fromUnits(lockOu, 6)) : null;

  const canSwap =
    isDevnet &&
    direction === 'oct_to_eth' &&
    Number.isFinite(amt) &&
    amt >= MIN_OCT &&
    lockFeeOct !== null &&
    amt + lockFeeOct <= balanceNum &&
    amt <= maxSwap &&
    isValidEth(destEth) &&
    quoteOk &&
    !!vault;

  let swapButtonLabel = 'Swap';
  if (!amount) swapButtonLabel = 'Enter an amount';
  else if (amt < MIN_OCT) swapButtonLabel = `Min ${MIN_OCT} OCT`;
  else if (amt > balanceNum) swapButtonLabel = 'Insufficient balance';
  else if (amt > maxSwap) swapButtonLabel = `Max ${maxSwap.toLocaleString()} OCT`;
  else if (!isValidEth(destEth)) swapButtonLabel = 'Enter ETH receiving address';
  else if (quoteLoading) swapButtonLabel = 'Fetching quote…';
  else if (liquidityShort) swapButtonLabel = 'Insufficient liquidity';
  else if (!vault) swapButtonLabel = 'Solver unavailable';
  else if (!quoteOk) swapButtonLabel = 'Quote unavailable';
  else if (lockFee.state === 'failed')
    swapButtonLabel = i18n.t('send.feeUnavailable', {
      defaultValue: 'Network fee unavailable. Try again.',
    });
  else if (lockFeeOct !== null && amt + lockFeeOct > balanceNum)
    swapButtonLabel = i18n.t('send.feeShort', { defaultValue: 'Insufficient OCT for network fee' });

  const handleMax = () => {
    if (lockFeeOct === null) return;
    const maxOct = Math.max(0, balanceNum - lockFeeOct);
    setAmount(maxOct > 0 ? (cleanAmountInput(String(maxOct), 6, 30) ?? '0') : '0');
  };

  const handleSwitchToDevnet = async () => {
    if (isDevnet || switchingNet) return;
    setSwitchingNet(true);
    setError('');
    try {
      await chrome.storage.local.set({ '0xio_current_network': 'devnet' });
    } finally {
      setSwitchingNet(false);
    }
  };

  const runPoll = async () => {
    setStep('polling');
    const settled = await pollSwapStatus(
      quote!.intent_hash!,
      (st) => setSwapStatus(`Solver: ${st}`),
      () => stoppedRef.current
    );
    if (settled) {
      setStep('complete');
    } else {
      setFailStage(1);
      setStep('error');
      setError('Solver timeout. Check History later.');
    }
  };

  const handleSwap = async () => {
    if (!quote || !isDevnet || direction !== 'oct_to_eth') return;
    if (!vault) {
      setError('Solver unavailable. Try again later.');
      return;
    }
    if (!activeWallet?.privateKey) {
      setError(i18n.t('toast.watchOnly'));
      return;
    }
    if (!lockOu) return;
    if (!(await lockFee.fresh())) {
      setError(
        i18n.t('send.feeUnavailable', { defaultValue: 'Network fee unavailable. Try again.' })
      );
      return;
    }
    setError('');
    setFailStage(null);
    stoppedRef.current = false;
    setStep('locking');
    setSwapStatus('Locking OCT');
    try {
      const hash = await lockOctToEth({
        vault,
        quote,
        amount,
        destEthAddress: destEth.trim(),
        slippagePct: parseFloat(slippage),
        from: activeWallet.address,
        privateKey: activeWallet.privateKey,
        publicKey: activeWallet.publicKey ?? undefined,
        networkId,
        ou: lockOu,
      });
      setTxHash(hash);
      setSwapStatus('Locked. Waiting for the solver to fill.');
      await runPoll();
    } catch (e) {
      setFailStage(0);
      setStep('error');
      setError(e instanceof Error ? e.message : 'Swap failed');
    }
  };

  const reset = () => {
    setStep('idle');
    setFailStage(null);
    setSwapStatus(null);
    setError('');
    setTxHash(null);
    setAmount('');
  };

  const explorerUrl = txHash
    ? `https://${isDevnet ? 'devnet.' : ''}octrascan.io/tx.html?hash=${txHash}`
    : '';

  if (step !== 'idle') {
    return (
      <div className="w-full! h-full! flex! flex-col! bg-(--bg-main)! text-(--text-main)!">
        <Header title="Swap" showBack={true} />
        <div className="flex-1! flex! flex-col! items-center! justify-center! py-6! px-(--gutter)! gap-4!">
          <SwapProgressStepper
            step={step === 'complete' ? 'complete' : step === 'polling' ? 'polling' : 'locking'}
            failStage={step === 'error' ? failStage : null}
            direction={direction}
          />
          <div className="text-base! font-bold! mt-2!">
            {step === 'complete' ? 'Swap complete' : step === 'error' ? 'Swap failed' : 'Swapping'}
          </div>
          {step === 'locking' || step === 'polling' ? (
            <div className="text-xs! text-content-muted! text-center!">
              Cross-chain settlement usually takes 2 to 5 minutes
            </div>
          ) : null}
          {swapStatus ? (
            <div className="text-xs! text-content-secondary! text-center!">{swapStatus}</div>
          ) : null}
          {error ? <div className="text-xs! text-(--error)! text-center!">{error}</div> : null}
          {explorerUrl ? (
            <button
              onClick={() => window.open(explorerUrl, '_blank', 'noopener')}
              className="text-xs! text-(--octra)! flex! items-center! gap-1! cursor-pointer!"
            >
              View lock transaction on Octrascan
            </button>
          ) : null}
          {step === 'complete' || step === 'error' ? (
            <button
              onClick={reset}
              className={`${BTN_SHELL} mt-4! bg-(--primary)! border-(--primary)! hover:bg-(--primary-hover)! text-(--primary-fg)!`}
            >
              New swap
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="w-full! h-full! flex! flex-col! bg-(--bg-main)! text-(--text-main)! relative! overflow-hidden!">
      <Header title="Swap" showBack={true} />

      <div className="flex-1! overflow-y-auto! scrollbar-hide! pt-3! pb-24! px-(--gutter)! flex! flex-col! gap-2!">
        <div className="flex! items-center! justify-between!">
          <span className="text-[10px]! text-content-muted! uppercase! tracking-wide!">
            Octra → Sepolia testnet
          </span>
          <button
            onClick={() => navigate('/history')}
            className="text-[11px]! text-content-muted! hover:text-(--text-main)! transition-colors!"
          >
            History
          </button>
        </div>

        {!isDevnet ? (
          <div className="flex! items-start! gap-2! p-2.5! rounded-lg! bg-(--warning)/10! border! border-(--warning)/30!">
            <Info size={13} className="text-(--warning)! shrink-0! mt-0.5!" />
            <span className="text-[11px]! text-(--warning)! leading-snug!">
              Swap runs on Devnet ↔ Sepolia testnet. Switch to Devnet to swap.
            </span>
          </div>
        ) : null}

        {direction === 'eth_to_oct' ? (
          <div className="flex! flex-col! items-center! justify-center! text-center! gap-2! py-8!">
            <div className="font-semibold! text-[13px]!">ETH → OCT is coming next</div>
            <div className="text-[11px]! text-content-muted! leading-relaxed! max-w-60!">
              Needs an EVM wallet connection - lands in a follow-up. OCT → ETH is live now.
            </div>
            <button
              onClick={() => setDirection('oct_to_eth')}
              className="mt-1! px-3! py-1.5! rounded-lg! text-[11px]! font-semibold! bg-(--bg-input)! border! border-(--border-color)! hover:border-(--primary)! transition-all!"
            >
              Switch to OCT → ETH
            </button>
          </div>
        ) : (
          <>
            <div className={CARD}>
              <div className="flex! justify-between! items-center!">
                <span className={LABEL}>From</span>
                <div className="flex! items-center! gap-2!">
                  <span className="text-[11px]! text-content-muted! font-mono!">
                    {balanceNum.toFixed(4)}
                  </span>
                  <button
                    onClick={handleMax}
                    disabled={lockFeeOct === null}
                    className="text-[10px]! font-bold! text-(--octra)! uppercase! hover:opacity-70! transition-opacity! disabled:opacity-40! disabled:cursor-not-allowed!"
                  >
                    Max
                  </button>
                </div>
              </div>
              <div className="flex! items-baseline! gap-2! mt-1.5!">
                <input
                  type="text"
                  inputMode="decimal"
                  value={amount}
                  onChange={(e) => {
                    const v = cleanAmountInput(e.target.value, 6);
                    if (v !== null) setAmount(v);
                  }}
                  placeholder="0.0"
                  className="flex-1! min-w-0! bg-transparent! text-xl! font-semibold! text-(--text-main)! outline-none! placeholder:text-content-muted/30! [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                />
                <span className="text-[13px]! font-semibold! text-content-muted! shrink-0!">
                  OCT
                </span>
              </div>
            </div>

            <div className="relative! h-0.5! flex! items-center! justify-center! z-raised!">
              <button
                onClick={() => {
                  setDirection('eth_to_oct');
                  setAmount('');
                }}
                className="w-7! h-7! rounded-lg! bg-(--bg-main)! border! border-(--border-color)! flex! items-center! justify-center! text-content-muted! hover:text-(--primary)! hover:border-(--primary)! transition-colors! cursor-pointer!"
                title="Swap direction"
              >
                <ArrowDown size={14} />
              </button>
            </div>

            <div className={CARD}>
              <div className="flex! justify-between! items-center!">
                <span className={LABEL}>To</span>
                {quoteOk && amount ? (
                  <span className="flex! items-center! gap-1.5! text-[10px]! text-content-muted!">
                    <QuoteFreshnessRing key={refreshNonce} /> Live
                  </span>
                ) : null}
              </div>
              <div className="flex! items-baseline! gap-2! mt-1.5!">
                <span className="flex-1! min-w-0! text-xl! font-semibold! text-(--text-main)! truncate!">
                  {quoteLoading
                    ? '…'
                    : receive != null
                      ? receive.toFixed(6).replace(/\.?0+$/, '')
                      : '0.0'}
                </span>
                <span className="text-[13px]! font-semibold! text-content-muted! shrink-0!">
                  ETH
                </span>
              </div>
              {receive != null && octUsd != null && Number.isFinite(amt) ? (
                <div className="text-[11px]! text-content-muted! mt-0.5!">
                  ≈ ${(amt * octUsd).toFixed(2)}
                </div>
              ) : null}
            </div>

            <label className={`${LABEL} mt-2!`}>ETH receiving address (Sepolia)</label>
            <input
              value={destEth}
              onChange={(e) => setDestEth(e.target.value)}
              placeholder="0x…"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              className={`w-full! bg-(--bg-card)! border! rounded-lg! px-3! py-2.5! text-[12px]! font-mono! text-(--text-main)! outline-none! ${
                destEth && !isValidEth(destEth) ? 'border-(--error)!' : 'border-(--border-color)!'
              }`}
            />

            <div className="flex! items-center! justify-between! mt-2!">
              <span className={LABEL}>Slippage</span>
              <div className="flex! gap-1.5!">
                {SLIPPAGE_OPTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => setSlippage(s)}
                    className={`px-2.5! py-1! rounded-md! text-[11px]! font-semibold! border! transition-colors! ${
                      slippage === s
                        ? 'bg-(--primary)! text-(--primary-fg)! border-(--primary)!'
                        : 'bg-(--bg-input)! border-(--border-color)! text-content-muted!'
                    }`}
                  >
                    {s}%
                  </button>
                ))}
              </div>
            </div>

            {quote && !quote.error ? (
              <div className="mt-2! p-2.5! border! border-(--border-color)! rounded-lg! bg-(--bg-card)/50! space-y-1.5!">
                <Row label="Rate" value={quote.rate ? `1 OCT ≈ ${fmtRate(quote.rate)} ETH` : '-'} />
                <Row
                  label="Solver fee"
                  value={quote.fee_pct != null ? `${(quote.fee_pct * 100).toFixed(2)}%` : '-'}
                />
                <Row
                  label={i18n.t('send.networkFee', { defaultValue: 'Network fee' })}
                  value={
                    <FeeValue
                      state={lockFee.state}
                      text={lockOu ? `${fromUnits(lockOu, 6)} OCT` : null}
                      ageMs={lockFee.ageMs}
                    />
                  }
                />
                <Row
                  label="Minimum received"
                  value={
                    receive != null
                      ? `${(receive * (1 - parseFloat(slippage) / 100)).toFixed(6).replace(/\.?0+$/, '')} ETH`
                      : '-'
                  }
                />
              </div>
            ) : null}

            {quote?.error ? (
              <div className="text-[11px]! text-(--error)! mt-1.5!">{quote.error}</div>
            ) : null}
            {liquidityShort ? (
              <div className="text-[11px]! text-(--error)! mt-1.5!">
                Insufficient solver liquidity for this amount.
              </div>
            ) : null}
            {error ? <div className="text-[11px]! text-(--error)! mt-1.5!">{error}</div> : null}
          </>
        )}
      </div>

      <div className="absolute! bottom-0! left-0! w-full! px-(--gutter)! py-4! border-t! border-(--border-color)! bg-(--bg-main)! z-dropdown!">
        {!isDevnet ? (
          <button
            onClick={handleSwitchToDevnet}
            disabled={switchingNet}
            className={`${BTN_SHELL} bg-(--primary)! border-(--primary)! hover:bg-(--primary-hover)! text-(--primary-fg)!`}
          >
            {switchingNet ? 'Switching' : 'Switch to Devnet'}
          </button>
        ) : direction === 'eth_to_oct' ? (
          <button
            disabled
            className={`${BTN_SHELL} bg-(--bg-card)! border-(--border-color)! text-content-muted! cursor-not-allowed!`}
          >
            ETH → OCT coming soon
          </button>
        ) : (
          <ConfirmActionButton
            onConfirm={handleSwap}
            disabled={!canSwap}
            label={swapButtonLabel}
            loadingLabel="SWAPPING..."
            className={`${BTN_SHELL} ${
              canSwap
                ? 'bg-(--primary)! border-(--primary)! hover:bg-(--primary-hover)! text-(--primary-fg)!'
                : 'bg-(--bg-card)! border-(--border-color)! text-content-muted! cursor-not-allowed!'
            }`}
          />
        )}
      </div>
    </div>
  );
};

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex! justify-between! items-center! text-[11px]!">
      <span className="text-content-muted! font-bold! uppercase!">{label}</span>
      <span className="font-mono! text-(--text-main)!">{value}</span>
    </div>
  );
}

export default SwapScreen;
