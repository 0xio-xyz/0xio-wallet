export const OctraGlyph = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
    <circle cx="12" cy="12" r="7.5" fill="none" stroke="currentColor" strokeWidth="3.6" />
  </svg>
);

export const EvmGlyph = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" aria-hidden="true" style={{ flexShrink: 0 }}>
    <path d="M12 2 5.5 12.3 12 16.2l6.5-3.9Z" fill="currentColor" />
    <path d="M5.5 13.6 12 22l6.5-8.4-6.5 3.9Z" fill="currentColor" opacity=".7" />
  </svg>
);
