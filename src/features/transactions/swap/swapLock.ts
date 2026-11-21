import { networkService } from 'src/services/network/NetworkService';
import { assertTxScope, captureTxScope, type TxScope } from 'src/services/network/txScope';
import type { NetworkId } from 'src/utils/config';
import { toUnits } from 'src/utils/amount';
import { reviewedFeeError } from 'src/utils/octra/dappTx';
import { registerSwap, getSwaps } from './solverApi';
import { SETTLED_STATUSES } from './types';
import type { SwapQuote } from './types';

const EXPIRY_EPOCHS = 5000; // ~14h (the contract expects an Octra epoch, not a timestamp)
export async function getCurrentEpoch(scope: TxScope): Promise<number> {
  let epoch = NaN;
  try {
    const r = await networkService.jsonRpcCall('octra_recentTransactions', [1], true, scope);
    epoch = Number(r?.transactions?.[0]?.epoch);
  } catch {}
  await assertTxScope(scope);
  if (!Number.isSafeInteger(epoch) || epoch <= 0) {
    throw new Error('Could not read the current epoch. Try again.');
  }
  return epoch;
}

export async function lockOctToEth(args: {
  vault: string;
  quote: SwapQuote;
  amount: string;
  destEthAddress: string;
  slippagePct: number;
  from: string;
  privateKey: string;
  publicKey?: string;
  networkId: NetworkId;
  ou: string;
}): Promise<string> {
  const { vault, quote, amount, destEthAddress, slippagePct, from, privateKey, publicKey } = args;
  if (!quote.intent_hash) throw new Error('Quote missing intent hash - refresh and retry');
  const scope = await captureTxScope(from, args.networkId);
  await assertTxScope(scope);

  const amountUnits = toUnits(amount, 6);
  if (amountUnits <= 0n) throw new Error('Invalid amount');
  const amountMicro = amountUnits.toString();
  const epoch = await getCurrentEpoch(scope);
  const expiry = epoch + EXPIRY_EPOCHS;
  const keepBps = 10_000n - BigInt(Math.round(Math.min(Math.max(slippagePct, 0), 100) * 100));
  const minReceiveWei = ((toUnits(quote.receive ?? 0, 18) * keepBps) / 10_000n).toString();

  const feeError = reviewedFeeError(
    BigInt(args.ou),
    await networkService.getRecommendedFeeStrict('call', scope)
  );
  if (feeError) throw new Error(feeError);

  const nonce = await networkService.getNextNonce(from, scope);
  const signedTx = await networkService.buildContractCallTransaction({
    from,
    contract: vault,
    method: 'lock',
    callParams: [
      quote.intent_hash,
      'sepolia',
      destEthAddress,
      String(expiry),
      minReceiveWei,
      'ETH',
    ],
    amount: amountMicro,
    nonce,
    ou: args.ou,
    privateKey,
    publicKey,
  });

  const res = await networkService.jsonRpcCall('octra_submit', [signedTx], undefined, scope);
  const hash = res?.tx_hash || res?.hash || res?.txHash || res?.transaction_hash;
  if (!hash) throw new Error('Lock submitted but the node returned no tx hash');

  registerSwap({
    intent_hash: quote.intent_hash,
    amount_oct: parseFloat(amount),
    dest_chain: 'sepolia',
    dest_addr: destEthAddress,
  }).catch(() => {});

  return hash;
}

export async function pollSwapStatus(
  intentHash: string,
  onStatus?: (status: string) => void,
  shouldStop?: () => boolean
): Promise<boolean> {
  const escrowKey = `escrow_${intentHash}`;
  for (let i = 0; i < 60; i++) {
    await new Promise((r) => setTimeout(r, 5000));
    if (shouldStop?.()) return false;
    try {
      const data = await getSwaps();
      const swap = (data.swaps || []).find(
        (s) => s.intent_hash === intentHash || s.intent_hash === escrowKey
      );
      if (swap?.status) {
        onStatus?.(swap.status);
        if ((SETTLED_STATUSES as readonly string[]).includes(swap.status)) return true;
      }
    } catch {}
  }
  return false;
}
