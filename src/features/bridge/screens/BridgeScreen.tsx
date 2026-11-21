import { useState } from 'react';
import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { ArrowUpDown } from 'src/shared/ui/icons';
import Header from 'src/shared/ui/Header';
import AnyChainPanel from 'src/features/bridge/components/AnyChainPanel';
import BridgeReviewSheet from 'src/features/bridge/components/BridgeReviewSheet';
import FindTransferSheet from 'src/features/bridge/components/FindTransferSheet';
import HeaderPill, { FindButton } from 'src/features/bridge/components/HeaderPill';
import WebBridgePanel from 'src/features/bridge/components/WebBridgePanel';
import { useBridgeFlow } from 'src/features/bridge/useBridgeFlow';
import { checkEthAddress, fmtRaw } from 'src/features/bridge/transfersView';
import {
  FieldNote,
  PrimaryButton,
  TextButton,
  TextTab,
  quietField,
} from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { middleCut } from 'src/features/wallet/add/format';
import { ZeroXIOConfig } from 'src/utils/config';
import { cleanAmountInput, fromUnits, toUnits } from 'src/utils/amount';
import { isOctAddress } from 'src/utils/octra/address';
import { BRIDGE } from 'src/services/bridge/constants';
import type { BridgeDirection } from 'src/services/bridge/transfers';

const Side = ({
  label,
  symbol,
  chain,
  balance,
}: {
  label: string;
  symbol: string;
  chain: string;
  balance: string;
}) => (
  <div className="flex! items-center!" style={{ gap: '12px', padding: '12px 16px' }}>
    <img
      src="/chains/octra/logo.webp"
      alt=""
      width={30}
      height={30}
      className="rounded-full!"
      style={{ opacity: symbol === 'wOCT' ? 0.85 : 1 }}
    />
    <span className="flex! min-w-0! flex-1! flex-col!" style={{ gap: '3px' }}>
      <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
        {label}
      </span>
      <span style={{ fontSize: '14px', color: 'var(--fg)' }}>
        {symbol} <span style={{ color: 'var(--fg-3)' }}>{chain}</span>
      </span>
    </span>
    <span style={{ fontSize: '12px', color: 'var(--fg-2)', fontVariantNumeric: 'tabular-nums' }}>
      {balance}
    </span>
  </div>
);

const BridgeScreen = () => {
  const navigate = useNavigate();
  const { t } = useTranslation();
  const [direction, setDirection] = useState<BridgeDirection>('o2e');
  const [mode, setMode] = useState<'wrap' | 'any'>('wrap');
  const [amount, setAmount] = useState('');
  const [customTo, setCustomTo] = useState<string | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const flow = useBridgeFlow({ onSent: () => setAmount('') });
  const { activeWallet, evmAddress, wOctRaw, busy, pending, problem, keyless } = flow;

  const header = (
    <Header
      title={t('bridge.title', { defaultValue: 'Bridge' })}
      showBack
      showSettings={false}
      onBack={() => navigate('/')}
      rightAction={
        !flow.ready ? undefined : (
          <span className="flex! items-center!" style={{ gap: '8px' }}>
            <FindButton
              label={t('bridge.findTitle', { defaultValue: 'Find a transfer' })}
              onClick={() => setFindOpen(true)}
            />
            {flow.loaded && flow.transferCount > 0 && (
              <HeaderPill
                label={t('bridge.claim', { defaultValue: 'Claim' })}
                count={flow.readyCount}
                ariaLabel={t('bridge.claimPillLabel', {
                  defaultValue: '{{n}} ready to claim',
                  n: flow.readyCount,
                })}
                onClick={() => navigate('/bridge/claim')}
              />
            )}
          </span>
        )
      }
    />
  );

  if (!flow.ready) {
    return (
      <div className="flex! h-full! flex-col! bg-(--bg)!">
        {header}
        <div
          className="flex! flex-1! flex-col! items-center! justify-center! text-center!"
          style={{ gap: '12px', padding: '0 28px' }}
        >
          <span style={{ fontSize: '18px', fontWeight: 300, color: 'var(--fg)' }}>
            {!flow.isMainnet
              ? t('bridge.mainnetOnly', { defaultValue: 'Mainnet only' })
              : flow.watchOnly
                ? t('bridge.watchOnly', { defaultValue: 'Watch-only' })
                : t('bridge.needsEvm', { defaultValue: 'Bridge needs EVM' })}
          </span>
          <PrimaryButton
            onClick={() =>
              !flow.isMainnet
                ? void chrome.storage.local.set({
                    [ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK]: 'mainnet',
                  })
                : navigate(flow.watchOnly ? '/walletlist' : '/settings/evm')
            }
            style={{ ...BIG_BUTTON, width: 'auto', padding: '0 26px', marginTop: '6px' }}
          >
            {!flow.isMainnet
              ? t('bridge.switchToMainnet', { defaultValue: 'Switch to mainnet' })
              : flow.watchOnly
                ? t('common.switchWallet', { defaultValue: 'Switch wallet' })
                : t('bridge.openEvm', { defaultValue: 'Turn on EVM' })}
          </PrimaryButton>
        </div>
      </div>
    );
  }

  const { octRaw } = flow;
  const feeRaw = flow.lockFeeRaw ?? 0n;
  let amountRaw = 0n;
  try {
    amountRaw = amount ? toUnits(amount, 6) : 0n;
  } catch {
    amountRaw = 0n;
  }
  const ownTo = direction === 'o2e' ? (evmAddress ?? '') : (activeWallet?.address ?? '');
  const typing = customTo !== null || (keyless && direction === 'o2e');
  const recipient = (customTo ?? ownTo).trim();
  const evmCheck = checkEthAddress(recipient);
  const recipientOk = direction === 'o2e' ? evmCheck === 'ok' : isOctAddress(recipient);
  const webBurn = keyless && direction === 'e2o';
  const burnResume = direction === 'e2o' && !keyless && flow.burnsWaiting.length > 0;
  const moving = burnResume ? null : direction === 'o2e' ? flow.active.o2e : flow.active.e2o;
  const available = direction === 'o2e' ? (octRaw > feeRaw ? octRaw - feeRaw : 0n) : wOctRaw;
  const tooSmall = direction === 'o2e' && amountRaw > 0n && amountRaw < BRIDGE.minLockRaw;
  const over = amountRaw > available;
  const canReview =
    !!activeWallet &&
    (!!evmAddress || direction === 'o2e') &&
    amountRaw > 0n &&
    !over &&
    !tooSmall &&
    recipientOk &&
    !busy;
  const wOctShown = keyless ? '' : fmtRaw(wOctRaw);

  const fromSide =
    direction === 'o2e'
      ? { symbol: 'OCT', chain: 'Octra', bal: fmtRaw(octRaw) }
      : { symbol: 'wOCT', chain: 'Ethereum', bal: wOctShown };
  const toSide =
    direction === 'o2e'
      ? { symbol: 'wOCT', chain: 'Ethereum', bal: wOctShown }
      : { symbol: 'OCT', chain: 'Octra', bal: fmtRaw(octRaw) };

  return (
    <div className="flex! h-full! flex-col! bg-(--bg)!">
      {header}
      <div
        className="flex! min-h-0! flex-1! flex-col!"
        style={{ padding: '2px var(--gutter) 14px' }}
      >
        <div className="flex! shrink-0!" style={{ gap: '18px', padding: '0 2px 8px' }}>
          <TextTab active={mode === 'wrap'} onClick={() => setMode('wrap')}>
            {t('bridge.modeWrap', { defaultValue: 'OCT and wOCT' })}
          </TextTab>
          <TextTab active={mode === 'any'} onClick={() => setMode('any')}>
            {t('bridge.modeAny', { defaultValue: 'Any chain to OCT' })}
          </TextTab>
        </div>
        {mode === 'any' && activeWallet ? (
          keyless ? (
            <WebBridgePanel kind="any" octAddress={activeWallet.address} />
          ) : (
            <AnyChainPanel
              octAddress={activeWallet.address}
              wallet={flow.evmWallet()}
              onStarted={flow.add}
            />
          )
        ) : (
          <>
            <div
              className="relative! shrink-0! rounded-[22px]! bg-(--bg-1)!"
              style={{ boxShadow: 'var(--raise-shadow)' }}
            >
              <Side
                label={t('bridge.from', { defaultValue: 'From' })}
                symbol={fromSide.symbol}
                chain={fromSide.chain}
                balance={fromSide.bal}
              />
              <Side
                label={t('bridge.to', { defaultValue: 'To' })}
                symbol={toSide.symbol}
                chain={toSide.chain}
                balance={toSide.bal}
              />
              <button
                type="button"
                onClick={() => {
                  setDirection((d) => (d === 'o2e' ? 'e2o' : 'o2e'));
                  setAmount('');
                  setCustomTo(null);
                  flow.setProblem(null);
                }}
                aria-label={t('bridge.swap', { defaultValue: 'Swap direction' })}
                className="press absolute! grid! place-items-center! bg-(--bg-3)! hover:bg-(--bg-2)!"
                style={{
                  right: '50%',
                  top: '50%',
                  transform: 'translate(50%, -50%)',
                  width: '34px',
                  height: '34px',
                  borderRadius: '17px',
                  border: 'none',
                  color: 'var(--fg)',
                  cursor: 'pointer',
                  boxShadow: 'var(--raise-shadow)',
                }}
              >
                <ArrowUpDown size={15} />
              </button>
            </div>

            {webBurn && activeWallet ? (
              <WebBridgePanel kind="burn" octAddress={activeWallet.address} />
            ) : (
              <>
                <div className="shrink-0!" style={{ marginTop: '14px' }}>
                  <div className="flex! items-center! justify-between!">
                    <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
                      {t('bridge.amount', { defaultValue: 'You bridge' })}
                    </span>
                    <TextButton size={12} onClick={() => setAmount(fromUnits(available, 6))}>
                      {t('bridge.max', { defaultValue: 'Max' })}
                    </TextButton>
                  </div>
                  <div
                    className="flex! items-center! bg-(--bg-1)!"
                    style={{
                      marginTop: '6px',
                      height: '54px',
                      padding: '0 16px',
                      borderRadius: '18px',
                      gap: '8px',
                    }}
                  >
                    <input
                      value={amount}
                      onChange={(e) => {
                        const next = cleanAmountInput(e.target.value, 6, 12);
                        if (next !== null) setAmount(next);
                      }}
                      inputMode="decimal"
                      placeholder="0"
                      aria-label={t('bridge.amount', { defaultValue: 'You bridge' })}
                      className="outline-none!"
                      style={{
                        flex: 1,
                        minWidth: 0,
                        border: 'none',
                        background: 'transparent',
                        color: 'var(--fg)',
                        fontSize: '28px',
                        fontWeight: 300,
                        letterSpacing: '-0.03em',
                        fontVariantNumeric: 'tabular-nums',
                      }}
                    />
                    <span style={{ fontSize: '14px', color: 'var(--fg-3)' }}>
                      {fromSide.symbol}
                    </span>
                  </div>
                  <FieldNote tone={over || tooSmall ? 'neg' : 'muted'}>
                    {over
                      ? t('bridge.over', { defaultValue: 'Insufficient balance' })
                      : tooSmall
                        ? t('bridge.min', { defaultValue: 'Minimum amount is 1 OCT' })
                        : amountRaw > 0n
                          ? t('bridge.receive', {
                              defaultValue: 'You get {{amount}} {{symbol}}',
                              amount: fmtRaw(amountRaw),
                              symbol: toSide.symbol,
                            })
                          : ''}
                  </FieldNote>
                </div>

                <div className="shrink-0!" style={{ marginTop: '4px' }}>
                  <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
                    {t('bridge.receiver', { defaultValue: 'Receiving address' })}
                  </span>
                  {!typing ? (
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
                        style={{
                          fontSize: '12.5px',
                          color: 'var(--fg)',
                          fontFamily: 'var(--font-mono)',
                        }}
                      >
                        {middleCut(ownTo, 10, 8)}
                      </span>
                      <TextButton size={12} onClick={() => setCustomTo('')}>
                        {t('bridge.change', { defaultValue: 'Change' })}
                      </TextButton>
                    </div>
                  ) : (
                    <div className="relative!">
                      <input
                        autoFocus={!!ownTo}
                        value={customTo ?? ''}
                        onChange={(e) =>
                          setCustomTo(e.target.value.replace(/\s+/g, '').slice(0, 64))
                        }
                        onKeyDown={(e) => {
                          if (e.key === 'Escape' && ownTo) {
                            e.stopPropagation();
                            setCustomTo(null);
                          }
                        }}
                        placeholder={
                          direction === 'o2e'
                            ? t('bridge.evmPlaceholder', { defaultValue: '0x address on Ethereum' })
                            : 'oct address'
                        }
                        aria-label={t('bridge.receiver', { defaultValue: 'Receiving address' })}
                        spellCheck={false}
                        autoComplete="off"
                        className={`${quietField} ${customTo && !recipientOk ? 'border-(--neg)!' : ''}`}
                        style={{
                          marginTop: '6px',
                          height: '44px',
                          borderRadius: '16px',
                          fontFamily: 'var(--font-mono)',
                          fontSize: '12.5px',
                          paddingRight: ownTo ? '76px' : undefined,
                        }}
                      />
                      {ownTo && (
                        <span
                          className="absolute! flex! items-center!"
                          style={{ right: '14px', top: '6px', height: '44px' }}
                        >
                          <TextButton size={12} onClick={() => setCustomTo(null)}>
                            {t('common.cancel', { defaultValue: 'Cancel' })}
                          </TextButton>
                        </span>
                      )}
                    </div>
                  )}
                  <FieldNote tone="neg">
                    {!customTo || recipientOk
                      ? ''
                      : direction === 'o2e' && evmCheck === 'checksum'
                        ? t('bridge.badChecksum', {
                            defaultValue:
                              'Invalid address checksum. Check it or paste it in lowercase.',
                          })
                        : t('bridge.badAddress', { defaultValue: 'Invalid address' })}
                  </FieldNote>
                </div>

                <div
                  className="flex! shrink-0! items-start!"
                  style={{ margin: '4px 2px 0', height: '32px', gap: '12px' }}
                >
                  <p
                    className="line-clamp-2! min-w-0! flex-1!"
                    aria-live="polite"
                    style={{
                      margin: 0,
                      fontSize: '11.5px',
                      lineHeight: '16px',
                      color: burnResume || moving ? 'var(--fg-2)' : 'var(--fg-3)',
                    }}
                  >
                    {burnResume
                      ? flow.burnsWaiting.length === 1
                        ? t('bridge.burnWaitingOne', {
                            defaultValue: 'An allowed transfer to Octra is waiting.',
                          })
                        : t('bridge.burnWaitingMany', {
                            defaultValue: '{{n}} allowed transfers to Octra are waiting.',
                            n: flow.burnsWaiting.length,
                          })
                      : moving
                        ? flow.statusText(moving)
                        : direction === 'o2e'
                          ? keyless
                            ? t('bridge.noteO2eWeb', {
                                defaultValue:
                                  "Claim with any EVM wallet on {{host}} once Octra's proof reaches Ethereum.",
                                host: 'bridge.0xio.xyz',
                              })
                            : ''
                          : t('bridge.noteE2oShort', {
                              defaultValue: 'OCT arrives on Octra about a minute after you bridge.',
                            })}
                  </p>
                  {burnResume ? (
                    <TextButton
                      size={12}
                      disabled={busy}
                      onClick={() => void flow.openBurn(flow.burnsWaiting[0])}
                      style={{ lineHeight: '16px', whiteSpace: 'nowrap' }}
                    >
                      {t('bridge.bridgeAction', { defaultValue: 'Bridge' })}
                    </TextButton>
                  ) : moving?.status === 'approving' ? (
                    <TextButton
                      size={12}
                      disabled={busy}
                      onClick={() => void flow.openBurn(moving)}
                      style={{ lineHeight: '16px', whiteSpace: 'nowrap' }}
                    >
                      {t('bridge.view', { defaultValue: 'View' })}
                    </TextButton>
                  ) : moving && direction === 'o2e' ? (
                    <TextButton
                      size={12}
                      onClick={() => navigate('/bridge/claim')}
                      style={{ lineHeight: '16px', whiteSpace: 'nowrap' }}
                    >
                      {t('bridge.view', { defaultValue: 'View' })}
                    </TextButton>
                  ) : null}
                </div>

                <div className="mt-auto! shrink-0!">
                  <FieldNote tone="neg">{problem ?? ''}</FieldNote>
                  <div className="flex!" style={{ gap: '10px' }}>
                    <PrimaryButton
                      onClick={() => void flow.openNew(direction, amountRaw, recipient)}
                      disabled={!canReview}
                      loading={busy && !pending}
                      style={{ ...BIG_BUTTON, flex: 1 }}
                    >
                      {t('bridge.reviewBridge', { defaultValue: 'Review bridge' })}
                    </PrimaryButton>
                    {direction === 'o2e' && !keyless && (
                      <PrimaryButton
                        secondary
                        onClick={() => navigate('/bridge/claim')}
                        disabled={flow.readyCount === 0}
                        style={{ ...BIG_BUTTON, flex: '0 0 112px' }}
                      >
                        {t('bridge.claim', { defaultValue: 'Claim' })}
                      </PrimaryButton>
                    )}
                  </div>
                </div>
              </>
            )}
          </>
        )}
      </div>

      <FindTransferSheet flow={flow} open={findOpen} onClose={() => setFindOpen(false)} />
      <BridgeReviewSheet flow={flow} />
    </div>
  );
};

export default BridgeScreen;
