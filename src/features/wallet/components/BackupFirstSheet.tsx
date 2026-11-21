import { useNavigate } from 'src/lib/router';
import { useTranslation } from 'src/i18n/react';
import { PrimaryButton, Sheet, TextButton } from 'src/shared/ui/primitives';

const BackupFirstSheet = ({ open, onClose }: { open: boolean; onClose: () => void }) => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('backup.firstTitle', { defaultValue: 'Back up first' })}
      sub={t('backup.firstSub', {
        defaultValue:
          'Your recovery phrase is the only way to restore this wallet if this browser is lost.',
      })}
      footer={
        <div className="flex! flex-col! items-center!" style={{ gap: '6px' }}>
          <PrimaryButton
            onClick={() => navigate('/backup')}
            style={{ height: '48px', borderRadius: '12px', fontSize: '14px' }}
          >
            {t('backup.now', { defaultValue: 'Back up now' })}
          </PrimaryButton>
          <TextButton
            muted
            size={14}
            onClick={() => navigate('/receive')}
            style={{ height: '40px', fontWeight: 600, color: 'var(--fg-2)' }}
          >
            {t('backup.showAnyway', { defaultValue: 'Show address anyway' })}
          </TextButton>
        </div>
      }
    />
  );
};

export default BackupFirstSheet;
