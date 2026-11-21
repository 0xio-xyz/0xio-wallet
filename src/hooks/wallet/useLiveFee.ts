import { useEffect, useState } from 'react';
import { networkService } from 'src/services/network/NetworkService';
import { resolveNetworkPin } from 'src/services/network/txScope';
import {
  FEE_LIVE_MS,
  FEE_SIGN_MS,
  type FeeQuote,
  type FeeRead,
} from 'src/services/network/feeQuotes';
import type { NetworkId } from 'src/utils/config';
import type { FeeState } from 'src/shared/ui/FeeValue';

export type LiveFeeQuote = FeeQuote;

export interface FeeView {
  quote: LiveFeeQuote | null;
  state: FeeState;
  ageMs: number | null;
}

export function feeView(read: FeeRead | null, seenAt: number): FeeView {
  if (!read) return { quote: null, state: 'loading', ageMs: null };
  if (read.kind === 'quote') return { quote: read.quote, state: 'ready', ageMs: null };
  if (read.kind === 'unsupported') return { quote: null, state: 'unsupported', ageMs: null };
  if (read.kept) return { quote: read.kept.quote, state: 'stale', ageMs: seenAt - read.kept.at };
  return { quote: null, state: 'failed', ageMs: null };
}

const readNow = async (op: string, networkId: NetworkId, maxAgeMs?: number): Promise<FeeRead> => {
  try {
    return await networkService.readFeeQuote(op, await resolveNetworkPin(networkId), { maxAgeMs });
  } catch {
    return { kind: 'failed', kept: null };
  }
};

export function onFeeWake(lastReadAt: () => number, read: () => void): () => void {
  const wake = () => {
    if (!document.hidden && Date.now() - lastReadAt() > FEE_LIVE_MS) read();
  };
  document.addEventListener('visibilitychange', wake);
  window.addEventListener('focus', wake);
  return () => {
    document.removeEventListener('visibilitychange', wake);
    window.removeEventListener('focus', wake);
  };
}

export function useLiveFee(
  op: string,
  networkId: NetworkId,
  reviewing = false
): FeeView & { retry: () => void; fresh: () => Promise<LiveFeeQuote | null> } {
  const scope = `${networkId}:${op}`;
  const [revision, setRevision] = useState(0);
  const [shown, setShown] = useState<{ scope: string; read: FeeRead; seenAt: number } | null>(null);

  // effect:audited - fee read from the node (external system) on open, on retry and when the popup comes back after 30s
  useEffect(() => {
    let live = true;
    let last = 0;
    const run = () => {
      last = Date.now();
      void readNow(op, networkId).then((read) => {
        if (live) setShown({ scope, read, seenAt: Date.now() });
      });
    };
    run();
    const stop = onFeeWake(() => last, run);
    return () => {
      live = false;
      stop();
    };
  }, [scope, networkId, op, revision]);

  // effect:audited - keeps the quote live (external reads, one op every 30s) only while a review is open
  useEffect(() => {
    if (!reviewing) return;
    let live = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void readNow(op, networkId).then((read) => {
        if (live) setShown({ scope, read, seenAt: Date.now() });
      });
    }, FEE_LIVE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [reviewing, scope, networkId, op]);

  const current = shown?.scope === scope ? shown : null;
  return {
    ...feeView(current?.read ?? null, current?.seenAt ?? 0),
    retry: () => {
      setShown(null);
      setRevision((r) => r + 1);
    },
    fresh: async () => {
      const read = await readNow(op, networkId, FEE_SIGN_MS);
      setShown({ scope, read, seenAt: Date.now() });
      return read.kind === 'quote' ? read.quote : null;
    },
  };
}
