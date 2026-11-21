import { useState, useRef, useEffect } from 'react';
import { getQuote } from './solverApi';
import type { SwapQuote, SwapAsset } from './types';

export function useSwapQuote(from: SwapAsset, to: SwapAsset, amount: string) {
  const [quote, setQuote] = useState<SwapQuote | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshNonce, setRefreshNonce] = useState(0);
  const epochRef = useRef(0);

  // effect:audited - external data sync: debounced solver quote fetch + 10s auto-refresh keyed on
  // (from, to, amount). Cannot be derived; genuine subscription with cleanup.
  useEffect(() => {
    const amt = parseFloat(amount);
    if (!amount || !Number.isFinite(amt) || amt <= 0) {
      setQuote(null);
      setLoading(false);
      return;
    }
    const myEpoch = ++epochRef.current;
    let cancelled = false;

    const fetchQuote = async () => {
      setLoading(true);
      try {
        const q = await getQuote({ from, to, amount });
        if (!cancelled && epochRef.current === myEpoch) {
          setQuote(q);
          setRefreshNonce((n) => n + 1);
        }
      } catch {
        if (!cancelled && epochRef.current === myEpoch) {
          setQuote({ error: 'Quote unavailable' });
          setRefreshNonce((n) => n + 1);
        }
      } finally {
        if (!cancelled && epochRef.current === myEpoch) setLoading(false);
      }
    };

    const debounce = setTimeout(fetchQuote, 500);
    const interval = setInterval(fetchQuote, 10_000);
    return () => {
      cancelled = true;
      clearTimeout(debounce);
      clearInterval(interval);
    };
  }, [from, to, amount]);

  return { quote, loading, refreshNonce };
}
