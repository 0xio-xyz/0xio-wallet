import { useCallback } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { useDesktopSync } from 'src/hooks/wallet/useDesktopSync';

export function useStartDesktopPairing() {
  const { t } = useTranslation();
  const { showMessage } = useWallet();
  const { pair, pairing } = useDesktopSync();
  return useCallback(async () => {
    if (pairing) return;
    const result = await pair();
    const notes: Record<string, string> = {
      outdated: t('toast.desktopOutdated', { defaultValue: 'Update 0xio Desktop to pair.' }),
      absent: t('toast.desktopNotFound', { defaultValue: '0xio Desktop is not open.' }),
      failed: t('toast.desktopPairFailed', {
        defaultValue: 'Could not pair with 0xio Desktop. Try again.',
      }),
    };
    if (notes[result]) showMessage(notes[result], 'info');
  }, [pair, pairing, showMessage, t]);
}
