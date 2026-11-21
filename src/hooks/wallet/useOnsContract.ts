import { useEffect, useSyncExternalStore } from 'react';
import {
  ONS_LIST_TTL_MS,
  ONS_RETRY_MS,
  loadOnsContract,
  onsContract,
  subscribeOnsContract,
} from 'src/services/names/ons';
import { resolveNetworkPin } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import { onsListNetwork } from 'src/utils/octra/ons';

export function useOnsContract(networkId: string | null | undefined): string | null {
  const id = networkId && onsListNetwork(networkId) ? networkId : '';

  // effect:audited - the name contract of a network is read from the list and checked on chain.
  useEffect(() => {
    if (!id) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const read = () => {
      resolveNetworkPin(id as NetworkId)
        .then(loadOnsContract)
        .then((r) => r.state)
        .catch(() => 'unknown' as const)
        .then((state) => {
          if (alive) timer = setTimeout(read, state === 'unknown' ? ONS_RETRY_MS : ONS_LIST_TTL_MS);
        });
    };
    read();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [id]);

  return useSyncExternalStore(subscribeOnsContract, () => (id ? onsContract(id) : null));
}
