import { useTranslation } from 'src/i18n/react';
import { Sheet } from 'src/shared/ui/primitives';

const PrivateHoldSheet = ({
  open,
  reason,
  onClose,
}: {
  open: boolean;
  reason: string | null;
  onClose: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <Sheet
      open={open}
      onClose={onClose}
      title={t('privateHold.title', { defaultValue: 'Private balance on hold' })}
    >
      <div className="flex! flex-col!" style={{ gap: '14px', padding: '0 0 8px' }}>
        <p style={{ margin: 0, fontSize: '13px', lineHeight: 1.55, color: 'var(--fg-2)' }}>
          {t('privateHold.body', {
            defaultValue:
              "This wallet's private balance is in the network's old format and waits for a network migration. Your public balance works as usual and nothing is lost. 0xio checks again each time you open the wallet.",
          })}
        </p>
        {reason && (
          <div className="flex! flex-col!" style={{ gap: '4px' }}>
            <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
              {t('privateHold.why', { defaultValue: 'Why' })}
            </span>
            <span style={{ fontSize: '12px', lineHeight: 1.5, color: 'var(--fg-3)' }}>
              {reason}
            </span>
          </div>
        )}
      </div>
    </Sheet>
  );
};

export default PrivateHoldSheet;
