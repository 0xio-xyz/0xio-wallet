import { useEffect, useRef, useState } from 'react';
import { resolveWallet, type OnsWallet } from 'src/services/names/ons';
import { resolveNetworkPin } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import type { OnsFailure } from 'src/utils/octra/ons';
import { isNameEntry, typedNameLabel } from 'src/features/transactions/onsRecipient';
import { useOnsContract } from 'src/hooks/wallet/useOnsContract';

export const NAME_LOOKUP_DELAY_MS = 250;
export const NAME_TAKE_PAUSE_MS = 1000;

export type NameLookup =
  | { state: 'off' }
  | { state: 'resolving'; label: string }
  | { state: 'resolved'; label: string; name: string; address: string }
  | { state: 'failed'; label: string; reason: OnsFailure };

export function useNameLookup(
  text: string,
  networkId: NetworkId,
  enabled = true,
  onResolved?: (name: string, address: string) => void
): { lookup: NameLookup; retry: () => void } {
  const contract = useOnsContract(networkId);
  const on = enabled && contract !== null && isNameEntry(text, networkId);
  const key = on ? `${networkId}|${contract}|${text}` : '';
  const [answer, setAnswer] = useState<{ key: string; value: OnsWallet } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const resolved = useRef(onResolved);
  resolved.current = onResolved;

  // effect:audited - one name read per network and text, after a pause in typing.
  useEffect(() => {
    if (!key) return;
    let alive = true;
    const since = Date.now();
    let take: ReturnType<typeof setTimeout> | undefined;
    const timer = setTimeout(() => {
      resolveNetworkPin(networkId)
        .then((at) => resolveWallet(text, { at }))
        .catch((): OnsWallet => ({ ok: false, reason: 'unavailable' }))
        .then((value) => {
          if (!alive) return;
          setAnswer({ key, value });
          if (value.ok !== true) return;
          const { name, address } = value;
          take = setTimeout(
            () => alive && resolved.current?.(name, address),
            Math.max(0, NAME_TAKE_PAUSE_MS - (Date.now() - since))
          );
        });
    }, NAME_LOOKUP_DELAY_MS);
    return () => {
      alive = false;
      clearTimeout(timer);
      clearTimeout(take);
    };
  }, [key, attempt, networkId, text]);

  const retry = () => {
    setAnswer(null);
    setAttempt((n) => n + 1);
  };

  if (!on) return { lookup: { state: 'off' }, retry };
  const label = typedNameLabel(text);
  if (!answer || answer.key !== key) return { lookup: { state: 'resolving', label }, retry };
  const { value } = answer;
  return {
    lookup:
      value.ok === true
        ? { state: 'resolved', label, name: value.name, address: value.address }
        : { state: 'failed', label, reason: value.reason },
    retry,
  };
}
