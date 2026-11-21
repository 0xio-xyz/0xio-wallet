export type SwapAsset = 'OCT' | 'ETH';
export type SwapDirection = 'oct_to_eth' | 'eth_to_oct';

export interface ChainsConfig {
  solver?: {
    vault?: string;
    eth_escrow?: string;
    max_swap_oct?: number;
    [k: string]: unknown;
  };
  chains?: unknown;
  [k: string]: unknown;
}

export interface SwapQuote {
  rate?: number;
  receive?: number;
  fee_pct?: number;
  intent_hash?: string;
  liquidity?: {
    sufficient?: boolean;
    available?: number;
    token?: SwapAsset;
  };
  error?: string;
  [k: string]: unknown;
}

export interface SwapRecord {
  intent_hash?: string;
  status?: string;
  amount_oct?: number;
  dest_chain?: string;
  dest_addr?: string;
  lock_tx?: string;
  fill_tx?: string;
  [k: string]: unknown;
}

export interface RegisterSwapBody {
  intent_hash: string;
  amount_oct: number;
  dest_chain: string;
  dest_addr: string;
}

export const SETTLED_STATUSES = ['filled', 'attested', 'settled', 'completed'] as const;
