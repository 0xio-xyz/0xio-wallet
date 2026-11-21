import { useTranslation } from 'src/i18n/react';
import { Sheet, RuledList, ListRow, PrimaryButton } from 'src/shared/ui/primitives';
import { getNetworkConfig } from 'src/utils/network';
import type { NetworkId } from 'src/utils/config';

interface PrivacyReviewProps {
  isOpen: boolean;
  onClose: () => void;
  type: 'encrypt' | 'decrypt';
  amount: string;
  fromBalance: string;
  toBalance: string;
  networkId: string;
  fee: string;
  isBusy: boolean;
  progressLabel?: string;
  onConfirm: () => void;
}

const trimOct = (val: string): string => {
  const n = parseFloat(val);
  if (isNaN(n)) return val;
  return n.toString();
};

const value = (text: string, strong = false, accent = false) => (
  <span
    style={{
      fontSize: '12px',
      fontWeight: strong ? 600 : 500,
      color: accent ? 'var(--accent)' : 'var(--fg)',
      fontVariantNumeric: 'tabular-nums',
      minWidth: 0,
      maxWidth: '200px',
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    }}
  >
    {text}
  </span>
);

const PrivacyReview = ({
  isOpen,
  onClose,
  type,
  amount,
  fromBalance,
  toBalance,
  networkId,
  fee,
  isBusy,
  progressLabel,
  onConfirm,
}: PrivacyReviewProps) => {
  const { t } = useTranslation();
  const isEncrypt = type === 'encrypt';
  const amtNum = parseFloat(amount) || 0;
  const unit = isEncrypt ? 'OCT' : 'pOCT';
  const toUnit = isEncrypt ? 'pOCT' : 'OCT';
  const total = trimOct((amtNum + parseFloat(fee)).toFixed(6));

  return (
    <Sheet
      open={isOpen}
      onClose={onClose}
      title={isEncrypt ? 'Review encrypt' : 'Review decrypt'}
      closeLabel={t('common.close')}
      footer={
        <PrimaryButton onClick={onConfirm} loading={isBusy}>
          {isBusy ? progressLabel || (isEncrypt ? 'Encrypting' : 'Decrypting') : 'Confirm'}
        </PrimaryButton>
      }
    >
      <div className="flex! flex-col!" style={{ padding: '2px 0 14px', gap: '3px' }}>
        <span
          style={{
            fontSize: '26px',
            fontWeight: 600,
            color: 'var(--fg)',
            lineHeight: 1.1,
            letterSpacing: '-0.01em',
            fontVariantNumeric: 'tabular-nums',
          }}
        >
          {trimOct(amtNum.toFixed(6))} {unit}
        </span>
        <span style={{ fontSize: '12px', color: 'var(--fg-3)' }}>
          {isEncrypt ? 'Public to private' : 'Private to public'}
        </span>
      </div>
      <RuledList>
        <ListRow
          label={isEncrypt ? 'From public balance' : 'From private balance'}
          right={value(`${trimOct(fromBalance)} ${unit}`)}
          chevron={false}
        />
        <ListRow
          label={isEncrypt ? 'To private balance' : 'To public balance'}
          right={value(`${trimOct((parseFloat(toBalance) + amtNum).toFixed(6))} ${toUnit}`)}
          chevron={false}
        />
        <ListRow
          label="Network"
          right={value(getNetworkConfig(networkId as NetworkId).name)}
          chevron={false}
        />
        <ListRow
          label="Operation"
          right={value(isEncrypt ? 'FHE encrypt' : 'FHE decrypt', false, true)}
          chevron={false}
        />
        <ListRow
          label={t('send.networkFee')}
          right={value(`${trimOct(fee)} OCT`)}
          chevron={false}
        />
        <ListRow label="Total deducted" right={value(`${total} ${unit}`, true)} chevron={false} />
      </RuledList>
    </Sheet>
  );
};

export default PrivacyReview;
