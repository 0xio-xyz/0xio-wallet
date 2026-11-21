import { useTranslation } from 'src/i18n/react';
import FeeValue from 'src/shared/ui/FeeValue';
import { Mascot } from 'src/shared/ui/Mascot';
import { Modal, PrimaryButton, RuledList, ListRow } from 'src/shared/ui/primitives';

export type SetupFee =
  | { state: 'loading' }
  | { state: 'failed' }
  | { state: 'ready'; raw: string; oct: string };

interface Props {
  show: boolean;
  onClose: () => void;
  onSubmit: () => void;
  submitting: boolean;
  progress: string;
  fee: SetupFee;
  feeShort: boolean;
  publicOct: string;
  onRetryFee: () => void;
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

export default function SetupPrivateBalanceModal({
  show,
  onClose,
  onSubmit,
  submitting,
  progress,
  fee,
  feeShort,
  publicOct,
  onRetryFee,
}: Props) {
  const { t } = useTranslation();
  const short = fee.state === 'ready' && feeShort;
  return (
    <Modal
      open={show}
      onClose={onClose}
      dismissible={!submitting}
      maxWidth={340}
      title="Set up private balance"
      sub="Registers your private balance key on Octra with a one-time key switch transaction. The key is published on chain."
      footer={
        submitting ? (
          <div className="flex! items-center!" style={{ gap: '10px', minHeight: '20px' }}>
            <Mascot mood="encrypt" size={28} />
            <span style={{ fontSize: '12px', color: 'var(--fg-2)' }}>{progress || 'Working'}</span>
          </div>
        ) : fee.state === 'failed' ? (
          <PrimaryButton onClick={onRetryFee}>
            {t('privacy.tryAgain', { defaultValue: 'Try again' })}
          </PrimaryButton>
        ) : (
          <PrimaryButton onClick={onSubmit} disabled={fee.state !== 'ready' || short}>
            Submit
          </PrimaryButton>
        )
      }
    >
      <RuledList>
        <ListRow
          label={t('privacy.networkFee', { defaultValue: 'Network fee' })}
          right={value(
            fee.state === 'ready' ? (
              `${fee.oct} OCT`
            ) : (
              <FeeValue state={fee.state === 'failed' ? 'failed' : 'loading'} />
            )
          )}
          chevron={false}
        />
        <ListRow
          label={t('privacy.publicBalance', { defaultValue: 'Public balance' })}
          right={value(publicOct ? `${publicOct} OCT` : '...')}
          chevron={false}
        />
      </RuledList>
      {!submitting && (fee.state === 'failed' || short) && (
        <p style={{ fontSize: '11px', color: 'var(--neg)', margin: '10px 0 0', lineHeight: 1.5 }}>
          {fee.state === 'failed'
            ? t('privacy.feeUnread', { defaultValue: 'Network fee unavailable. Try again.' })
            : t('privacy.feeNotCovered', {
                defaultValue: 'Insufficient public balance for network fee',
              })}
        </p>
      )}
    </Modal>
  );
}
