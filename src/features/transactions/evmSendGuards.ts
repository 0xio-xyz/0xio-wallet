import type { EvmNetwork } from 'src/services/evm/networks';
import type { PreparedTransfer, TxEndState } from 'src/services/evm/send';
import type { EvmToken } from 'src/services/evm/tokens';

const ZERO_ADDRESS = /^0x0{40}$/i;

/** Everything a review showed, frozen at Review. Send signs this, never live form state. */
export interface EvmReviewBinding {
  walletId: string;
  evmIndex: number;
  from: string;
  chainId: number;
  rpcUrl: string;
  to: string;
  amount: bigint;
  amountText: string;
  tokenKey: string;
  token: EvmToken;
  network: EvmNetwork;
  prepared: PreparedTransfer;
  usd: string | null;
}

export interface EvmSendScope {
  walletId: string | null;
  evmIndex: number;
  from: string | null;
  chainId: number | null;
  rpcUrl: string | null;
  to: string;
  amount: bigint;
  tokenKey: string | null;
}

export function scopeChanged(bound: EvmReviewBinding, live: EvmSendScope): boolean {
  return (
    bound.walletId !== live.walletId ||
    bound.evmIndex !== live.evmIndex ||
    !live.from ||
    bound.from.toLowerCase() !== live.from.toLowerCase() ||
    bound.chainId !== live.chainId ||
    bound.rpcUrl !== live.rpcUrl ||
    bound.prepared.tx.chainId !== bound.chainId ||
    bound.to.toLowerCase() !== live.to.trim().toLowerCase() ||
    bound.amount !== live.amount ||
    bound.tokenKey !== live.tokenKey
  );
}

export function nonceChanged(bound: EvmReviewBinding, pendingNonce: number): boolean {
  return bound.prepared.tx.nonce !== pendingNonce;
}

export function recipientIssue(
  to: string,
  tokenAddress: string | null
): 'zero' | 'contract' | null {
  const v = to.trim().toLowerCase();
  if (ZERO_ADDRESS.test(v)) return 'zero';
  if (tokenAddress && v === tokenAddress.toLowerCase()) return 'contract';
  return null;
}

export type EvmEndStage = 'done' | 'failed' | 'replaced' | 'stuck';

export function endStageOf(state: TxEndState): EvmEndStage {
  if (state === 'success') return 'done';
  if (state === 'failed') return 'failed';
  if (state === 'replaced') return 'replaced';
  return 'stuck';
}
