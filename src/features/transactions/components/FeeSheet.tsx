import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { X } from 'src/shared/ui/icons';
import { useSheetDrag } from 'src/hooks/ui/useSheetDrag';

export interface FeeSheetPreset {
  label: string;
  ou: string;
  eta: string;
}

export interface FeeSheetProps {
  open: boolean;
  value: string;
  presets: FeeSheetPreset[];
  defaultOu?: string;
  minOu?: string;
  octUsdPrice?: number | null;
  onSave: (ou: string) => void;
  onClose: () => void;
}

const ouToOct = (ou: string | number) => parseFloat((Number(ou) / 1_000_000).toFixed(6));

export default function FeeSheet({
  open,
  value,
  presets,
  defaultOu,
  minOu,
  octUsdPrice,
  onSave,
  onClose,
}: FeeSheetProps): JSX.Element | null {
  const { t, i18n } = useTranslation();
  const { panelProps, closing, requestClose } = useSheetDrag(onClose, open);
  const defaultResolved = defaultOu ?? presets[1]?.ou ?? presets[0]?.ou ?? '';

  const [tempOu, setTempOu] = useState<string>(value);
  const [customInput, setCustomInput] = useState<string>(() =>
    presets.some((p) => p.ou === value) ? '' : value
  );
  const minCustom = Math.max(100, Number(minOu) || 0);
  const customOuNum = Number(customInput);
  const customInvalid =
    customInput !== '' &&
    !(Number.isInteger(customOuNum) && customOuNum >= minCustom && customOuNum <= 10_000_000);

  const prevOpen = useRef<boolean>(open);
  if (open && !prevOpen.current) {
    setTempOu(value);
    setCustomInput(presets.some((p) => p.ou === value) ? '' : value);
  }
  prevOpen.current = open;

  if (!open) return null;

  const octEstimate = ouToOct(tempOu || defaultResolved);
  const usd = octUsdPrice
    ? ` ($${(octEstimate * octUsdPrice).toLocaleString(undefined, { maximumFractionDigits: 4 })})`
    : '';

  return (
    <div
      className="fixed! inset-0! z-picker! bg-surface-overlay! animate-in! fade-in! duration-200!"
      onClick={requestClose}
      style={{ opacity: closing ? 0 : undefined, transition: 'opacity 200ms ease' }}
    >
      <div
        className="absolute! inset-x-0! bottom-0! bg-(--bg)! rounded-t-2xl! animate-in! slide-in-from-bottom-full! duration-300!"
        onClick={(e) => e.stopPropagation()}
        {...panelProps}
        style={{ ...panelProps.style, padding: '0 16px 16px' }}
      >
        <div className="flex! justify-center! cursor-grab!" style={{ padding: '8px 0 10px' }}>
          <div className="w-9! h-1! rounded-full! bg-(--line-2)!" />
        </div>

        <div className="flex! items-start! justify-between!" style={{ marginBottom: '14px' }}>
          <div>
            <div style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}>
              {t('send.networkFee')}
            </div>
            <div style={{ fontSize: '11px', color: 'var(--fg-3)', marginTop: '2px' }}>
              {t('send.higherFeeFaster')}
            </div>
          </div>
          <button
            onClick={requestClose}
            aria-label={t('common.close')}
            className="w-7! h-7! flex! items-center! justify-center! rounded-md! text-content-muted! hover:text-(--fg)! transition-colors!"
            style={{ background: 'none', border: 'none', cursor: 'pointer' }}
          >
            <X size={15} />
          </button>
        </div>

        <div
          className={`grid! ${presets.length === 2 ? 'grid-cols-2!' : 'grid-cols-3!'} rounded-[10px]! overflow-hidden!`}
          style={{ gap: '1px', background: 'var(--line)' }}
        >
          {presets.map((p) => {
            const selected = tempOu === p.ou && !customInput;
            return (
              <button
                key={p.label}
                onClick={() => {
                  setTempOu(p.ou);
                  setCustomInput('');
                }}
                className={`flex! flex-col! items-center! justify-center! transition-colors! ${
                  selected ? 'bg-(--bg-2)!' : 'bg-(--bg-1)! hover:bg-(--bg-2)!'
                }`}
                style={{ height: '56px', border: 'none', cursor: 'pointer', gap: '2px' }}
              >
                <span
                  style={{
                    fontSize: '12px',
                    fontWeight: 600,
                    color: selected ? 'var(--fg)' : 'var(--fg-2)',
                  }}
                >
                  {t(`send.fee${p.label}`, { defaultValue: p.label })}
                </span>
                <span
                  style={{
                    fontSize: '11px',
                    color: 'var(--fg-3)',
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  <span className="flex! items-center!" style={{ gap: '6px' }}>
                    <span>{ouToOct(p.ou)} OCT</span>
                    <span>{p.eta}</span>
                  </span>
                </span>
              </button>
            );
          })}
        </div>

        <div
          className="flex! items-center! rounded-[10px]! bg-(--bg-1)!"
          style={{ height: '44px', padding: '0 12px', marginTop: '8px', gap: '8px' }}
        >
          <input
            type="text"
            inputMode="numeric"
            maxLength={8}
            value={customInput}
            onChange={(e) => {
              const digits = e.target.value.replace(/\D/g, '').replace(/^0+(?=\d)/, '');
              setCustomInput(digits);
              setTempOu(digits || defaultResolved);
            }}
            placeholder={t('send.customFee')}
            aria-invalid={customInvalid}
            onKeyDown={(e) => {
              if (e.key !== 'Enter' || customInvalid) return;
              onSave(tempOu || defaultResolved);
              requestClose();
            }}
            style={{
              flex: 1,
              minWidth: 0,
              background: 'transparent',
              border: 'none',
              outline: 'none',
              fontSize: '13px',
              fontWeight: 600,
              color: 'var(--fg)',
              fontVariantNumeric: 'tabular-nums',
            }}
          />
          <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>OU</span>
        </div>
        <div
          className="flex! justify-between! items-center!"
          style={{ marginTop: '6px', padding: '0 2px', fontSize: '11px', color: 'var(--fg-3)' }}
        >
          <span style={{ fontVariantNumeric: 'tabular-nums' }}>
            ≈ {octEstimate} OCT{usd}
          </span>
          <div className="flex! items-center!" style={{ gap: '10px' }}>
            <span style={{ color: customInvalid ? 'var(--neg)' : undefined }}>
              {t('send.feeRangeLimits', {
                min: minCustom.toLocaleString(i18n.language),
                defaultValue: '{{min}} to 10,000,000 OU',
              })}
            </span>
            <button
              onClick={() => {
                setTempOu(defaultResolved);
                setCustomInput('');
              }}
              style={{
                background: 'none',
                border: 'none',
                padding: 0,
                cursor: 'pointer',
                fontSize: '11px',
                fontWeight: 600,
                color: 'var(--accent)',
              }}
            >
              {t('send.reset')}
            </button>
          </div>
        </div>

        <button
          disabled={customInvalid}
          onClick={() => {
            if (customInvalid) return;
            onSave(tempOu || defaultResolved);
            requestClose();
          }}
          className="w-full! flex! items-center! justify-center!"
          style={{
            height: '44px',
            borderRadius: '10px',
            background: 'var(--accent)',
            border: 'none',
            color: 'var(--accent-fg)',
            fontSize: '13px',
            fontWeight: 600,
            cursor: customInvalid ? 'not-allowed' : 'pointer',
            opacity: customInvalid ? 0.5 : 1,
            marginTop: '14px',
          }}
        >
          {t('common.save')}
        </button>
      </div>
    </div>
  );
}
