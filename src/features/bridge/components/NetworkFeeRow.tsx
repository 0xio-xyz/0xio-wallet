import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { ChevronRight } from 'src/shared/ui/icons';
import { FieldNote, PrimaryButton, QuietInput, Sheet } from 'src/shared/ui/primitives';
import { feeFigure } from 'src/features/bridge/bridgeUsd';
import FeeFigureText from 'src/features/bridge/components/FeeFigureText';
import { fromUnits } from 'src/utils/amount';
import {
  FEE_SPEEDS,
  NORMAL_FEE,
  applyFeeChoice,
  checkCustom,
  feePresets,
  networkMinimum,
  toGwei,
  withGasPrice,
  type FeeChoice,
  type FeeSpeed,
  type GasPrice,
} from 'src/services/evm/feeChoice';
import type { PreparedTransfer } from 'src/services/evm/send';

const nativeText = (wei: bigint, symbol: string) => {
  const [int, frac = ''] = fromUnits(wei, 18).split('.');
  const cut = frac.slice(0, 8).replace(/0+$/, '');
  return `${cut ? `${int}.${cut}` : int} ${symbol}`;
};

interface FeeProps {
  prepared: PreparedTransfer;
  choice: FeeChoice | undefined;
  onChoice: (choice: FeeChoice) => void;
  chainId: number;
  nativeSymbol: string;
  nativePrice: number | null | undefined;
}

const speedLabel = (t: (k: string, o: { defaultValue: string }) => string, s: FeeSpeed) =>
  s === 'slow'
    ? t('evmFee.slow', { defaultValue: 'Slow' })
    : s === 'fast'
      ? t('evmFee.fast', { defaultValue: 'Fast' })
      : t('evmFee.normal', { defaultValue: 'Normal' });

export const EvmFeeSheet = ({
  open,
  onClose,
  prepared,
  choice,
  onChoice,
  chainId,
  nativeSymbol,
  nativePrice,
}: FeeProps & { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const fees = prepared.fees;
  const current = choice ?? NORMAL_FEE;
  const seed = (): { maxGwei: string; priorityGwei: string } => {
    const gas: GasPrice | null =
      'custom' in current ? current.custom : fees ? feePresets(fees).normal : null;
    return gas
      ? { maxGwei: toGwei(gas.maxFeePerGas), priorityGwei: toGwei(gas.maxPriorityFeePerGas) }
      : { maxGwei: '', priorityGwei: '' };
  };
  const [customOpen, setCustomOpen] = useState('custom' in current);
  const [input, setInput] = useState(seed);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setCustomOpen('custom' in current);
      setInput(seed());
    }
  }
  if (!fees) return null;

  const legacy = fees.baseFeePerGas === null;
  const presets = feePresets(fees);
  const checked = checkCustom(input, fees, chainId);
  const figure = (gas: GasPrice) => {
    const p = withGasPrice(prepared, gas);
    return feeFigure(p.feeWei, 18, nativeText(p.feeWei, nativeSymbol), nativePrice);
  };
  const minimumGwei = toGwei(networkMinimum(fees, 0n));
  const maxLabel = legacy
    ? t('evmFee.gasPrice', { defaultValue: 'Gas price (gwei)' })
    : t('evmFee.maxFee', { defaultValue: 'Max fee (gwei)' });
  const priorityLabel = t('evmFee.priorityFee', { defaultValue: 'Priority fee (gwei)' });

  const option = (
    key: string,
    label: string,
    selected: boolean,
    right: React.ReactNode,
    onPick: () => void
  ) => (
    <button
      key={key}
      type="button"
      onClick={onPick}
      aria-pressed={selected}
      className={`press flex! w-full! items-center! justify-between! rounded-[14px]! ${
        selected ? 'bg-(--bg-2)!' : 'hover:bg-(--bg-2)!'
      }`}
      style={{
        height: '48px',
        padding: '0 12px',
        gap: '12px',
        border: 'none',
        background: selected ? undefined : 'transparent',
        cursor: 'pointer',
        textAlign: 'left',
        transition: 'background-color 200ms ease-out',
      }}
    >
      <span style={{ fontSize: '13.5px', color: 'var(--fg)' }}>{label}</span>
      <span style={{ fontSize: '13px', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}>
        {right}
      </span>
    </button>
  );

  const save = () => {
    if (checked.gas && checked.problem === null) {
      onChoice({ custom: checked.gas });
      onClose();
    }
  };

  const problemLine =
    checked.problem === 'belowBase'
      ? null
      : checked.problem === 'priority'
        ? t('evmFee.needPriority', { defaultValue: 'Priority fee must be above 0' })
        : checked.problem === 'ceiling'
          ? t('evmFee.tooHigh', { defaultValue: 'Far above the current network fee' })
          : checked.problem === 'format' && (input.maxGwei || input.priorityGwei)
            ? t('evmFee.badNumber', { defaultValue: 'Enter an amount in gwei' })
            : null;

  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('evmFee.title', { defaultValue: 'Network fee' })}
      zIndexClass="z-picker!"
      onSubmit={customOpen ? save : undefined}
    >
      <div className="flex! flex-col!" style={{ gap: '2px' }}>
        {FEE_SPEEDS.map((s) =>
          option(
            s,
            speedLabel(t, s),
            !customOpen && 'speed' in current && current.speed === s,
            <FeeFigureText fee={figure(presets[s])} />,
            () => {
              onChoice({ speed: s });
              onClose();
            }
          )
        )}
        {option(
          'custom',
          t('evmFee.custom', { defaultValue: 'Custom' }),
          customOpen,
          customOpen && checked.gas && checked.problem === null ? (
            <FeeFigureText fee={figure(checked.gas)} />
          ) : (
            ''
          ),
          () => setCustomOpen(true)
        )}
      </div>
      {customOpen && (
        <div style={{ padding: '12px 4px 0' }}>
          <div className="flex!" style={{ gap: '10px' }}>
            <div className="min-w-0! flex-1!">
              <QuietInput
                label={maxLabel}
                aria-label={maxLabel}
                value={input.maxGwei}
                onChange={(e) =>
                  setInput((v) => ({
                    ...v,
                    maxGwei: e.target.value.replace(/[^0-9.]/g, '').slice(0, 14),
                  }))
                }
                inputMode="decimal"
                autoComplete="off"
                spellCheck={false}
              />
            </div>
            {!legacy && (
              <div className="min-w-0! flex-1!">
                <QuietInput
                  label={priorityLabel}
                  aria-label={priorityLabel}
                  value={input.priorityGwei}
                  onChange={(e) =>
                    setInput((v) => ({
                      ...v,
                      priorityGwei: e.target.value.replace(/[^0-9.]/g, '').slice(0, 14),
                    }))
                  }
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                />
              </div>
            )}
          </div>
          <div style={{ minHeight: '58px', marginTop: '6px' }}>
            {checked.problem === 'belowBase' ? (
              <div
                className="rounded-[14px]! bg-(--bg-2)!"
                style={{
                  padding: '10px 12px',
                  fontSize: '11.5px',
                  lineHeight: 1.5,
                  color: 'var(--fg-2)',
                }}
              >
                {legacy
                  ? t('evmFee.belowPrice', {
                      defaultValue:
                        'Below the current gas price of {{base}} gwei. Raise it to send.',
                      base: minimumGwei,
                    })
                  : t('evmFee.belowBase', {
                      defaultValue:
                        'Below the current base fee of {{base}} gwei plus the priority fee. Raise the max fee to send.',
                      base: minimumGwei,
                    })}
              </div>
            ) : (
              <FieldNote tone="neg">{problemLine ?? ''}</FieldNote>
            )}
          </div>
          <PrimaryButton onClick={save} disabled={!checked.gas || checked.problem !== null}>
            {t('evmFee.useCustom', { defaultValue: 'Use custom fee' })}
          </PrimaryButton>
        </div>
      )}
    </Sheet>
  );
};

const NetworkFeeRow = ({
  label,
  disabled,
  ...props
}: FeeProps & { label: string; disabled?: boolean }) => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const shown = applyFeeChoice(props.prepared, props.choice);
  const fee = feeFigure(
    shown.feeWei,
    18,
    nativeText(shown.feeWei, props.nativeSymbol),
    props.nativePrice
  );
  const editable = !!props.prepared.fees && !disabled;
  return (
    <>
      <button
        type="button"
        onClick={() => editable && setOpen(true)}
        disabled={!editable}
        aria-label={editable ? t('evmFee.edit', { defaultValue: 'Edit network fee' }) : undefined}
        className="flex! w-full! items-start! justify-between!"
        style={{
          padding: '10px 4px',
          gap: '14px',
          border: 'none',
          background: 'transparent',
          cursor: editable ? 'pointer' : 'default',
          textAlign: 'left',
        }}
      >
        <span
          className="tab-caps"
          style={{ color: 'var(--fg-3)', paddingTop: '2px', flexShrink: 0 }}
        >
          {label}
        </span>
        <span
          className="flex! items-center!"
          style={{
            gap: '4px',
            fontSize: '13px',
            color: 'var(--fg)',
            textAlign: 'right',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          <span>
            <FeeFigureText fee={fee} />
          </span>
          {editable && <ChevronRight size={13} style={{ color: 'var(--fg-3)', flexShrink: 0 }} />}
        </span>
      </button>
      <EvmFeeSheet open={open} onClose={() => setOpen(false)} {...props} />
    </>
  );
};

export default NetworkFeeRow;
