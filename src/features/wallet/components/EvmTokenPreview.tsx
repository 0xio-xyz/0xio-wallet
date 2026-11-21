import { useTranslation } from 'src/i18n/react';
import type { EvmTokenImport } from 'src/hooks/wallet/useEvmTokenImport';
import { EvmTokenIcon } from 'src/features/wallet/components/TokenList';
import { Facts, ListRow, RuledList } from 'src/shared/ui/primitives';

export const EvmTokenPreview = ({ imp }: { imp: EvmTokenImport }) => {
  const { t } = useTranslation();
  const token = imp.preview;
  if (!token) return null;
  return (
    <RuledList style={{ marginTop: '12px' }}>
      <ListRow
        leading={<EvmTokenIcon row={{ chainId: token.chainId, token }} size={28} />}
        label={token.name}
        sub={
          <Facts>
            <span>{token.symbol}</span>
            <span>
              {t('evmTokens.decimals', {
                count: token.decimals,
                defaultValue: '{{count}} decimals',
              })}
            </span>
          </Facts>
        }
        right={
          imp.balance !== null ? (
            <span
              style={{ fontSize: '13px', color: 'var(--fg)', fontVariantNumeric: 'tabular-nums' }}
            >
              {imp.balance}
            </span>
          ) : undefined
        }
        chevron={false}
      />
    </RuledList>
  );
};
