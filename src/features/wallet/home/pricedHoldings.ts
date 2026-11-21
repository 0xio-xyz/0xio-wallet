import type { HomeView } from 'src/hooks/wallet/useHomeView';
import type { HoldingsState } from 'src/hooks/wallet/useOctraTokens';
import type { EvmBalanceRow } from 'src/services/evm/balances';
import {
  contractPriceSymbol,
  isContractToken,
  unitsToNumber,
  type ContractToken,
  type ListedToken,
} from 'src/services/tokens/octraTokens';

export interface EvmHolding extends EvmBalanceRow {
  usd: number | null;
  priceLoading?: boolean;
}

const byName = (a: EvmHolding, b: EvmHolding) =>
  (a.token.name || a.token.symbol).localeCompare(b.token.name || b.token.symbol, undefined, {
    sensitivity: 'base',
  });

export function sortEvmHoldings(rows: readonly EvmHolding[]): EvmHolding[] {
  return [...rows].sort((a, b) => {
    const pa = a.usd !== null && Number.isFinite(a.usd);
    const pb = b.usd !== null && Number.isFinite(b.usd);
    if (pa !== pb) return pa ? -1 : 1;
    if (pa && pb && a.usd !== b.usd) return (b.usd as number) - (a.usd as number);
    return byName(a, b);
  });
}

export type TotalState = 'known' | 'pending' | 'partial' | 'loading';

export interface OctraNative {
  value: number | null;
  missing: 'pending' | null;
}

export function octraNative(
  balance: string | null,
  totalBalance: string | null,
  hasPrivateHalf: boolean,
  privateSettled = false
): OctraNative {
  if (totalBalance != null) return { value: parseFloat(totalBalance) || 0, missing: null };
  if (balance == null) return { value: null, missing: null };
  const value = parseFloat(balance) || 0;
  return { value, missing: hasPrivateHalf && !privateSettled ? 'pending' : null };
}

export interface PricedHoldingsInput {
  view: HomeView;
  networkId: string;
  octPrice: number | undefined;
  octTotal: number | null;
  octMissing?: OctraNative['missing'];
  octra: {
    tokens: ListedToken[];
    balances: Record<string, string> | null;
    imported: ContractToken[] | null;
    detected?: ContractToken[];
    state: HoldingsState;
  };
  evm: {
    on: boolean;
    rows: EvmHolding[];
    loading: boolean;
    failedChains: number[];
  };
}

export interface PricedHoldings {
  contractUsd: Record<string, number | null>;
  octEquivalent: number;
  octUsd: number | null;
  evmUsd: number | null;
  totalUsd: number;
  state: TotalState;
}

const RANK: Record<TotalState, number> = { known: 0, partial: 1, pending: 2, loading: 3 };
const worst = (a: TotalState, b: TotalState): TotalState => (RANK[a] >= RANK[b] ? a : b);

function combine(parts: TotalState[]): TotalState {
  if (parts.length === 0) return 'known';
  if (parts.every((p) => p === 'loading')) return 'loading';
  const open = parts.map((p) => (p === 'loading' ? 'pending' : p));
  return open.reduce(worst, 'known');
}

export function pricedHoldings(input: PricedHoldingsInput): PricedHoldings {
  const { view, networkId, octTotal, octra, evm } = input;
  const octPrice = input.octPrice && input.octPrice > 0 ? input.octPrice : 0;

  const contractUsd: Record<string, number | null> = {};
  let contractSum = 0;
  let octEquivalent = 0;
  let pricedContract = false;
  const price = (contract: string, amount: number | null) => {
    const sym = contractPriceSymbol(networkId, contract);
    if (sym) pricedContract = true;
    if (sym !== 'OCT' || amount === null) {
      contractUsd[contract] = null;
      return;
    }
    octEquivalent += amount;
    const usd = octPrice ? amount * octPrice : null;
    contractUsd[contract] = usd;
    if (usd !== null) contractSum += usd;
  };
  for (const t of octra.tokens) {
    if (!isContractToken(t)) continue;
    const raw = octra.balances ? (octra.balances[t.address] ?? '0') : null;
    price(t.address, unitsToNumber(raw, t.decimals ?? 0));
  }
  for (const t of [...(octra.imported ?? []), ...(octra.detected ?? [])]) {
    if (t.contractAddress in contractUsd) continue;
    price(t.contractAddress, unitsToNumber(t.balance, t.decimals));
  }

  const octUsd = octTotal !== null && octPrice ? octTotal * octPrice : null;
  const evmUsd = evm.rows.some((r) => r.usd != null)
    ? evm.rows.reduce((n, r) => n + (r.usd ?? 0), 0)
    : evm.rows.length
      ? 0
      : null;

  let octState: TotalState = 'known';
  if (octTotal === null) octState = 'loading';
  else {
    if (input.octMissing === 'pending') octState = 'pending';
    if (!octPrice && octTotal > 0) octState = worst(octState, 'partial');
    if (pricedContract) {
      if (octra.state === 'loading') octState = worst(octState, 'pending');
      else if (octra.state === 'failed') octState = worst(octState, 'partial');
    }
  }

  let evmState: TotalState = 'known';
  if (evm.on) {
    if (evm.loading && evm.rows.length === 0) evmState = 'loading';
    else if (evm.rows.some((r) => r.priceLoading)) {
      evmState = evm.rows.some((r) => r.usd != null) ? 'pending' : 'loading';
    } else if (evm.failedChains.some((c) => !evm.rows.some((r) => r.chainId === c))) {
      evmState = 'partial';
    }
  }

  const withOct = view !== 'evm';
  const withEvm = view !== 'oct' && evm.on;
  const totalUsd = (withOct ? (octUsd ?? 0) + contractSum : 0) + (withEvm ? (evmUsd ?? 0) : 0);
  const state = combine([...(withOct ? [octState] : []), ...(withEvm ? [evmState] : [])]);

  return { contractUsd, octEquivalent, octUsd, evmUsd, totalUsd, state };
}
