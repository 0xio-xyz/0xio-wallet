import { useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { useWallet } from 'src/contexts/WalletContext';
import { blockedAckKey, requestKeySwitchDetails } from 'src/shared/ui/KeySwitchOverlay';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import HomeTag from 'src/shared/ui/HomeTag';

const KeyBlockedTag = () => {
  const { t } = useTranslation();
  const { activeWallet, networkId, pvacForeign, setPvacForeign } = useWallet();
  const [ackReason, setAckReason] = useState<string | null>(null);

  useMountEffect(() => {
    if (!activeWallet?.address) return;
    const key = blockedAckKey(networkId ?? '', activeWallet.address);
    let disposed = false;
    chrome.storage.local
      .get(key)
      .then((r) => {
        if (!disposed) setAckReason(typeof r[key] === 'string' ? (r[key] as string) : null);
      })
      .catch(() => {});
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && key in changes) {
        const next = changes[key].newValue;
        setAckReason(typeof next === 'string' ? next : null);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => {
      disposed = true;
      chrome.storage.onChanged.removeListener(onChanged);
    };
  });

  if (!ackReason || pvacForeign) return null;

  return (
    <HomeTag
      tone="amber"
      title={ackReason}
      onClick={() => {
        requestKeySwitchDetails();
        setPvacForeign(true);
      }}
    >
      {t('privacy.keyBlockedTag', { defaultValue: 'Key update blocked' })}
    </HomeTag>
  );
};

export default KeyBlockedTag;
