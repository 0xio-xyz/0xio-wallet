import { useSyncExternalStore } from 'react';
import { isEvmOn } from 'src/services/evm/walletEvm';
import { useWallet } from 'src/contexts/WalletContext';

export type HomeView = 'all' | 'oct' | 'evm';

const KEY = 'oxio_home_view';
const listeners = new Set<() => void>();

const read = (): HomeView => {
  try {
    const v = localStorage.getItem(KEY);
    return v === 'all' || v === 'evm' || v === 'oct' ? v : 'all';
  } catch {
    return 'all';
  }
};

let current: HomeView = read();

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export const setHomeView = (view: HomeView) => {
  current = view;
  try {
    localStorage.setItem(KEY, view);
  } catch {}
  listeners.forEach((fn) => fn());
};

export const useHomeView = () => {
  const { activeWallet, wallets } = useWallet();
  const picked = useSyncExternalStore(subscribe, () => current);
  const evm = activeWallet?.metadata?.evm;
  const evmOn = isEvmOn(activeWallet, wallets);
  return {
    view: evmOn ? picked : ('oct' as HomeView),
    evmOn,
    evmAddress: evmOn ? (evm?.address ?? null) : null,
    setView: setHomeView,
  };
};
