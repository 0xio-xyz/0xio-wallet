import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import type { TFunction } from 'src/i18n/core';
import { useCustomEvmVersion } from 'src/hooks/wallet/useEvmBalances';
import { fetchTokenBalance } from 'src/services/evm/balances';
import {
  EvmTokenError,
  addCustomEvmToken,
  loadCustomEvmTokens,
  removeCustomEvmToken,
  resolveCustomEvmToken,
} from 'src/services/evm/customTokens';
import { isContractAddress } from 'src/services/evm/detect';
import type { EvmNetwork } from 'src/services/evm/networks';
import { noteRecentNetwork } from 'src/services/evm/recentNetworks';
import type { EvmToken } from 'src/services/evm/tokens';
import { fromUnits } from 'src/utils/amount';
import { useNetworkDetect } from 'src/hooks/wallet/useNetworkDetect';

export { useAllEvmNetworks } from 'src/hooks/wallet/useNetworkDetect';

export const isEvmContractInput = (value: string) => /^0x/i.test(value.trim());

export function shortAmount(raw: bigint, decimals: number): string {
  const [int, frac = ''] = fromUnits(raw, decimals).split('.');
  const cut = frac.slice(0, 6).replace(/0+$/, '');
  if (!cut && /[1-9]/.test(frac) && int === '0') return '< 0.000001';
  return cut ? `${int}.${cut}` : int;
}

export function evmTokenProblemText(e: unknown, t: TFunction, network?: EvmNetwork | null) {
  const chain = network?.name ?? '';
  if (!(e instanceof EvmTokenError)) {
    return t('evmTokens.readFailed', { defaultValue: 'Could not read this token. Try again.' });
  }
  switch (e.problem) {
    case 'network':
      return t('evmTokens.noNetwork', { defaultValue: 'Add this network first' });
    case 'address':
      return t('evmTokens.badAddress', {
        defaultValue: 'Invalid address. Enter 0x followed by 40 hex characters.',
      });
    case 'listed':
      return t('evmTokens.listed', { defaultValue: 'Token already added' });
    case 'noContract':
      return t('evmTokens.noContract', {
        chain,
        defaultValue: 'No contract at this address on {{chain}}',
      });
    case 'unreachable':
      return t('evmTokens.unreachable', { chain, defaultValue: '{{chain}} unreachable' });
    case 'decimalsMismatch':
      return t('evmTokens.decimalsMismatch', {
        defaultValue: 'Decimals do not match the contract',
      });
    default:
      return t('evmTokens.notToken', { defaultValue: 'Not a token contract' });
  }
}

export function useImportedEvmTokens(): EvmToken[] {
  const version = useCustomEvmVersion();
  const [list, setList] = useState<EvmToken[]>([]);
  // effect:audited - reads imported tokens from chrome.storage (external system); reloads when they change
  useEffect(() => {
    let live = true;
    loadCustomEvmTokens()
      .then((l) => live && setList(l))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [version]);
  return list;
}

export type ImportPhase = 'idle' | 'detecting' | 'reading' | 'ready' | 'adding';

export function useEvmTokenImport(opts: {
  octraNetworkId: string | null | undefined;
  owner: string | null | undefined;
}) {
  const { t } = useTranslation();
  const detect = useNetworkDetect('token');
  const imported = useImportedEvmTokens();
  const [address, setAddressRaw] = useState('');
  const [phase, setPhase] = useState<Exclude<ImportPhase, 'detecting'>>('idle');
  const [preview, setPreview] = useState<EvmToken | null>(null);
  const [balance, setBalance] = useState<string | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useRef(0);
  const importedRef = useRef(imported);
  importedRef.current = imported;

  const network = detect.network;

  const clear = useCallback(() => {
    run.current++;
    setPhase('idle');
    setPreview(null);
    setBalance(null);
    setProblem(null);
  }, []);

  const readOn = async (net: EvmNetwork, addr: string) => {
    if (
      importedRef.current.some(
        (tk) => tk.chainId === net.chainId && tk.address?.toLowerCase() === addr.toLowerCase()
      )
    ) {
      setProblem(t('evmTokens.already', { defaultValue: 'Already imported' }));
      return;
    }
    const id = ++run.current;
    setPhase('reading');
    setProblem(null);
    try {
      const token = await resolveCustomEvmToken({ chainId: net.chainId, address: addr });
      if (id !== run.current) return;
      setPreview(token);
      setPhase('ready');
      if (opts.owner) {
        fetchTokenBalance(opts.owner, net, token)
          .then((raw) => id === run.current && setBalance(shortAmount(raw, token.decimals)))
          .catch(() => {});
      }
    } catch (e) {
      if (id !== run.current) return;
      setPhase('idle');
      setProblem(evmTokenProblemText(e, t, net));
    }
  };

  const setAddress = (value: string) => {
    const next = value.replace(/\s+/g, '').slice(0, 42);
    setAddressRaw(next);
    clear();
    if (!isContractAddress(next)) {
      detect.reset();
      return;
    }
    void detect.start(next).then((res) => {
      if (res && res.matches.length === 1) void readOn(res.matches[0].network, next);
    });
  };

  const pickNetwork = (net: EvmNetwork) => {
    detect.pick(net);
    clear();
    if (isContractAddress(address)) void readOn(net, address);
  };

  const reset = () => {
    setAddressRaw('');
    clear();
    detect.reset();
  };

  const find = async () => {
    const addr = address.trim();
    if (!addr || phase === 'reading' || phase === 'adding' || detect.phase === 'detecting') return;
    if (!network) {
      detect.openSearch();
      return;
    }
    await readOn(network, addr);
  };

  const add = async (): Promise<boolean> => {
    if (!preview || phase !== 'ready') return false;
    const id = ++run.current;
    setPhase('adding');
    try {
      await addCustomEvmToken({ chainId: preview.chainId, address: preview.address! });
      void noteRecentNetwork(preview.chainId);
      if (id !== run.current) return false;
      setAddressRaw('');
      clear();
      detect.reset();
      return true;
    } catch (e) {
      if (id !== run.current) return false;
      setPhase('ready');
      setProblem(evmTokenProblemText(e, t, network));
      return false;
    }
  };

  const remove = (token: EvmToken) =>
    token.address ? removeCustomEvmToken(token.chainId, token.address) : Promise.resolve();

  return {
    networks: detect.networks,
    network,
    detect,
    pickNetwork,
    address,
    setAddress,
    phase: (detect.phase === 'detecting' ? 'detecting' : phase) as ImportPhase,
    preview,
    balance,
    problem,
    find,
    add,
    reset,
    imported,
    remove,
  };
}

export type EvmTokenImport = ReturnType<typeof useEvmTokenImport>;
