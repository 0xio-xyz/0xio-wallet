import { useTranslation } from 'src/i18n/react';

export function useItemsLabel() {
  const { t } = useTranslation();
  return {
    items: (n: number) => t('nft.itemCount', { count: n, defaultValue: '{{count}} items' }),
    pieces: (n: number) => t('nft.pieceCount', { count: n, defaultValue: '{{count}} pieces' }),
  };
}
