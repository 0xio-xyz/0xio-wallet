import { ONS_SUFFIX } from 'src/utils/octra/ons';
import { usePrimaryName } from 'src/hooks/wallet/usePrimaryName';

const PrimaryName = ({ name }: { name: string | null }) =>
  name ? (
    <span
      className="animate-in fade-in duration-200"
      style={{ fontWeight: 500, color: 'var(--fg-2)', whiteSpace: 'nowrap', flexShrink: 0 }}
    >
      {name}
      {ONS_SUFFIX}
    </span>
  ) : null;

export const NamedAddress = ({
  address,
  networkId,
  children,
}: {
  address: string;
  networkId: string;
  children: React.ReactNode;
}) => {
  const primary = usePrimaryName(address, networkId);
  return (
    <span ref={primary.ref} className="flex! items-center! min-w-0!" style={{ gap: '8px' }}>
      <PrimaryName name={primary.name} />
      {children}
    </span>
  );
};

export default PrimaryName;
