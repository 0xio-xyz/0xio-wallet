import { useEffect, useRef, useState } from 'react';
import { feesUsd, fetchQuote, payRawOf, type QuoteMode } from 'src/services/bridge/relay/anyChain';

export const QUOTE_DELAY_MS = 600;

export interface QuoteRequest {
  user: string;
  originChainId: number;
  originCurrency: string;
  octraRecipient: string;
  amountRaw: string;
  mode: QuoteMode;
}

export interface LiveQuote {
  outRaw: string | null;
  payRaw: string | null;
  feesUsd: number | null;
  loading: boolean;
  failed: boolean;
}

export const quoteKey = (r: QuoteRequest | null): string =>
  r
    ? `${r.mode}|${r.user}|${r.originChainId}|${r.originCurrency}|${r.octraRecipient}|${r.amountRaw}`
    : '';

export function useLiveQuote(req: QuoteRequest | null): LiveQuote {
  const key = quoteKey(req);
  const route = req
    ? `${req.user}|${req.originChainId}|${req.originCurrency}|${req.octraRecipient}`
    : '';
  const [shown, setShown] = useState<{
    route: string;
    key: string;
    outRaw: string;
    payRaw: string | null;
    fees: number | null;
  } | null>(null);
  const [failedKey, setFailedKey] = useState('');
  const latest = useRef('');
  latest.current = key;
  const asking = useRef(req);
  asking.current = req;

  // effect:audited - asks the price service (external system) once typing pauses; a late answer
  // for an older request is dropped
  useEffect(() => {
    const r = asking.current;
    if (!r) return;
    const asked = key;
    const timer = setTimeout(() => {
      fetchQuote(r)
        .then((q) => {
          if (latest.current !== asked) return;
          setShown({
            route,
            key: asked,
            outRaw: q.outRaw,
            payRaw: payRawOf(q.quote),
            fees: feesUsd(q.quote),
          });
          setFailedKey('');
        })
        .catch(() => {
          if (latest.current === asked) setFailedKey(asked);
        });
    }, QUOTE_DELAY_MS);
    return () => clearTimeout(timer);
  }, [key, route]);

  const same = !!req && shown?.route === route;
  return {
    outRaw: same ? shown!.outRaw : null,
    payRaw: same ? shown!.payRaw : null,
    feesUsd: same ? shown!.fees : null,
    loading: !!req && shown?.key !== key && failedKey !== key,
    failed: !!req && failedKey === key,
  };
}
