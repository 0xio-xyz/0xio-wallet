import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { PrimaryButton, Sheet, TextButton } from 'src/shared/ui/primitives';

const MoveFundsSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('main.moveFundsTitle', { defaultValue: 'Move your funds' })}
      sub={t('main.moveFundsLead', {
        defaultValue:
          'This wallet was imported from a padded key, which other wallets may read differently. Send its funds to a new wallet.',
      })}
      footer={
        <div className="flex! flex-col! items-center!" style={{ gap: '6px' }}>
          <PrimaryButton
            onClick={() => navigate('/send')}
            style={{ height: '48px', borderRadius: '12px', fontSize: '14px' }}
          >
            {t('main.moveFundsSend', { defaultValue: 'Send to a new wallet' })}
          </PrimaryButton>
          <TextButton
            muted
            size={14}
            onClick={onClose}
            style={{ height: '40px', fontWeight: 600, color: 'var(--fg-2)' }}
          >
            {t('main.notNow', { defaultValue: 'Not now' })}
          </TextButton>
        </div>
      }
    />
  );
};

export default MoveFundsSheet;
