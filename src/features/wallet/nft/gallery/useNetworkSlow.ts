import { useEffect, useRef } from 'react';
import { networkService } from 'src/services/network/NetworkService';

export function useNetworkSlowNotice(onSlow: () => void) {
  const notify = useRef(onSlow);
  notify.current = onSlow;
  // effect:audited - polls an external flag the network layer keeps; no event to subscribe to.
  useEffect(() => {
    let wasSlow = false;
    const tick = () => {
      const now = networkService.isNetworkSlow();
      if (now && !wasSlow) notify.current();
      wasSlow = now;
    };
    tick();
    const id = setInterval(tick, 4000);
    return () => clearInterval(id);
  }, []);
}
