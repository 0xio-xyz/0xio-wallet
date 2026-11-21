export const OutlineTag = ({ label }: { label: string }) => (
  <span
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      height: '18px',
      padding: '0 7px',
      borderRadius: '9px',
      fontSize: '10px',
      fontWeight: 600,
      color: 'var(--fg-2)',
      boxShadow: 'inset 0 0 0 1px var(--line-2)',
      flexShrink: 0,
    }}
  >
    {label}
  </span>
);

export default OutlineTag;
