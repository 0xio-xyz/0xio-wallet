import { useEffect, useSyncExternalStore } from 'react';
import { networkService } from 'src/services/network/NetworkService';
import { resolveNetworkPin } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import type { TransactionHistoryItem } from 'src/types/transaction';

const CACHE_KEY = 'contract_methods_v2';
const LEGACY_KEY = 'contract_methods_cache';
const MAX_ENTRIES = 400;
const PER_PASS = 10;
const MAX_PASSES = 5;
const PASS_PAUSE_MS = 800;
const RETRY_MS = 60_000;

export const methodKey = (network: string, hash: string) => `${network}:${hash}`;

let methods: Record<string, string> = {};
let loaded: Promise<void> | null = null;
const inFlight = new Set<string>();
const failedAt = new Map<string, number>();
const listeners = new Set<() => void>();

const notify = () => listeners.forEach((fn) => fn());

function load(): Promise<void> {
  if (!loaded) {
    loaded = (async () => {
      try {
        const stored = (await chrome.storage.local.get([CACHE_KEY]))?.[CACHE_KEY];
        if (stored && typeof stored === 'object') {
          methods = { ...(stored as Record<string, string>), ...methods };
          notify();
        }
        chrome.storage.local.remove(LEGACY_KEY).catch(() => {});
      } catch {}
    })();
  }
  return loaded;
}

function remember(key: string, method: string) {
  const next = { ...methods };
  delete next[key];
  next[key] = method;
  const keys = Object.keys(next);
  for (const old of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES))) delete next[old];
  methods = next;
  try {
    chrome.storage.local.set({ [CACHE_KEY]: methods }).catch(() => {});
  } catch {}
  notify();
}

async function readMethod(network: string, hash: string): Promise<string | null> {
  const pin = await resolveNetworkPin(network as NetworkId);
  const receipt = await networkService.jsonRpcCall('contract_receipt', [hash], true, pin);
  return typeof receipt?.method === 'string' && receipt.method ? receipt.method : null;
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  void load();
  return () => listeners.delete(fn);
};
const snapshot = () => methods;

export const peekMethod = (network: string, hash: string): string | undefined =>
  methods[methodKey(network, hash)];

export function useContractMethods(
  transactions: TransactionHistoryItem[],
  fallbackNetwork: string
): Record<string, string> {
  const current = useSyncExternalStore(subscribe, snapshot);

  // effect:audited - reads receipts (external RPC) for calls this list still lacks, a few passes; cleanup stops them
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      await load();
      for (let pass = 0; pass < MAX_PASSES && !cancelled; pass++) {
        const now = Date.now();
        const missing = transactions
          .filter((tx) => tx.opType === 'call' && tx.hash)
          .map((tx) => ({ net: tx.network || fallbackNetwork, hash: tx.hash }))
          .filter(({ net, hash }) => {
            const key = methodKey(net, hash);
            return (
              !(key in methods) && !inFlight.has(key) && now - (failedAt.get(key) ?? 0) > RETRY_MS
            );
          })
          .slice(0, PER_PASS);
        if (!missing.length) break;
        let named = 0;
        for (const { net, hash } of missing) {
          if (cancelled) break;
          const key = methodKey(net, hash);
          inFlight.add(key);
          try {
            const method = await readMethod(net, hash);
            if (method) {
              remember(key, method);
              named++;
            } else failedAt.set(key, Date.now());
          } catch {
            failedAt.set(key, Date.now());
          } finally {
            inFlight.delete(key);
          }
        }
        if (!named) break;
        await new Promise((r) => setTimeout(r, PASS_PAUSE_MS));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [transactions, fallbackNetwork]);

  return current;
}

export function resetContractMethods(): void {
  methods = {};
  loaded = null;
  inFlight.clear();
  failedAt.clear();
}
