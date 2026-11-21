import { useEffect, useState } from 'react';
import { networkService } from 'src/services/network/NetworkService';
import { resolveNetworkPin } from 'src/services/network/txScope';
import {
  FEE_LIVE_MS,
  FEE_SIGN_MS,
  type FeeQuote,
  type FeeRead,
} from 'src/services/network/feeQuotes';
import { feeView, onFeeWake, type FeeView } from 'src/hooks/wallet/useLiveFee';
import type { NetworkId } from 'src/utils/config';

export type PrivacyFeeOp = 'encrypt' | 'decrypt' | 'claim';
export type PrivacyFeeQuote = FeeQuote;

const OPS: PrivacyFeeOp[] = ['encrypt', 'decrypt', 'claim'];

type Reads = Record<PrivacyFeeOp, FeeRead>;

const failed: FeeRead = { kind: 'failed', kept: null };

async function readAll(networkId: NetworkId, maxAgeMs?: number): Promise<Reads> {
  const out = {} as Reads;
  let pin;
  try {
    pin = await resolveNetworkPin(networkId);
  } catch {
    return { encrypt: failed, decrypt: failed, claim: failed };
  }
  for (const op of OPS) {
    out[op] = await networkService.readFeeQuote(op, pin, { maxAgeMs }).catch(() => failed);
  }
  return out;
}

export function usePrivacyFees(
  networkId: NetworkId,
  reviewing: PrivacyFeeOp | null = null
): {
  fees: Record<PrivacyFeeOp, PrivacyFeeQuote | null> | null;
  view: (op: PrivacyFeeOp) => FeeView;
  retry: () => void;
  fresh: (op: PrivacyFeeOp) => Promise<PrivacyFeeQuote | null>;
} {
  const [shown, setShown] = useState<{ key: string; reads: Reads; seenAt: number } | null>(null);
  const [revision, setRevision] = useState(0);
  const key = networkId;

  // effect:audited - fee reads from the node (external system) on open, on retry and when the popup comes back after 30s
  useEffect(() => {
    let live = true;
    let last = 0;
    const run = () => {
      last = Date.now();
      void readAll(networkId).then((reads) => {
        if (live) setShown({ key, reads, seenAt: Date.now() });
      });
    };
    run();
    const stop = onFeeWake(() => last, run);
    return () => {
      live = false;
      stop();
    };
  }, [key, networkId, revision]);

  // effect:audited - keeps the reviewed op's quote live (one external read every 30s) only while its review is open
  useEffect(() => {
    if (!reviewing) return;
    let live = true;
    const timer = setInterval(() => {
      if (document.hidden) return;
      void resolveNetworkPin(networkId)
        .then((pin) => networkService.readFeeQuote(reviewing, pin))
        .catch(() => failed)
        .then((read) => {
          if (!live) return;
          setShown((s) =>
            s?.key === key
              ? { ...s, reads: { ...s.reads, [reviewing]: read }, seenAt: Date.now() }
              : s
          );
        });
    }, FEE_LIVE_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [reviewing, key, networkId]);

  const current = shown?.key === key ? shown : null;
  const view = (op: PrivacyFeeOp) => feeView(current?.reads[op] ?? null, current?.seenAt ?? 0);
  return {
    fees: current
      ? {
          encrypt: view('encrypt').quote,
          decrypt: view('decrypt').quote,
          claim: view('claim').quote,
        }
      : null,
    view,
    retry: () => {
      setShown(null);
      setRevision((r) => r + 1);
    },
    fresh: async (op) => {
      const pin = await resolveNetworkPin(networkId);
      const read = await networkService
        .readFeeQuote(op, pin, { maxAgeMs: FEE_SIGN_MS })
        .catch(() => failed);
      setShown((s) => (s?.key === key ? { ...s, reads: { ...s.reads, [op]: read } } : s));
      return read.kind === 'quote' ? read.quote : null;
    },
  };
}
