import type { EvmNetwork } from './networks';
import { isHex, rpcCall, type RpcOptions } from './rpc';
import { isMethodUnsupported, retryOnce } from './rpcErrors';
import type { EvmToken } from './tokens';
import { erc20TransferData, isEvmAddress, type Eip1559Tx } from './tx';

export interface EvmFees {
  baseFeePerGas: bigint | null;
  maxPriorityFeePerGas: bigint;
  maxFeePerGas: bigint;
  legacy?: true;
}

export interface GasRequest {
  from: string;
  to: string | null;
  value: bigint;
  data: string;
}

export interface PreparedTransfer {
  tx: Eip1559Tx;
  feeWei: bigint;
  totalNative: bigint;
  fees?: EvmFees;
}

export interface EvmReceipt {
  status: 'success' | 'failed';
  blockNumber: number;
}

export type TxEndState = 'success' | 'failed' | 'replaced' | 'pending';

export interface TxWatch {
  state: TxEndState;
  blockNumber: number | null;
}

export class FeeCeilingError extends Error {
  constructor() {
    super('The network fee from this RPC is far above normal');
    this.name = 'FeeCeilingError';
  }
}

export interface FeeHistory {
  baseFeePerGas?: string[];
  reward?: string[][];
}

const TRANSFER_GAS = 21_000n;
const FEE_BLOCKS = 5;
const GWEI = 1_000_000_000n;
const FEE_CEILING_RATIO = 20n;
const MAX_FEE_CAP: Readonly<Record<number, bigint>> = {
  1: 2_000n * GWEI,
  11155111: 10_000n * GWEI,
  4663: 100n * GWEI,
  46630: 100n * GWEI,
};

function quantity(value: unknown, label: string): bigint {
  if (!isHex(value) || value.length < 3) throw new Error(`Bad ${label} from the network`);
  return BigInt(value);
}

function toQuantity(value: bigint): string {
  return '0x' + value.toString(16);
}

function median(values: bigint[]): bigint {
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  return sorted[Math.floor(sorted.length / 2)];
}

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error('Aborted'));
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('Aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

export async function getNonce(
  network: EvmNetwork,
  address: string,
  opts?: RpcOptions
): Promise<number> {
  if (!isEvmAddress(address)) throw new Error('Invalid sender address');
  const n = quantity(
    await rpcCall<string>(network.rpcUrl, 'eth_getTransactionCount', [address, 'pending'], opts),
    'nonce'
  );
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Bad nonce from the network');
  return Number(n);
}

export function feeCeilingProblem(
  chainId: number,
  maxFeePerGas: bigint,
  gasPrice: bigint
): 'relative' | 'absolute' | null {
  const cap = MAX_FEE_CAP[chainId];
  if (cap !== undefined && maxFeePerGas > cap) return 'absolute';
  if (gasPrice > 0n && maxFeePerGas > gasPrice * FEE_CEILING_RATIO) return 'relative';
  return null;
}

export function feesFromHistory(history: FeeHistory | null): EvmFees | null {
  const bases = history?.baseFeePerGas;
  if (!history || !Array.isArray(bases) || bases.length === 0) return null;
  const baseFeePerGas = quantity(bases[bases.length - 1], 'base fee');
  if (baseFeePerGas === 0n) return null;
  const rewards = (history.reward ?? [])
    .map((r) => (Array.isArray(r) && isHex(r[0]) && r[0].length > 2 ? BigInt(r[0]) : null))
    .filter((r): r is bigint => r !== null);
  const maxPriorityFeePerGas = rewards.length > 0 ? median(rewards) : 0n;
  return {
    baseFeePerGas,
    maxPriorityFeePerGas,
    maxFeePerGas: baseFeePerGas * 2n + maxPriorityFeePerGas,
  };
}

/**
 * From eth_gasPrice alone. With a base fee, a type 2 tx capped at twice the gas price; without
 * one, a legacy tx at the gas price plus 20%, since a legacy tx pays its whole gas price.
 */
export function feesFromGasPrice(gasPrice: bigint, baseFeePerGas: bigint | null): EvmFees {
  if (baseFeePerGas !== null && baseFeePerGas > 0n) {
    const maxPriorityFeePerGas = gasPrice > baseFeePerGas ? gasPrice - baseFeePerGas : 0n;
    const floor = baseFeePerGas * 2n + maxPriorityFeePerGas;
    const doubled = gasPrice * 2n;
    return {
      baseFeePerGas,
      maxPriorityFeePerGas,
      maxFeePerGas: doubled > floor ? doubled : floor,
    };
  }
  const price = (gasPrice * 12n + 9n) / 10n;
  return { baseFeePerGas: null, maxPriorityFeePerGas: price, maxFeePerGas: price, legacy: true };
}

async function latestBaseFee(network: EvmNetwork, opts?: RpcOptions): Promise<bigint | null> {
  const block = await retryOnce(
    () =>
      rpcCall<{ baseFeePerGas?: string } | null>(
        network.rpcUrl,
        'eth_getBlockByNumber',
        ['latest', false],
        opts
      ),
    opts?.signal
  );
  if (!block || block.baseFeePerGas === undefined || block.baseFeePerGas === null) return null;
  return quantity(block.baseFeePerGas, 'base fee');
}

/**
 * Tip is the median of recent 50th percentile rewards; max fee is twice the next base fee plus
 * the tip, which survives about six full blocks of base fee growth.
 */
export async function estimateFees(network: EvmNetwork, opts?: RpcOptions): Promise<EvmFees> {
  const [history, gasPrice] = await Promise.all([
    retryOnce(
      () =>
        rpcCall<FeeHistory>(
          network.rpcUrl,
          'eth_feeHistory',
          [toQuantity(BigInt(FEE_BLOCKS)), 'latest', [50]],
          opts
        ),
      opts?.signal
    ).then(
      (h) => ({ supported: true as const, history: h }),
      (e: unknown) => {
        if (!opts?.signal?.aborted && isMethodUnsupported(e)) {
          return { supported: false as const, history: null as FeeHistory | null };
        }
        throw e;
      }
    ),
    retryOnce(
      async () =>
        quantity(await rpcCall<string>(network.rpcUrl, 'eth_gasPrice', [], opts), 'gas price'),
      opts?.signal
    ),
  ]);
  const fees =
    feesFromHistory(history.history) ??
    feesFromGasPrice(gasPrice, history.supported ? null : await latestBaseFee(network, opts));
  if (feeCeilingProblem(network.chainId, fees.maxFeePerGas, gasPrice)) throw new FeeCeilingError();
  return fees;
}

/** Adds 20% headroom, except a plain 21000 transfer which always costs exactly that. */
export async function estimateGas(
  network: EvmNetwork,
  req: GasRequest,
  opts?: RpcOptions
): Promise<bigint> {
  if (!isEvmAddress(req.from)) throw new Error('Invalid sender address');
  if (req.to !== null && !isEvmAddress(req.to)) throw new Error('Invalid recipient address');
  if (typeof req.value !== 'bigint' || req.value < 0n) throw new Error('Invalid value');
  if (!isHex(req.data) || req.data.length % 2) throw new Error('Invalid transaction data');
  const gas = quantity(
    await rpcCall<string>(
      network.rpcUrl,
      'eth_estimateGas',
      [
        {
          from: req.from,
          ...(req.to === null ? {} : { to: req.to }),
          value: toQuantity(req.value),
          data: req.data,
        },
      ],
      opts
    ),
    'gas estimate'
  );
  if (gas === TRANSFER_GAS) return gas;
  return (gas * 120n + 99n) / 100n;
}

export async function prepareTransfer(
  params: {
    network: EvmNetwork;
    from: string;
    to: string;
    token: EvmToken;
    amount: bigint;
  },
  opts?: RpcOptions
): Promise<PreparedTransfer> {
  const { network, from, to, token, amount } = params;
  if (token.chainId !== network.chainId) throw new Error('Token is on a different network');
  if (!isEvmAddress(from)) throw new Error('Invalid sender address');
  if (!isEvmAddress(to)) throw new Error('Invalid recipient address');
  if (typeof amount !== 'bigint' || amount <= 0n) throw new Error('Invalid amount');
  if (token.address !== null && !isEvmAddress(token.address)) {
    throw new Error('Invalid token address');
  }
  const call =
    token.address === null
      ? { to, value: amount, data: '0x' }
      : { to: token.address, value: 0n, data: erc20TransferData(to, amount) };
  const [nonce, fees, gasLimit] = await Promise.all([
    getNonce(network, from, opts),
    estimateFees(network, opts),
    estimateGas(network, { from, ...call }, opts),
  ]);
  const feeWei = gasLimit * fees.maxFeePerGas;
  return {
    tx: {
      chainId: network.chainId,
      nonce,
      maxPriorityFeePerGas: fees.maxPriorityFeePerGas,
      maxFeePerGas: fees.maxFeePerGas,
      gasLimit,
      ...call,
      ...(fees.legacy ? { legacy: true as const } : {}),
    },
    feeWei,
    totalNative: call.value + feeWei,
    fees,
  };
}

export async function broadcast(
  network: EvmNetwork,
  raw: string,
  opts?: RpcOptions
): Promise<string> {
  if (!isHex(raw) || raw.length < 4 || raw.length % 2)
    throw new Error('Invalid signed transaction');
  const hash = await rpcCall<string>(network.rpcUrl, 'eth_sendRawTransaction', [raw], opts);
  if (!isHex(hash) || hash.length !== 66) throw new Error('Bad transaction hash from the network');
  return hash;
}

export async function waitForReceipt(
  network: EvmNetwork,
  hash: string,
  {
    signal,
    timeoutMs = 180_000,
    intervalMs = 3_000,
  }: {
    signal?: AbortSignal;
    timeoutMs?: number;
    intervalMs?: number;
  } = {}
): Promise<EvmReceipt> {
  if (!isHex(hash) || hash.length !== 66) throw new Error('Invalid transaction hash');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let receipt: { status?: string; blockNumber?: string } | null = null;
    try {
      receipt = await rpcCall(network.rpcUrl, 'eth_getTransactionReceipt', [hash], { signal });
    } catch (e) {
      if (signal?.aborted) throw e;
    }
    if (receipt && receipt.blockNumber) {
      return {
        status: receipt.status === '0x1' ? 'success' : 'failed',
        blockNumber: Number(quantity(receipt.blockNumber, 'block number')),
      };
    }
    const left = deadline - Date.now();
    if (left <= 0) throw new Error('Timed out waiting for the transaction');
    await wait(Math.min(intervalMs, left), signal);
  }
}

export function settleAfterTimeout(
  receipt: EvmReceipt | null,
  latestNonce: number | null,
  nonce: number
): TxWatch {
  if (receipt) return { state: receipt.status, blockNumber: receipt.blockNumber };
  if (latestNonce !== null && latestNonce > nonce) return { state: 'replaced', blockNumber: null };
  return { state: 'pending', blockNumber: null };
}

async function readReceipt(
  network: EvmNetwork,
  hash: string,
  signal?: AbortSignal
): Promise<EvmReceipt | null> {
  try {
    const r = await rpcCall<{ status?: string; blockNumber?: string } | null>(
      network.rpcUrl,
      'eth_getTransactionReceipt',
      [hash],
      { signal }
    );
    if (!r || !r.blockNumber) return null;
    return {
      status: r.status === '0x1' ? 'success' : 'failed',
      blockNumber: Number(quantity(r.blockNumber, 'block number')),
    };
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

async function readLatestNonce(
  network: EvmNetwork,
  from: string,
  signal?: AbortSignal
): Promise<number | null> {
  try {
    const n = quantity(
      await rpcCall<string>(network.rpcUrl, 'eth_getTransactionCount', [from, 'latest'], {
        signal,
      }),
      'nonce'
    );
    return n > BigInt(Number.MAX_SAFE_INTEGER) ? null : Number(n);
  } catch (e) {
    if (signal?.aborted) throw e;
    return null;
  }
}

/**
 * Follows a signed tx by its own hash until it has a receipt, its nonce is used by another tx
 * (seen twice in a row), or time runs out. With `raw`, the same signed bytes are sent once more,
 * which can never spend twice.
 */
export async function watchTransaction(
  network: EvmNetwork,
  sent: { hash: string; nonce: number; from: string; raw?: string },
  {
    signal,
    timeoutMs = 300_000,
    intervalMs = 3_000,
    nonceEvery = 4,
  }: { signal?: AbortSignal; timeoutMs?: number; intervalMs?: number; nonceEvery?: number } = {}
): Promise<TxWatch> {
  if (!isHex(sent.hash) || sent.hash.length !== 66) throw new Error('Invalid transaction hash');
  if (!isEvmAddress(sent.from)) throw new Error('Invalid sender address');
  const deadline = Date.now() + timeoutMs;
  let resend = sent.raw ?? null;
  let polls = 0;
  let ahead = 0;
  for (;;) {
    const receipt = await readReceipt(network, sent.hash, signal);
    if (receipt) return { state: receipt.status, blockNumber: receipt.blockNumber };
    if (resend) {
      const raw = resend;
      resend = null;
      await broadcast(network, raw, { signal }).catch((e: unknown) => {
        if (signal?.aborted) throw e;
      });
    }
    polls++;
    if (polls % nonceEvery === 0) {
      const latest = await readLatestNonce(network, sent.from, signal);
      ahead = latest !== null && latest > sent.nonce ? ahead + 1 : 0;
      if (ahead >= 2) return { state: 'replaced', blockNumber: null };
    }
    const left = deadline - Date.now();
    if (left <= 0) {
      const [last, latest] = await Promise.all([
        readReceipt(network, sent.hash, signal),
        readLatestNonce(network, sent.from, signal),
      ]);
      return settleAfterTimeout(last, latest, sent.nonce);
    }
    await wait(Math.min(intervalMs, left), signal);
  }
}
