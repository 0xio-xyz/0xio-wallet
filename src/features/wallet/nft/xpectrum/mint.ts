import { callView, splitPipe, toNum, isTruthy } from './read';

export interface ContractInfo {
  name: string;
  symbol: string;
  totalMinted: number;
  maxSupply: number;
  royaltyBps: number;
}

// six fields per phase: price|start|end|cap|minted|walletCap (GTD@0, FCFS@6, public@12)
export interface PhaseInfo {
  price: number;
  start: number;
  end: number;
  cap: number;
  minted: number;
  walletCap: number;
}

export interface WalletState {
  paused: boolean;
  currentPhase: number;
  mintedCount: number;
  gtdWl: boolean;
  fcfsWl: boolean;
  pending: number;
}

export async function getContractInfo(contract: string): Promise<ContractInfo | null> {
  const f = splitPipe(await callView(contract, 'get_contract_info', []));
  if (f.length < 4) return null;
  return {
    name: f[0],
    symbol: f[1],
    totalMinted: toNum(f[2]),
    maxSupply: toNum(f[3]),
    royaltyBps: toNum(f[4]),
  };
}

export async function getCurrentPhase(contract: string): Promise<number> {
  return toNum((await callView(contract, 'get_current_phase', [])) ?? undefined);
}

export async function getPhases(
  contract: string
): Promise<{ gtd: PhaseInfo; fcfs: PhaseInfo; public: PhaseInfo } | null> {
  const f = splitPipe(await callView(contract, 'get_phase_info', []));
  if (f.length < 18) return null;
  const slice = (o: number): PhaseInfo => ({
    price: toNum(f[o]),
    start: toNum(f[o + 1]),
    end: toNum(f[o + 2]),
    cap: toNum(f[o + 3]),
    minted: toNum(f[o + 4]),
    walletCap: toNum(f[o + 5]),
  });
  return { gtd: slice(0), fcfs: slice(6), public: slice(12) };
}

export async function getWalletState(
  contract: string,
  wallet: string
): Promise<WalletState | null> {
  const f = splitPipe(await callView(contract, 'get_wallet_state', [wallet]));
  if (f.length < 6) return null;
  return {
    paused: isTruthy(f[0]),
    currentPhase: toNum(f[1]),
    mintedCount: toNum(f[2]),
    gtdWl: isTruthy(f[3]),
    fcfsWl: isTruthy(f[4]),
    pending: toNum(f[5]),
  };
}

export async function getActivePhasePrice(contract: string): Promise<number | null> {
  const [phase, phases] = await Promise.all([getCurrentPhase(contract), getPhases(contract)]);
  if (!phases) return null;
  const p = phase === 0 ? phases.gtd : phase === 1 ? phases.fcfs : phases.public;
  return p.price;
}

export async function diagnoseMint(
  contract: string,
  wallet: string,
  quantity: number
): Promise<string | null> {
  const [ws, info, phases, phase] = await Promise.all([
    getWalletState(contract, wallet),
    getContractInfo(contract),
    getPhases(contract),
    getCurrentPhase(contract),
  ]);
  if (ws?.paused) return 'Minting is paused.';
  if (info && info.maxSupply > 0 && info.totalMinted >= info.maxSupply)
    return 'Collection is sold out.';
  const p = phases && (phase === 0 ? phases.gtd : phase === 1 ? phases.fcfs : phases.public);
  if (p) {
    if (p.cap > 0 && p.minted >= p.cap) return 'This phase is sold out.';
    if (p.walletCap > 0 && ws && ws.mintedCount + quantity > p.walletCap)
      return 'Per-wallet mint cap reached.';
    if (phase === 0 && ws && !ws.gtdWl)
      return 'Not on the guaranteed (GTD) whitelist for this phase.';
  }
  return null;
}
