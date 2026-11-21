import { useEffect, useState } from 'react';
import { useWallet } from 'src/contexts/WalletContext';
import { useHomeView } from 'src/hooks/wallet/useHomeView';
import { useOctraTokens } from 'src/hooks/wallet/useOctraTokens';
import { readEvmBalanceSnapshot, useEvmNetworks } from 'src/hooks/wallet/useEvmBalances';
import { useImportedEvmTokens } from 'src/hooks/wallet/useEvmTokenImport';
import { useEvmDetected, useTokenVisibility } from 'src/hooks/wallet/useTokenPrefs';
import { useEvmNfts } from 'src/hooks/wallet/useEvmNfts';
import { useNftGallery } from 'src/features/wallet/nft/useNftGallery';
import type { EvmBalanceRow } from 'src/services/evm/balances';
import { loadImportedNfts } from 'src/services/evm/nfts';
import { removeCustomEvmToken } from 'src/services/evm/customTokens';
import {
  getImportedAddresses,
  readTokenMeta,
  type TokenMeta,
} from 'src/services/tokens/octraTokens';
import { evmVisKey, octraVisKey } from 'src/services/tokens/tokenVisibility';
import { getNetworkConfig } from 'src/utils/network';
import {
  evmCollectionRows,
  evmManageRows,
  octraCollectionRows,
  octraManageRows,
  type ManageCollectionRow,
  type ManageTokenRow,
} from './manageRows';

interface OctraImports {
  scope: string;
  addrs: string[];
  meta: Record<string, TokenMeta | undefined>;
}

function useOctraImports(networkId: string, reloadKey: string): OctraImports | null {
  const [state, setState] = useState<OctraImports | null>(null);
  // effect:audited - reads imports from chrome.storage and their metadata from the node cache (external systems) per network; drops a late answer
  useEffect(() => {
    if (!networkId) return;
    let live = true;
    void (async () => {
      const addrs = await getImportedAddresses(networkId);
      const metas = await Promise.all(
        addrs.map((a) => readTokenMeta(networkId, a).catch((): null => null))
      );
      const meta = Object.fromEntries(addrs.map((a, i) => [a, metas[i] ?? undefined]));
      if (live) setState({ scope: networkId, addrs, meta });
    })();
    return () => {
      live = false;
    };
  }, [networkId, reloadKey]);
  return state?.scope === networkId ? state : null;
}

function useEvmSnapshot(networkId: string, address: string | null): EvmBalanceRow[] {
  const scope = address ? `${networkId}:${address.toLowerCase()}` : '';
  const [state, setState] = useState<{ scope: string; rows: EvmBalanceRow[] } | null>(null);
  // effect:audited - reads cached balances from chrome.storage (external system) per scope; drops a late answer
  useEffect(() => {
    if (!scope || !address) return;
    let live = true;
    void readEvmBalanceSnapshot(networkId, address).then((rows) => {
      if (live) setState({ scope, rows });
    });
    return () => {
      live = false;
    };
  }, [scope, networkId, address]);
  return state?.scope === scope ? state.rows : [];
}

export function useManageTokens() {
  const { activeWallet, networkId } = useWallet();
  const { evmOn, evmAddress } = useHomeView();
  const address = activeWallet?.address ?? null;
  const octra = useOctraTokens(address, networkId, true);
  const { networks, ready } = useEvmNetworks(networkId);
  const evmNetworks = evmOn && evmAddress ? networks : [];
  const chainIds = evmNetworks.map((n) => n.chainId);
  const detection = useEvmDetected(evmAddress, chainIds, evmOn && ready, 'open');
  const importedEvm = useImportedEvmTokens();
  const imports = useOctraImports(
    networkId,
    (octra.imported ?? []).map((t) => t.contractAddress).join(',')
  );
  const snapshot = useEvmSnapshot(networkId, evmOn ? evmAddress : null);
  const octraKey = address ? octraVisKey(networkId, address) : '';
  const evmKeys = evmAddress ? chainIds.map((c) => evmVisKey(c, evmAddress)) : [];
  const visibility = useTokenVisibility(octraKey ? [octraKey, ...evmKeys] : evmKeys);

  const octraRows: ManageTokenRow[] =
    address && imports
      ? octraManageRows({
          networkId,
          networkName: getNetworkConfig(networkId).name,
          address,
          listed: octra.listed,
          importAddrs: imports.addrs,
          importMeta: imports.meta,
          held: octra.held,
          balances: octra.balances,
          vis: visibility.maps[octraKey] ?? {},
          logoByAddress: octra.logoByAddress,
        })
      : [];
  const evmRows: ManageTokenRow[] = evmAddress
    ? evmManageRows({
        address: evmAddress,
        networks: evmNetworks,
        imported: importedEvm,
        detected: detection.records,
        vis: visibility.maps,
        balances: snapshot,
      })
    : [];

  return {
    rows: [...octraRows, ...evmRows],
    loading: !visibility.ready || (!!address && !imports),
    detecting: detection.loading,
    octra,
    setShown: (row: ManageTokenRow, shown: boolean) =>
      visibility.set(row.visKey, row.contract, shown),
    remove: async (row: ManageTokenRow): Promise<boolean> => {
      if (row.origin !== 'imported') return false;
      try {
        if (row.chainId === null) await octra.removeImported(row.contract);
        else await removeCustomEvmToken(row.chainId, row.contract);
        return true;
      } catch {
        return false;
      }
    },
  };
}

function useEvmNftImports(
  address: string | null,
  chainIds: readonly number[],
  reloadKey: string
): Record<number, string[]> {
  const scope = address ? `${address.toLowerCase()}|${chainIds.join(',')}` : '';
  const [state, setState] = useState<{ scope: string; map: Record<number, string[]> } | null>(null);
  // effect:audited - reads imported NFTs from chrome.storage (external system) per address and chain set
  useEffect(() => {
    if (!scope) return;
    let live = true;
    const [owner, chains] = scope.split('|');
    const ids = chains ? chains.split(',').map(Number) : [];
    void Promise.all(ids.map((c) => loadImportedNfts(c, owner))).then((lists) => {
      if (live) {
        setState({
          scope,
          map: Object.fromEntries(ids.map((c, i) => [c, lists[i].map((n) => n.contract)])),
        });
      }
    });
    return () => {
      live = false;
    };
  }, [scope, reloadKey]);
  return state?.scope === scope ? state.map : {};
}

export function useManageNfts() {
  const g = useNftGallery();
  const { evmOn, evmAddress } = useHomeView();
  const evm = useEvmNfts(evmAddress, g.networkId, evmOn);
  const importedEvm = useEvmNftImports(
    evmOn ? evmAddress : null,
    evm.networks.map((n) => n.chainId),
    String(evm.items.length)
  );

  const rows: ManageCollectionRow[] = [
    ...octraCollectionRows({
      collections: g.collections,
      ids: g.ids,
      hidden: g.hidden,
      networkName: getNetworkConfig(g.networkId).name,
    }),
    ...(evmOn
      ? evmCollectionRows({
          items: evm.items,
          hidden: evm.hidden,
          imported: importedEvm,
          networks: evm.networks,
        })
      : []),
  ];

  const setShown = (row: ManageCollectionRow, shown: boolean) =>
    row.kind === 'oct'
      ? g.hideCollection(row.contract, !shown)
      : evm.hideCollection(row.chainId ?? 0, row.contract, !shown);

  return {
    rows,
    loading:
      (g.initialLoading && g.collections.length === 0) ||
      (evmOn && evm.loading && evm.items.length === 0),
    gallery: g,
    evm,
    evmOn,
    evmAddress,
    setShown,
  };
}
