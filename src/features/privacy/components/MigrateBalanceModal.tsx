import { useTranslation } from 'src/i18n/react';
import FeeValue from 'src/shared/ui/FeeValue';
import { Mascot } from 'src/shared/ui/Mascot';
import { Modal, PrimaryButton, RuledList, ListRow } from 'src/shared/ui/primitives';

interface Props {
  show: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
  progress: string;
  encryptedOct: string;
  feeOct: string;
  publicOct: string;
  feeShort: boolean;
  reusingPayload: boolean;
  feeFailed?: boolean;
  onRetryFee?: () => void;
}

const value = (text: React.ReactNode) => (
  <span
    style={{
      fontSize: '12px',
      fontWeight: 500,
      color: 'var(--fg)',
      fontVariantNumeric: 'tabular-nums',
    }}
  >
    {text}
  </span>
);

export default function MigrateBalanceModal({
  show,
  onClose,
  onSubmit,
  submitting,
  progress,
  encryptedOct,
  feeOct,
  publicOct,
  feeShort,
  reusingPayload,
  feeFailed = false,
  onRetryFee,
}: Props) {
  const { t } = useTranslation();
  return (
    <Modal
      open={show}
      onClose={onClose}
      dismissible={!submitting}
      maxWidth={340}
      title="Migrate balance"
      sub={`Rebuilds the same balance as compact ciphertext under your current key via a key switch. ${
        reusingPayload
          ? 'Reuses the prepared migration, so it submits in seconds.'
          : 'Proof generation runs locally and takes a few minutes.'
      }`}
      footer={
        submitting ? (
          <div className="flex! items-center!" style={{ gap: '10px', minHeight: '20px' }}>
            <Mascot mood="encrypt" size={28} />
            <span style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{progress || 'Working'}</span>
          </div>
        ) : feeFailed && onRetryFee ? (
          <PrimaryButton onClick={onRetryFee}>
            {t('privacy.tryAgain', { defaultValue: 'Try again' })}
          </PrimaryButton>
        ) : (
          <PrimaryButton onClick={onSubmit} disabled={feeShort || !feeOct}>
            Migrate
          </PrimaryButton>
        )
      }
    >
      <RuledList>
        <ListRow
          label="Encrypted balance"
          right={value(encryptedOct ? `${encryptedOct} OCT` : '...')}
          chevron={false}
        />
        <ListRow
          label="Network fee"
          right={value(
            feeOct ? `${feeOct} OCT` : <FeeValue state={feeFailed ? 'failed' : 'loading'} />
          )}
          chevron={false}
        />
        <ListRow
          label="Public balance"
          right={value(publicOct ? `${publicOct} OCT` : '...')}
          chevron={false}
        />
      </RuledList>
      {feeFailed && !submitting && (
        <p style={{ fontSize: '11px', color: 'var(--neg)', margin: '10px 0 0', lineHeight: 1.5 }}>
          {t('privacy.feeUnread', { defaultValue: 'Network fee unavailable. Try again.' })}
        </p>
      )}
      {feeShort && !submitting && (
        <p style={{ fontSize: '11px', color: 'var(--neg)', margin: '10px 0 0', lineHeight: 1.5 }}>
          Insufficient public balance for network fee
        </p>
      )}
    </Modal>
  );
}
