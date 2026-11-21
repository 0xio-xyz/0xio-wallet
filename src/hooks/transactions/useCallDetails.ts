import { useEffect, useState, useSyncExternalStore } from 'react';
import { networkService } from 'src/services/network/NetworkService';
import { resolveNetworkPin } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import {
  contractNamesVersion,
  evmCallCut,
  fetchEvmTxDetail,
  lookupContractName,
  peekContractName,
  peekEvmTxDetail,
  subscribeContractNames,
  type EvmCall,
} from 'src/services/evm/callDetail';
import { keylessApiBase, type EvmHistoryItem } from 'src/services/evm/history';
import type { TransactionHistoryItem } from 'src/types/transaction';
import { BoundedCache, readableMethod } from 'src/utils/callReading';
import { abiParamNames } from 'src/utils/callArgs';
import { registerSessionCache } from 'src/utils/sessionCaches';

interface OctraDetail {
  args: unknown[] | null;
  ou: string | null;
}

const octraDetails = new BoundedCache<OctraDetail>(100);
registerSessionCache(() => octraDetails.clear());

export function octraCallArgs(message: unknown): unknown[] | null {
  if (typeof message !== 'string' || !message) return null;
  try {
    const parsed = JSON.parse(message);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readOctraDetail(network: string, hash: string): Promise<OctraDetail> {
  const pin = await resolveNetworkPin(network as NetworkId);
  const tx = await networkService.jsonRpcCall('octra_transaction', [hash], true, pin);
  const body = tx?.parsed_tx ?? tx;
  const ou = body?.ou ?? tx?.ou;
  return {
    args: octraCallArgs(body?.message),
    ou: ou != null && /^\d+$/.test(String(ou)) ? String(ou) : null,
  };
}

export function useOctraCallDetail(
  tx: TransactionHistoryItem | null,
  network: string
): OctraDetail & { loading: boolean } {
  const key = tx?.opType === 'call' && tx.hash && !tx.pending ? `${network}:${tx.hash}` : null;
  const [state, setState] = useState<{ key: string; detail: OctraDetail | null } | null>(null);

  // effect:audited - reads one transaction (external RPC) for the open sheet; cleanup drops a late answer
  useEffect(() => {
    if (!key || !tx || octraDetails.has(key)) return;
    let cancelled = false;
    readOctraDetail(network, tx.hash)
      .then((detail) => {
        octraDetails.set(key, detail);
        if (!cancelled) setState({ key, detail });
      })
      .catch(() => {
        if (!cancelled) setState({ key, detail: null });
      });
    return () => {
      cancelled = true;
    };
  }, [key, network, tx]);

  const cached = key ? octraDetails.get(key) : undefined;
  const detail = cached ?? (state?.key === key ? state.detail : null);
  return {
    args: detail?.args ?? null,
    ou: detail?.ou ?? null,
    loading: !!key && !cached && state?.key !== key,
  };
}

type AbiNames = Record<string, string[]>;

const ABI_RETRY_MS = 60_000;
const abiNames = new BoundedCache<{ names: AbiNames | null; at: number }>(50);
const abiInFlight = new Map<string, Promise<void>>();
const abiListeners = new Set<() => void>();
let abiVersion = 0;
registerSessionCache(() => {
  abiNames.clear();
  abiInFlight.clear();
  abiVersion++;
});

export const abiKey = (network: string, contract: string) => `${network}:${contract}`;

export function peekAbiNames(network: string, contract: string): AbiNames | null | undefined {
  const hit = abiNames.get(abiKey(network, contract));
  if (!hit) return undefined;
  if (!hit.names && Date.now() - hit.at > ABI_RETRY_MS) return undefined;
  return hit.names;
}

export function loadAbiNames(network: string, contract: string): Promise<void> {
  const key = abiKey(network, contract);
  if (peekAbiNames(network, contract) !== undefined) return Promise.resolve();
  const running = abiInFlight.get(key);
  if (running) return running;
  const p = (async () => {
    let names: AbiNames | null = null;
    try {
      const pin = await resolveNetworkPin(network as NetworkId);
      names = abiParamNames(
        await networkService.jsonRpcCall('octra_contractAbi', [contract], true, pin)
      );
    } catch {
      names = null;
    }
    if (abiInFlight.get(key) === p) {
      abiNames.set(key, { names, at: Date.now() });
      abiVersion++;
      abiListeners.forEach((fn) => fn());
    }
  })().finally(() => {
    if (abiInFlight.get(key) === p) abiInFlight.delete(key);
  });
  abiInFlight.set(key, p);
  return p;
}

const subscribeAbi = (fn: () => void) => {
  abiListeners.add(fn);
  return () => abiListeners.delete(fn);
};

export function useOctraAbiNames(
  network: string,
  contract: string | null,
  method: string | null
): { names: string[] | null; loading: boolean } {
  useSyncExternalStore(subscribeAbi, () => abiVersion);
  const peek = contract ? peekAbiNames(network, contract) : null;

  // effect:audited - reads one contract's ABI (external RPC) the cache lacks; the store re-renders on arrival
  useEffect(() => {
    if (contract && peek === undefined) void loadAbiNames(network, contract);
  }, [network, contract, peek]);

  return {
    names: method && peek ? (peek[method] ?? null) : null,
    loading: !!contract && peek === undefined,
  };
}

export function useEvmContractNames(
  chainId: number,
  addresses: readonly (string | null | undefined)[],
  explorerUrl: string
): Record<string, string | null> {
  useSyncExternalStore(subscribeContractNames, contractNamesVersion);
  const wanted = [...new Set(addresses.filter((a): a is string => !!a))];
  const missing = wanted.filter((a) => peekContractName(chainId, a) === undefined).join(',');

  // effect:audited - looks up names (external explorer) the cache lacks; the store re-renders on arrival
  useEffect(() => {
    if (!missing) return;
    let cancelled = false;
    void (async () => {
      const base = await keylessApiBase(chainId, explorerUrl);
      if (!base) return;
      for (const address of missing.split(',')) {
        if (cancelled) break;
        await lookupContractName(chainId, address, base);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [chainId, missing, explorerUrl]);

  const out: Record<string, string | null> = {};
  for (const a of wanted) out[a.toLowerCase()] = peekContractName(chainId, a) ?? null;
  return out;
}

export function useEvmCallContract(item: EvmHistoryItem): string | null {
  const call = item.call ?? null;
  const listed = call?.token?.symbol ?? null;
  const names = useEvmContractNames(
    item.chainId,
    call && !listed ? [call.contract] : [],
    item.explorerUrl
  );
  if (!call) return null;
  return listed ?? names[call.contract.toLowerCase()] ?? null;
}

export function useEvmTxDetail(item: EvmHistoryItem | null): {
  call: EvmCall | null;
  fee: string | null;
  loading: boolean;
} {
  const listed = item?.call ?? null;
  const cut = evmCallCut(listed);
  const needs = !!item && ((!!listed && (!listed.params || cut)) || !item.fee);
  const key = needs && item ? `${item.chainId}:${item.hash}` : null;
  const [done, setDone] = useState<string | null>(null);

  // effect:audited - reads one transaction (external explorer) for the open sheet; cleanup drops a late answer
  useEffect(() => {
    if (!key || !item || peekEvmTxDetail(item.chainId, item.hash)) return;
    let cancelled = false;
    void (async () => {
      const base = await keylessApiBase(item.chainId, item.explorerUrl);
      if (base) await fetchEvmTxDetail(item.chainId, item.hash, base);
      if (!cancelled) setDone(key);
    })();
    return () => {
      cancelled = true;
    };
  }, [key, item]);

  const read = item ? peekEvmTxDetail(item.chainId, item.hash) : undefined;
  const full = read?.call ?? null;
  const merged: EvmCall | null = listed
    ? {
        ...listed,
        method: readableMethod(listed.method) ? listed.method : (full?.method ?? listed.method),
        signature: listed.signature ?? full?.signature ?? null,
        params: (cut ? full?.params : null) ?? listed.params ?? full?.params ?? null,
        input:
          full?.input && full.input.length > (listed.input?.length ?? 0)
            ? full.input
            : (listed.input ?? null),
      }
    : null;
  const call =
    merged?.input && merged.input.length === 10 && evmCallCut(merged)
      ? { ...merged, input: `${merged.input}…` }
      : merged;
  return {
    call,
    fee: item?.fee ?? read?.fee ?? null,
    loading: !!key && !read && done !== key,
  };
}
