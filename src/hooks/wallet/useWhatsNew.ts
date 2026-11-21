import { useCallback, useEffect, useState } from 'react';
import {
  WHATS_NEW_PENDING_KEY,
  WHATS_NEW_SEEN_KEY,
  markWhatsNewSeen,
  readWhatsNewDue,
} from 'src/services/wallet/whatsNew';
import { logger } from 'src/utils/logger';

const useWhatsNew = (active: boolean) => {
  const [due, setDue] = useState(false);

  // effect:audited - reads the stored notice flags and follows later writes
  useEffect(() => {
    if (!active) return;
    let live = true;
    const check = () =>
      readWhatsNewDue()
        .then((d) => live && setDue(d))
        .catch(() => {});
    check();
    const onChanged = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === 'local' && (WHATS_NEW_PENDING_KEY in changes || WHATS_NEW_SEEN_KEY in changes))
        check();
    };
    chrome.storage.onChanged?.addListener(onChanged);
    return () => {
      live = false;
      chrome.storage.onChanged?.removeListener(onChanged);
    };
  }, [active]);

  const dismiss = useCallback(() => {
    setDue(false);
    markWhatsNewSeen().catch((e) => logger.warn('Could not save the notice as seen:', e));
  }, []);

  return { show: active && due, dismiss };
};

export default useWhatsNew;
