import { FieldNote } from 'src/shared/ui/primitives';

export const Caps = ({
  children,
  first = false,
  right,
}: {
  children: React.ReactNode;
  first?: boolean;
  right?: React.ReactNode;
}) => (
  <div
    className="flex! items-center! justify-between!"
    style={{ padding: `${first ? 0 : 18}px 4px 8px`, gap: '12px' }}
  >
    <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
      {children}
    </span>
    {right}
  </div>
);

export const Field = ({
  label,
  action,
  note,
  children,
}: {
  label: string;
  action?: React.ReactNode;
  note?: string | null;
  children: React.ReactNode;
}) => (
  <div style={{ marginBottom: '6px' }}>
    <div className="flex! items-center! justify-between!" style={{ marginBottom: '8px' }}>
      <span className="tab-caps" style={{ color: 'var(--fg-3)' }}>
        {label}
      </span>
      {action}
    </div>
    {children}
    <FieldNote tone="neg">{note ?? ''}</FieldNote>
  </div>
);
