import { BIG_BUTTON } from 'src/features/wallet/add/StepParts';
import { FieldNote, PrimaryButton } from 'src/shared/ui/primitives';
import { ReviewHeading, SiteHead } from './ReviewParts';

const ReviewFrame = ({
  caps,
  origin,
  heading,
  children,
  error,
  cancel,
  action,
  onCancel,
  onAction,
  disabled = false,
  busy = false,
}: {
  caps: string;
  origin: string;
  heading: React.ReactNode;
  children: React.ReactNode;
  error?: string;
  cancel: string;
  action: string;
  onCancel: () => void;
  onAction: () => void;
  disabled?: boolean;
  busy?: boolean;
}) => (
  <div className="flex! h-full! w-full! flex-col! overflow-hidden! bg-(--bg)!">
    <div
      className="flex-1! overflow-y-auto! scrollbar-hide!"
      style={{ padding: '20px var(--gutter) 12px' }}
    >
      <div className="tab-caps" style={{ color: 'var(--fg-3)' }}>
        {caps}
      </div>
      <SiteHead origin={origin} />
      <ReviewHeading>{heading}</ReviewHeading>
      {children}
    </div>
    <div style={{ flexShrink: 0, padding: '8px var(--gutter) 20px' }}>
      <FieldNote tone="neg">{error ?? ''}</FieldNote>
      <div className="flex!" style={{ gap: '10px', marginTop: '6px' }}>
        <PrimaryButton secondary onClick={onCancel} disabled={busy} style={BIG_BUTTON}>
          {cancel}
        </PrimaryButton>
        <PrimaryButton onClick={onAction} loading={busy} disabled={disabled} style={BIG_BUTTON}>
          {action}
        </PrimaryButton>
      </div>
    </div>
  </div>
);

export default ReviewFrame;
