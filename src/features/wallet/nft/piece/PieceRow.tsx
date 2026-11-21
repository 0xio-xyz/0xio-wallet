export function PieceRow({
  label,
  children,
  onClick,
}: {
  label: string;
  children: React.ReactNode;
  onClick?: () => void;
}) {
  return (
    <div
      onClick={onClick}
      className="flex! justify-between!"
      style={{
        gap: '14px',
        padding: '11px 0',
        fontSize: '13px',
        cursor: onClick ? 'pointer' : undefined,
      }}
    >
      <span style={{ color: 'var(--fg-3)', flexShrink: 0 }}>{label}</span>
      <span
        className="text-right! min-w-0!"
        style={{ color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}
      >
        {children}
      </span>
    </div>
  );
}

export function PieceTraits({ traits }: { traits: [string, string][] }) {
  if (traits.length === 0) return null;
  return (
    <div className="grid! grid-cols-3!" style={{ gap: '6px' }}>
      {traits.map(([k, v], i) => (
        <div
          key={`${k}${i}`}
          className="flex! flex-col! min-w-0! bg-(--bg-1)!"
          style={{ borderRadius: '12px', padding: '8px 10px', gap: '2px' }}
        >
          <span className="truncate!" style={{ fontSize: '11px', color: 'var(--fg-3)' }}>
            {k}
          </span>
          <span
            className="truncate!"
            style={{ fontSize: '13px', fontWeight: 600, color: 'var(--fg)' }}
          >
            {v}
          </span>
        </div>
      ))}
    </div>
  );
}
