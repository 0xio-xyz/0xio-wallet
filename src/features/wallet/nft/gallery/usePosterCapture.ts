import { useEffect, useSyncExternalStore } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { posterQueue, type PosterJob } from 'src/features/wallet/nft/euint/posterQueue';

const subscribeVisibility = (fn: () => void) => {
  document.addEventListener('visibilitychange', fn);
  return () => document.removeEventListener('visibilitychange', fn);
};
const isVisible = () => document.visibilityState === 'visible';

export function usePosterCapture(paused: boolean): PosterJob[] {
  const { networkId, activeWallet, isLocked } = useWallet();
  const address = activeWallet?.address ?? '';
  const visible = useSyncExternalStore(subscribeVisibility, isVisible);
  const scope = networkId && address ? `${networkId}:${address}` : null;
  const active = !!scope && visible && !isLocked && !paused;

  // effect:audited - pushes scope and run state into the module queue; leaving the gallery stops it.
  useEffect(() => {
    posterQueue.setScope(scope);
    posterQueue.setActive(active);
  }, [scope, active]);
  useEffect(() => () => posterQueue.setActive(false), []);

  return useSyncExternalStore(posterQueue.subscribe, posterQueue.frames);
}
