import { useRef, useState } from 'react';
import { useTranslation } from 'src/i18n/react';
import { toChecksumAddress } from 'src/services/evm/accounts';
import {
  isContractAddress,
  parseTokenId,
  probeNetwork,
  readNftOwned,
  type DetectResult,
  type NftStandard,
} from 'src/services/evm/detect';
import type { EvmNetwork } from 'src/services/evm/networks';
import { readNftOnChain, saveImportedNft, type EvmNft } from 'src/services/evm/nfts';
import { noteRecentNetwork } from 'src/services/evm/recentNetworks';
import { useNetworkDetect } from 'src/hooks/wallet/useNetworkDetect';

export type NftImportPhase = 'idle' | 'checking' | 'ready' | 'adding';

const TOKEN_ID_WAIT_MS = 400;

export function useEvmNftImport(owner: string | null | undefined) {
  const { t } = useTranslation();
  const detect = useNetworkDetect('nft');
  const [address, setAddressRaw] = useState('');
  const [tokenId, setTokenIdRaw] = useState('');
  const [phase, setPhase] = useState<NftImportPhase>('idle');
  const [preview, setPreview] = useState<EvmNft | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const run = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latest = useRef({ address, tokenId, detect });
  latest.current = { address, tokenId, detect };

  const clear = () => {
    run.current++;
    if (timer.current) clearTimeout(timer.current);
    setPhase('idle');
    setPreview(null);
    setProblem(null);
  };

  const check = async (network: EvmNetwork, standardHint?: NftStandard) => {
    const { address: contract, tokenId: rawId } = latest.current;
    const id = parseTokenId(rawId);
    if (!isContractAddress(contract) || id === null) return;
    if (!owner || !isContractAddress(owner)) {
      setProblem(
        t('evmNft.noEvm', { defaultValue: 'Turn on EVM for this wallet to import 0x NFTs' })
      );
      return;
    }
    const runId = ++run.current;
    setPhase('checking');
    setProblem(null);
    setPreview(null);
    const chain = network.name;
    let standard = standardHint ?? null;
    if (!standard) {
      try {
        standard = (await probeNetwork(network, contract, { kind: 'nft' }))?.standard ?? null;
      } catch {
        if (runId !== run.current) return;
        setPhase('idle');
        setProblem(t('evmTokens.unreachable', { chain, defaultValue: '{{chain}} unreachable' }));
        return;
      }
      if (runId !== run.current) return;
      if (!standard) {
        setPhase('idle');
        setProblem(
          t('evmNft.noCollection', {
            chain,
            defaultValue: 'No NFT collection at this address on {{chain}}',
          })
        );
        return;
      }
    }
    const owned = await readNftOwned(network, contract, standard, owner, id);
    if (runId !== run.current) return;
    if (owned === null) {
      setPhase('idle');
      setProblem(t('evmTokens.unreachable', { chain, defaultValue: '{{chain}} unreachable' }));
      return;
    }
    if (owned === 0n) {
      setPhase('idle');
      setProblem(
        t('evmNft.notHeld', {
          chain,
          defaultValue: 'This wallet does not hold this token on {{chain}}',
        })
      );
      return;
    }
    const meta = await readNftOnChain(network, contract, standard, id);
    if (runId !== run.current) return;
    setPreview({
      chainId: network.chainId,
      contract: toChecksumAddress(contract),
      tokenId: id.toString(),
      standard,
      amount: standard === 'ERC-721' ? '1' : owned.toString(),
      name: meta.name,
      collection: meta.collection,
      image: meta.image,
    });
    setPhase('ready');
  };

  const narrow = async (res: DetectResult) => {
    const held = res.matches.filter(
      (m) => m.owned !== undefined && m.owned !== null && m.owned > 0n
    );
    if (held.length === 1) {
      detect.pick(held[0].network, false);
      await check(held[0].network, held[0].standard);
    }
  };

  const runCheck = async (found?: DetectResult) => {
    const { detect: d, address: contract, tokenId: rawId } = latest.current;
    const id = parseTokenId(rawId);
    if (!isContractAddress(contract) || id === null) return;
    const network = found ? null : d.network;
    if (network) {
      await check(network, d.match?.standard);
      return;
    }
    const matches = found?.matches ?? d.matches;
    if (matches.length > 1 && owner && isContractAddress(owner)) {
      const runId = ++run.current;
      setPhase('checking');
      const owned = await Promise.all(
        matches.map((m) =>
          m.standard ? readNftOwned(m.network, contract, m.standard, owner, id) : null
        )
      );
      if (runId !== run.current) return;
      setPhase('idle');
      await narrow({
        matches: matches.map((m, i) => ({ ...m, owned: owned[i] })),
        unreachable: found?.unreachable ?? d.unreachable,
      });
    }
  };

  const setAddress = (value: string) => {
    const next = value.replace(/\s+/g, '').slice(0, 42);
    setAddressRaw(next);
    latest.current = { ...latest.current, address: next };
    clear();
    if (!isContractAddress(next)) {
      detect.reset();
      return;
    }
    const rawId = latest.current.tokenId;
    void detect
      .start(next, { owner, tokenId: parseTokenId(rawId) === null ? null : rawId.trim() })
      .then(async (res) => {
        if (!res || latest.current.address !== next) return;
        if (res.matches.length === 1) {
          if (parseTokenId(latest.current.tokenId) !== null) {
            await check(res.matches[0].network, res.matches[0].standard);
          }
        } else if (res.matches.length > 1) {
          if (latest.current.tokenId === rawId) await narrow(res);
          else await runCheck(res);
        }
      });
  };

  const setTokenId = (value: string) => {
    const next = value.replace(/[^\d]/g, '').slice(0, 78);
    setTokenIdRaw(next);
    latest.current = { ...latest.current, tokenId: next };
    clear();
    if (parseTokenId(next) === null) return;
    timer.current = setTimeout(() => void runCheck(), TOKEN_ID_WAIT_MS);
  };

  const pickNetwork = (network: EvmNetwork) => {
    detect.pick(network);
    clear();
    const m = latest.current.detect.matches.find((x) => x.network.chainId === network.chainId);
    void check(network, m?.standard);
  };

  const reset = () => {
    setAddressRaw('');
    setTokenIdRaw('');
    latest.current = { ...latest.current, address: '', tokenId: '' };
    clear();
    detect.reset();
  };

  const add = async (): Promise<EvmNft | null> => {
    if (!preview || phase !== 'ready' || !owner) return null;
    const runId = ++run.current;
    setPhase('adding');
    try {
      await saveImportedNft(preview, owner);
      void noteRecentNetwork(preview.chainId);
      return preview;
    } catch {
      if (runId === run.current) {
        setPhase('ready');
        setProblem(t('evmNft.saveFailed', { defaultValue: 'Could not save it. Try again.' }));
      }
      return null;
    }
  };

  return {
    detect,
    address,
    setAddress,
    tokenId,
    setTokenId,
    pickNetwork,
    phase,
    preview,
    problem,
    add,
    reset,
  };
}

export type EvmNftImport = ReturnType<typeof useEvmNftImport>;
