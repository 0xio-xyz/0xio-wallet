import { Search } from 'src/shared/ui/icons';

const HeaderPill = ({
  label,
  count = 0,
  ariaLabel,
  onClick,
}: {
  label: string;
  count?: number;
  ariaLabel?: string;
  onClick: () => void;
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={ariaLabel ?? label}
    className="press flex! items-center! rounded-full! bg-(--bg-1)! hover:bg-(--bg-2)! animate-in! fade-in! duration-200!"
    style={{
      height: '28px',
      padding: count > 0 ? '0 4px 0 12px' : '0 12px',
      gap: '8px',
      border: 'none',
      cursor: 'pointer',
      boxShadow: 'var(--raise-shadow)',
      whiteSpace: 'nowrap',
      transition: 'background-color 200ms ease-out',
    }}
  >
    <span className="tab-caps" style={{ color: 'var(--fg)' }}>
      {label}
    </span>
    {count > 0 && (
      <span
        className="grid! place-items-center! rounded-full! animate-in! fade-in! duration-200!"
        style={{
          minWidth: '20px',
          height: '20px',
          padding: '0 6px',
          background: 'var(--accent)',
          color: 'var(--accent-fg)',
          fontSize: '11px',
          fontWeight: 700,
          fontVariantNumeric: 'tabular-nums',
        }}
      >
        {count}
      </span>
    )}
  </button>
);

export const FindButton = ({ label, onClick }: { label: string; onClick: () => void }) => (
  <button
    type="button"
    onClick={onClick}
    aria-label={label}
    title={label}
    className="press grid! place-items-center! rounded-full! bg-(--bg-1)! hover:bg-(--bg-2)!"
    style={{
      width: '28px',
      height: '28px',
      border: 'none',
      cursor: 'pointer',
      color: 'var(--fg)',
      boxShadow: 'var(--raise-shadow)',
      transition: 'background-color 200ms ease-out',
    }}
  >
    <Search size={13} />
  </button>
);

export default HeaderPill;
