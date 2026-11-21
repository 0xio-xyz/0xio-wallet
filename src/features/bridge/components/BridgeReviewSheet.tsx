import { useTranslation } from 'src/i18n/react';
import { PrimaryButton, Sheet } from 'src/shared/ui/primitives';
import FeeValue from 'src/shared/ui/FeeValue';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { fmtRaw } from 'src/features/bridge/transfersView';
import { amountUsd, feeFigure } from 'src/features/bridge/bridgeUsd';
import FeeFigureText from 'src/features/bridge/components/FeeFigureText';
import NetworkFeeRow from 'src/features/bridge/components/NetworkFeeRow';
import { applyFeeChoice } from 'src/services/evm/feeChoice';
import type { BridgeFlow } from 'src/features/bridge/useBridgeFlow';
import { useTokenPrice } from 'src/hooks/wallet/useTokenPrice';

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

const StepBadge = ({ step, label }: { step: 1 | 2; label: string }) => (
  <span className="flex! items-center!" style={{ gap: '8px', paddingTop: '3px' }}>
    <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>{label}</span>
    <span className="flex! items-center!" style={{ gap: '5px' }}>
      {[true, step === 2].map((on, i) => (
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
);

const BridgeReviewSheet = ({ flow }: { flow: BridgeFlow }) => {
  const { t } = useTranslation();
  const { getPrice } = useTokenPrice();
  const { pending, busy, waiting } = flow;

  const reviewTitle = {
    lock: t('bridge.r.lock', { defaultValue: 'Bridge to Ethereum' }),
    approve: t('bridge.r.approve', { defaultValue: 'Allow wOCT' }),
    burn: t('bridge.r.burn', { defaultValue: 'Bridge to Octra' }),
    claim: t('bridge.r.claim', { defaultValue: 'Claim on Ethereum' }),
  };
  const verb = {
    lock: t('bridge.r.lock', { defaultValue: 'Bridge to Ethereum' }),
    approve: t('bridge.allow', { defaultValue: 'Allow' }),
    burn: t('bridge.r.burn', { defaultValue: 'Bridge to Octra' }),
    claim: t('bridge.claim', { defaultValue: 'Claim' }),
  };

  const octPrice = getPrice('OCT');
  const amountLine = pending ? amountUsd(pending.amountRaw, 6, octPrice) : null;
  const lockFee =
    pending?.action === 'lock'
      ? feeFigure(pending.ouRaw ?? 0n, 6, `${fmtRaw(pending.ouRaw ?? 0n)} OCT`, octPrice)
      : null;
  const signs = pending?.prepared ? applyFeeChoice(pending.prepared, pending.fee) : null;
  const noEth = !!signs && signs.totalNative > flow.ethRaw;

  const note = !pending
    ? ''
    : noEth
      ? t('bridge.noEth', { defaultValue: 'Insufficient ETH on Ethereum for network fee' })
      : pending.feeRaised
        ? t('bridge.feeRaised', { defaultValue: 'Network fee went up. Review the new fee.' })
        : pending.action === 'lock'
          ? flow.keyless
            ? t('bridge.r.lockNoteWeb', {
                defaultValue:
                  'The bridge holds your OCT until wOCT is claimed. Claim with any EVM wallet on {{host}}. Only the address above receives it.',
                host: 'bridge.0xio.xyz',
              })
            : t('bridge.r.lockNote', {
                defaultValue:
                  'The bridge holds your OCT until wOCT is claimed. Claiming is a second step on Ethereum.',
              })
          : pending.action === 'approve'
            ? t('bridge.r.approveNote', {
                defaultValue:
                  'Allows this amount only. Bridging is the next step and has its own review.',
              })
            : pending.action === 'burn'
              ? waiting
                ? t('bridge.r.allowWaiting', {
                    defaultValue:
                      'Waiting for Ethereum to confirm the allowance. Bridge to Octra unlocks next.',
                  })
                : ''
              : t('bridge.r.claimNote', {
                  defaultValue:
                    'Sends wOCT to the address above. Anyone can submit the claim. Only that address receives it.',
                });

  return (
    <Sheet
      open={!!pending}
      onClose={flow.cancel}
      dismissible={!busy}
      title={pending ? reviewTitle[pending.action] : ''}
      action={
        pending?.step ? (
          <StepBadge
            step={pending.step}
            label={
              pending.step === 2
                ? t('bridge.step2of2', { defaultValue: 'Step 2 of 2' })
                : t('bridge.step1of2', { defaultValue: 'Step 1 of 2' })
            }
          />
        ) : undefined
      }
      footer={
        <div className="flex!" style={{ gap: '10px' }}>
          <PrimaryButton secondary onClick={flow.cancel} disabled={busy} style={BIG_BUTTON}>
            {t('common.reject', { defaultValue: 'Reject' })}
          </PrimaryButton>
          <PrimaryButton
            onClick={() => void flow.confirm()}
            loading={busy}
            disabled={!pending || (pending.action !== 'lock' && !pending.prepared) || noEth}
            style={BIG_BUTTON}
          >
            {pending ? verb[pending.action] : ''}
          </PrimaryButton>
        </div>
      }
    >
      {pending && (
        <>
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
              {fmtRaw(pending.amountRaw)}{' '}
              <span style={{ fontSize: '16px', color: 'var(--fg-3)', letterSpacing: 0 }}>
                {pending.action === 'lock' ? 'OCT' : 'wOCT'}
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
              {amountLine ?? ''}
            </div>
          </div>
          <div className="rounded-[18px]! bg-(--bg-2)!" style={{ padding: '4px 10px' }}>
            {pending.action === 'approve' ? (
              <Row
                label={t('bridge.spender', { defaultValue: 'Spender' })}
                value={t('bridge.spenderName', { defaultValue: '0xio bridge on Ethereum' })}
              />
            ) : (
              <Row label={t('bridge.to', { defaultValue: 'To' })} value={pending.recipient} />
            )}
            <Row
              label={t('bridge.network', { defaultValue: 'Network' })}
              value={pending.action === 'lock' ? 'Octra' : 'Ethereum'}
            />
            {pending.action !== 'lock' && pending.prepared ? (
              <NetworkFeeRow
                label={t('bridge.networkFee', { defaultValue: 'Network fee' })}
                prepared={pending.prepared}
                choice={pending.fee}
                onChoice={flow.setFee}
                chainId={pending.prepared.tx.chainId}
                nativeSymbol="ETH"
                nativePrice={getPrice('ETH')}
                disabled={busy}
              />
            ) : (
              <Row
                label={t('bridge.networkFee', { defaultValue: 'Network fee' })}
                value={lockFee ? <FeeFigureText fee={lockFee} /> : <FeeValue state="loading" />}
              />
            )}
          </div>
          <p
            style={{
              margin: '12px 4px 0',
              minHeight: '35px',
              fontSize: '11.5px',
              lineHeight: 1.5,
              color: noEth ? 'var(--neg)' : 'var(--fg-3)',
            }}
          >
            {note}
          </p>
        </>
      )}
    </Sheet>
  );
};

export default BridgeReviewSheet;
