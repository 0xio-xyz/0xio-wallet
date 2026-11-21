import { useTranslation } from 'src/i18n/react';
import Header from 'src/shared/ui/Header';
import { Mascot, type MascotMood } from 'src/shared/ui/Mascot';
import { PrimaryButton, TextButton } from 'src/shared/ui/primitives';
import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';

/** What follows a broadcast: no way back to the form, since a second tap would send twice. */
const SendResult = ({
  mood,
  title,
  line,
  note,
  link,
  onDone,
  doneDisabled = false,
}: {
  mood: MascotMood;
  title: string;
  line: React.ReactNode;
  note?: React.ReactNode;
  link?: string | null;
  onDone: () => void;
  doneDisabled?: boolean;
}) => {
  const { t } = useTranslation();
  return (
    <div className="flex! h-full! flex-col! bg-(--bg)! animate-in! fade-in! duration-200!">
      <Header title={t('action.send')} showSettings={false} />
      <div
        className="flex! flex-1! flex-col! items-center! justify-center! text-center!"
        style={{ gap: '14px', padding: '0 var(--gutter)' }}
      >
        <Mascot mood={mood} size={56} />
        <div style={{ fontSize: '20px', fontWeight: 300, color: 'var(--fg)' }}>{title}</div>
        <div style={{ fontSize: '12.5px', color: 'var(--fg-3)', lineHeight: 1.5 }}>{line}</div>
        {note && (
          <div
            style={{ fontSize: '11.5px', color: 'var(--fg-3)', lineHeight: 1.5, maxWidth: '280px' }}
          >
            {note}
          </div>
        )}
        {link && (
          <TextButton onClick={() => window.open(link, '_blank', 'noopener')}>
            {t('evmSend.viewExplorer', { defaultValue: 'View on explorer' })}
          </TextButton>
        )}
      </div>
      <div style={{ padding: '0 var(--gutter) 20px' }}>
        <PrimaryButton onClick={onDone} disabled={doneDisabled} style={BIG_BUTTON}>
          {t('common.done', { defaultValue: 'Done' })}
        </PrimaryButton>
      </div>
    </div>
  );
};

export default SendResult;
