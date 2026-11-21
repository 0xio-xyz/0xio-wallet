import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import useMountEffect from 'src/hooks/ui/useMountEffect';
import { resolveNetworkPin } from 'src/services/network/txScope';
import {
  cachedHoldings,
  forgetImported,
  getImportedAddresses,
  isContractToken,
  loadTokenList,
  octraHoldingsScope,
  octraTokenSpam,
  peekTokenList,
  readCachedTokenList,
  readOctraHoldings,
  saveImportedAddresses,
  storeHoldings,
  tokensForNetwork,
  type ContractToken,
  type ListedToken,
  type OctraHoldings,
  type TokenListEntry,
} from 'src/services/tokens/octraTokens';
import { octraVisKey, readVisibility } from 'src/services/tokens/tokenVisibility';
import { tokenShown } from 'src/services/tokens/tokenSpam';
import { useTokenVisibility } from 'src/hooks/wallet/useTokenPrefs';
import { networkCapabilities } from 'src/utils/network';
import type { NetworkId } from 'src/utils/config';
import { logger } from 'src/utils/logger';

const POLL_MS = 30_000;

export type HoldingsState = 'known' | 'loading' | 'failed';

export interface OctraTokens {
  tokens: ListedToken[];
  listed: ListedToken[];
  logoByAddress: Map<string, string>;
  listLoading: boolean;
  listUnavailable: boolean;
  balances: Record<string, string> | null;
  imported: ContractToken[] | null;
  detected: ContractToken[];
  held: ContractToken[] | null;
  state: HoldingsState;
  refresh: () => Promise<void>;
  reloadImported: () => void;
  removeImported: (contract: string) => Promise<void>;
}

interface Held {
  scope: string;
  data: OctraHoldings | null;
  failed: boolean;
}

export function useOctraTokens(
  address: string | null | undefined,
  networkId: NetworkId | null | undefined,
  enabled = true
): OctraTokens {
  const scope = address && networkId ? octraHoldingsScope(networkId, address) : '';
  const [list, setList] = useState<TokenListEntry | null>(() => peekTokenList());
  const [listDone, setListDone] = useState(() => !!peekTokenList());
  const [held, setHeld] = useState<Held>(() => ({
    scope,
    data: scope ? (cachedHoldings(scope) ?? null) : null,
    failed: false,
  }));
  const [tick, setTick] = useState(0);

  const loadList = useCallback(async () => {
    const cached = await readCachedTokenList();
    if (cached) setList(cached);
    const entry = await loadTokenList();
    if (entry) setList(entry);
    setListDone(true);
  }, []);

  useMountEffect(() => {
    void loadList();
  });

  const caps = networkId ? networkCapabilities(networkId) : null;
  const tag = caps?.tokenListTag;
  const privacy = !!caps?.privacy;
  const allTokens = list?.tokens;
  const tokens = useMemo(
    () => tokensForNetwork(allTokens ?? [], tag, privacy),
    [allTokens, tag, privacy]
  );
  const logoByAddress = useMemo(() => {
    const m = new Map<string, string>();
    for (const t of allTokens ?? []) {
      if (t.address && t.logoURI) m.set(t.address.toLowerCase(), t.logoURI);
    }
    return m;
  }, [allTokens]);
  const listed = useMemo(() => tokens.filter(isContractToken), [tokens]);
  const hasCurated = listed.length > 0;
  const curatedKey = listed.map((t) => t.address).join(',');
  const visKey = scope && address && networkId ? octraVisKey(networkId, address) : '';
  const visibility = useTokenVisibility(visKey ? [visKey] : []);

  const inFlight = useRef<string | null>(null);

  // effect:audited - polls the node (external system) per network + address scope; skipped while hidden, cleanup drops late answers
  useEffect(() => {
    if (!enabled || !scope || !address || !networkId || !listDone) return;
    let live = true;

    const run = async () => {
      if (document.hidden || inFlight.current === scope) return;
      inFlight.current = scope;
      try {
        const key = octraVisKey(networkId, address);
        const [imports, maps] = await Promise.all([
          getImportedAddresses(networkId),
          readVisibility([key]),
        ]);
        const vis = maps[key] ?? {};
        const at = await resolveNetworkPin(networkId);
        const data: OctraHoldings = await readOctraHoldings({
          networkId,
          address,
          imports: imports.filter((a) => vis[a] !== false),
          previous: cachedHoldings(scope)?.imported,
          at,
          known: [...imports, ...(curatedKey ? curatedKey.split(',') : [])],
        });
        if (!live) return;
        storeHoldings(scope, data);
        setHeld({ scope, data, failed: false });
      } catch (e) {
        logger.debug(`[octraTokens] holdings read failed: ${(e as Error)?.message}`);
        if (!live) return;
        setHeld({ scope, data: cachedHoldings(scope) ?? null, failed: true });
      } finally {
        if (inFlight.current === scope) inFlight.current = null;
      }
    };

    const onVisible = () => {
      if (!document.hidden) void run();
    };
    void run();
    const timer = setInterval(run, POLL_MS);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      live = false;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      if (inFlight.current === scope) inFlight.current = null;
    };
  }, [enabled, scope, address, networkId, curatedKey, listDone, tick, visibility.version]);

  const reloadImported = useCallback(() => setTick((t) => t + 1), []);

  const refresh = useCallback(async () => {
    setTick((t) => t + 1);
    await loadList();
  }, [loadList]);

  const removeImported = useCallback(
    async (contract: string) => {
      if (!networkId) return;
      const existing = await getImportedAddresses(networkId);
      await saveImportedAddresses(
        networkId,
        existing.filter((a) => a !== contract)
      );
      forgetImported(networkId, contract);
      setHeld((h) =>
        h.scope.startsWith(`${networkId}:`) && h.data
          ? {
              ...h,
              data: {
                ...h.data,
                imported: h.data.imported.filter((t) => t.contractAddress !== contract),
              },
            }
          : h
      );
    },
    [networkId]
  );

  const shown: Held =
    held.scope === scope
      ? held
      : { scope, data: scope ? (cachedHoldings(scope) ?? null) : null, failed: false };
  const data = shown.data && (shown.data.read || !hasCurated) ? shown.data : null;
  const vis = visibility.maps[visKey] ?? {};
  const visReady = visibility.ready;
  const on = (contract: string) => visReady && vis[contract] !== false;
  const shownTokens = tokens.filter((t) => !isContractToken(t) || on(t.address));
  const imported = data && visReady ? data.imported.filter((t) => on(t.contractAddress)) : null;
  const curated = new Set(listed.map((t) => t.address));
  const detected =
    data && visReady && networkId
      ? (data.held ?? []).filter(
          (t) =>
            !curated.has(t.contractAddress) &&
            !data.imported.some((i) => i.contractAddress === t.contractAddress) &&
            tokenShown(vis[t.contractAddress], octraTokenSpam(networkId, t))
        )
      : [];

  return {
    tokens: shownTokens,
    listed,
    logoByAddress,
    listLoading: !listDone && !list,
    listUnavailable: listDone && !list,
    balances: data?.balances ?? null,
    imported,
    detected,
    held: data?.held ?? null,
    state: data && visReady ? 'known' : shown.failed ? 'failed' : 'loading',
    refresh,
    reloadImported,
    removeImported,
  };
}
