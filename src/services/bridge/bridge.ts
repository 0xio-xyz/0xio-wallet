import { networkService } from '../network/NetworkService';
import { TxScopeError, assertTxScope, captureTxScope, resolveNetworkPin } from '../network/txScope';
import { RpcHttpError, RpcResponseError, TxOutcomeUnknownError } from '../network/txOutcome';
import { evmNetworksFor, type EvmNetwork } from '../evm/networks';
import { findNetwork } from '../evm/registry';
import { rpcCall } from '../evm/rpc';
import { addressCall, readUint, verifyAndMintData } from './abi';
import { BRIDGE, CLAIM_REVERT, SELECTOR, TOPIC } from './constants';

export const ethereumMainnet = async (): Promise<EvmNetwork> => {
  const net =
    (await findNetwork(BRIDGE.ethChainId).catch((): null => null)) ??
    evmNetworksFor('mainnet').find((n) => n.chainId === BRIDGE.ethChainId);
  if (!net) throw new Error('Ethereum is not configured');
  return net;
};

type CallResult = { ok: true; result: string } | { ok: false; revert: string | null };

async function ethCall(to: string, data: string, from?: string): Promise<CallResult> {
  const res = await fetch((await ethereumMainnet()).rpcUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'eth_call',
      params: [{ to, data, ...(from ? { from } : {}) }, 'latest'],
    }),
    signal: AbortSignal.timeout(12_000),
  });
  if (!res.ok) throw new Error(`Ethereum RPC HTTP ${res.status}`);
  const body = (await res.json()) as {
    result?: string;
    error?: { data?: unknown; message?: string };
  };
  if (typeof body.result === 'string') return { ok: true, result: body.result };
  const raw = body.error?.data;
  const revert =
    typeof raw === 'string'
      ? raw
      : raw && typeof raw === 'object' && typeof (raw as { data?: unknown }).data === 'string'
        ? (raw as { data: string }).data
        : null;
  if (!body.error) throw new Error('Ethereum RPC: empty response');
  return { ok: false, revert };
}

async function readEth(to: string, data: string): Promise<bigint> {
  const r = await ethCall(to, data);
  if (!r.ok) throw new Error('Ethereum read failed');
  return readUint(r.result);
}

export interface BridgeHealth {
  ethPaused: boolean;
  octraPaused: boolean | null;
  mintCapPerTx: bigint;
  mintLeftToday: bigint;
}

export const VAULT_READ_MS = 2_000;
export const FEE_READ_MS = 10_000;
const KEEP_MS = 30_000;

async function octraVaultPaused(): Promise<boolean | null> {
  const vault = await networkService
    .jsonRpcCall(
      'contract_call',
      [BRIDGE.octraVault, 'is_paused', '', BRIDGE.octraVault],
      true,
      await resolveNetworkPin('mainnet'),
      { timeoutMs: VAULT_READ_MS }
    )
    .catch((): null => null);
  const v = vault && typeof vault === 'object' && 'result' in vault ? vault.result : vault;
  return v === null || v === undefined || v === ''
    ? null
    : v === '1' || v === 1 || v === true || v === 'true';
}

export async function bridgeHealth(): Promise<BridgeHealth> {
  const [paused, perTx, daily, minted, octraPaused] = await Promise.all([
    readEth(BRIDGE.ethBridge, SELECTOR.paused),
    readEth(BRIDGE.ethBridge, SELECTOR.mintCapPerTx),
    readEth(BRIDGE.ethBridge, SELECTOR.mintCapDaily),
    readEth(BRIDGE.ethBridge, SELECTOR.mintedToday),
    octraVaultPaused(),
  ]);
  return {
    ethPaused: paused !== 0n,
    octraPaused,
    mintCapPerTx: perTx,
    mintLeftToday: daily > minted ? daily - minted : 0n,
  };
}

export interface LockFee {
  minimum: bigint;
  recommended: bigint;
}

export async function lockFeeQuote(): Promise<LockFee | null> {
  const q = await networkService.getRecommendedFeeStrict(
    'call',
    await resolveNetworkPin('mainnet'),
    { timeoutMs: FEE_READ_MS }
  );
  if (!q) return null;
  const recommended = BigInt(q.recommended);
  const minimum = BigInt(q.minimum);
  return { minimum, recommended: recommended > minimum ? recommended : minimum };
}

class KeptRead<T> {
  private readonly kept = new Map<string, { at: number; value: T }>();
  private readonly runs = new Map<string, Promise<T>>();
  private readonly read: () => Promise<T>;

  constructor(read: () => Promise<T>) {
    this.read = read;
  }

  get(side: string): Promise<T> {
    const kept = this.kept.get(side);
    if (kept && Date.now() - kept.at < KEEP_MS) return Promise.resolve(kept.value);
    const running = this.runs.get(side);
    if (running) return running;
    const run = this.read();
    this.runs.set(side, run);
    run.then(
      (value) => {
        if (this.runs.get(side) !== run) return;
        this.runs.delete(side);
        this.kept.set(side, { at: Date.now(), value });
      },
      () => {
        if (this.runs.get(side) === run) this.runs.delete(side);
      }
    );
    return run;
  }

  forget(side: string): void {
    this.kept.delete(side);
    this.runs.delete(side);
  }
}

const health = new KeptRead(bridgeHealth);

export const cachedBridgeHealth = (side: 'mainnet' = 'mainnet'): Promise<BridgeHealth> =>
  health.get(side);

export const cachedLockFee = (): Promise<LockFee | null> => lockFeeQuote();

export function forgetBridgeHealth(side: 'mainnet' = 'mainnet'): void {
  health.forget(side);
}

export async function wOctAllowance(owner: string): Promise<bigint> {
  return readEth(BRIDGE.wOCT, addressCall(SELECTOR.allowance, owner, BRIDGE.ethBridge));
}

export class LockFeeRaisedError extends Error {
  readonly ouRaw: bigint;
  constructor(ouRaw: bigint) {
    super('Network fee went up');
    this.name = 'LockFeeRaisedError';
    this.ouRaw = ouRaw;
  }
}

const refusedAtTheDoor = (e: unknown) =>
  e instanceof RpcHttpError && ((e.status >= 400 && e.status < 500) || e.status === 503);

/**
 * Locks OCT in the Octra vault for an Ethereum address, signing the fee the review showed. Returns
 * the hash the node gave back. Throws TxOutcomeUnknownError when the lock may have reached the
 * node; every other error means nothing was sent.
 */
export async function lockToEth(args: {
  from: string;
  privateKey: string;
  publicKey?: string;
  amountRaw: bigint;
  ethRecipient: string;
  ouRaw: bigint;
}): Promise<string> {
  if (args.amountRaw < BRIDGE.minLockRaw) throw new Error('Minimum amount is 1 OCT');
  if (!/^0x[0-9a-fA-F]{40}$/.test(args.ethRecipient)) throw new Error('Invalid Ethereum address');
  if (args.ouRaw <= 0n) throw new Error('Invalid network fee');
  const scope = await captureTxScope(args.from, 'mainnet');
  await assertTxScope(scope);
  const live = await lockFeeQuote().catch((): null => null);
  if (live && live.minimum > args.ouRaw) throw new LockFeeRaisedError(live.recommended);
  const nonce = await networkService.getNextNonce(args.from, scope);
  const release = () => networkService.releaseNonce(args.from, nonce, scope.networkId);
  let signed;
  try {
    signed = await networkService.buildContractCallTransaction({
      from: args.from,
      contract: BRIDGE.octraVault,
      method: 'lock_to_eth',
      callParams: [args.ethRecipient],
      amount: args.amountRaw.toString(),
      nonce,
      ou: args.ouRaw.toString(),
      privateKey: args.privateKey,
      publicKey: args.publicKey,
    });
    await assertTxScope(scope);
  } catch (e) {
    release();
    throw e;
  }
  let res;
  try {
    res = await networkService.jsonRpcCall('octra_submit', [signed], undefined, scope);
  } catch (e) {
    if (e instanceof TxScopeError || e instanceof RpcResponseError || refusedAtTheDoor(e)) {
      release();
      throw e;
    }
    throw new TxOutcomeUnknownError('The lock may have reached Octra without an answer');
  }
  if (res?.status === 'rejected') {
    release();
    throw new RpcResponseError(
      res.error?.reason || res.error?.message || 'Transaction rejected',
      res.error
    );
  }
  const hash = res?.tx_hash || res?.hash || res?.txHash || res?.transaction_hash;
  if (!hash) throw new TxOutcomeUnknownError('The node took the lock without a hash');
  return String(hash);
}

export interface LockedEvent {
  hash: string;
  epoch: number;
  amountRaw: bigint;
  ethAddress: string;
  srcNonce: number;
}

export type LockProgress =
  | { state: 'pending'; hash: string | null }
  | { state: 'failed'; hash: string; reason: string }
  | { state: 'confirmed'; locked: LockedEvent };

const sameAmount = (t: Record<string, unknown>, amountRaw: bigint) =>
  [t.amount_raw, t.amount].some((v) => {
    if (v === undefined || v === null || v === '') return false;
    const text = String(v);
    if (/^\d+$/.test(text) && BigInt(text) === amountRaw) return true;
    const oct = Number(text);
    return Number.isFinite(oct) && Math.round(oct * 1e6) === Number(amountRaw);
  });

/**
 * A vault lock in an address's transaction list. The list no longer carries the method name or a
 * status (it holds confirmed transactions; refusals sit in `rejected`), so a call to the vault
 * whose only argument is a 0x address counts as lock_to_eth; the receipt check confirms it.
 */
export function isVaultLock(t: Record<string, unknown>): boolean {
  if ((t.to_ ?? t.to) !== BRIDGE.octraVault) return false;
  const method = t.encrypted_data ?? t.method;
  if (typeof method === 'string' && method) return method === 'lock_to_eth';
  if (t.op_type !== 'call' || typeof t.message !== 'string') return false;
  try {
    const params: unknown = JSON.parse(t.message);
    return (
      Array.isArray(params) &&
      params.length === 1 &&
      typeof params[0] === 'string' &&
      /^0x[0-9a-fA-F]{40}$/.test(params[0])
    );
  } catch {
    return false;
  }
}

export async function lockProgress(
  hash: string | null,
  octAddress: string,
  sentAtMs: number,
  amountRaw?: bigint
): Promise<LockProgress> {
  let realHash = hash;
  let tx = hash
    ? await networkService.jsonRpcCall('octra_transaction', [hash], true).catch((): null => null)
    : null;
  if (!tx && (!hash || Date.now() - sentAtMs > 10_000)) {
    const hist = await networkService
      .jsonRpcCall('octra_transactionsByAddress', [octAddress, 10, 0], true)
      .catch((): null => null);
    const list: Array<Record<string, unknown>> =
      hist?.transactions ?? (Array.isArray(hist) ? hist : []);
    const match = list.find(
      (t) =>
        isVaultLock(t) &&
        Math.abs(Number(t.timestamp ?? 0) * 1000 - sentAtMs) < 10 * 60_000 &&
        (amountRaw === undefined || sameAmount(t, amountRaw))
    );
    if (match?.hash) {
      realHash = String(match.hash);
      tx = { ...match, status: match.status ?? 'confirmed' };
    }
  }
  if (!tx) return { state: 'pending', hash: realHash };
  const txHash: string = realHash ?? String(tx.hash);
  if (tx.status === 'rejected' || tx.status === 'dropped') {
    return { state: 'failed', hash: txHash, reason: String(tx.status) };
  }
  if (tx.status !== 'confirmed') return { state: 'pending', hash: txHash };

  const receipt = await networkService.jsonRpcCall('contract_receipt', [txHash], true);
  if (!receipt) return { state: 'pending', hash: txHash };
  if (receipt.success === false) {
    return { state: 'failed', hash: txHash, reason: String(receipt.error ?? 'lock failed') };
  }
  const ev = (receipt.events ?? []).find((e: { event?: string }) => e.event === 'Locked');
  if (!ev || !Array.isArray(ev.values) || ev.values.length < 4) {
    return { state: 'failed', hash: txHash, reason: 'No Locked event in the receipt' };
  }
  const [, lockedRaw, ethAddress, nonce] = ev.values;
  return {
    state: 'confirmed',
    locked: {
      hash: txHash,
      epoch: Number(receipt.epoch ?? tx.epoch ?? 0),
      amountRaw: BigInt(String(lockedRaw)),
      ethAddress: String(ethAddress),
      srcNonce: parseInt(String(nonce), 10),
    },
  };
}

export type ClaimCheck =
  | { state: 'waiting' }
  | { state: 'claimable'; data: string }
  | { state: 'claimed' }
  | { state: 'blocked'; reason: 'cap' | 'proof' | 'unknown' };

async function signerCalldata(epoch: number, recipient: string): Promise<string | null> {
  const call = async (method: string, params: unknown[]) => {
    const res = await fetch(BRIDGE.signerUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
      signal: AbortSignal.timeout(12_000),
    });
    if (!res.ok) throw new Error(`Signer HTTP ${res.status}`);
    return (await res.json())?.result;
  };
  try {
    const msgs = await call('bridgeMessagesByEpoch', [epoch]);
    const mine = (msgs?.messages ?? []).find(
      (m: { recipient?: string }) => m.recipient?.toLowerCase() === recipient.toLowerCase()
    );
    if (!mine) return null;
    const cd = await call('bridgeClaimCalldata', [epoch, mine.leaf_index]);
    return typeof cd?.calldata === 'string' ? cd.calldata : null;
  } catch {
    return null;
  }
}

const revertOf = (r: CallResult): string | null => ('revert' in r ? r.revert : null);

function classify(revert: string | null): ClaimCheck | 'proof' {
  const kind = revert ? CLAIM_REVERT[revert.slice(0, 10).toLowerCase()] : undefined;
  if (kind === 'claimed') return { state: 'claimed' };
  if (kind === 'waiting') return { state: 'waiting' };
  if (kind === 'cap') return { state: 'blocked', reason: 'cap' };
  if (kind === 'proof') return 'proof';
  return { state: 'blocked', reason: 'unknown' };
}

export async function claimCheck(locked: LockedEvent, sender: string): Promise<ClaimCheck> {
  const latest = await readEth(BRIDGE.lightClient, SELECTOR.latestEpoch);
  if (latest < BigInt(locked.epoch)) return { state: 'waiting' };
  const ours = verifyAndMintData({
    epoch: locked.epoch,
    recipient: locked.ethAddress,
    amountRaw: locked.amountRaw,
    srcNonce: locked.srcNonce,
  });
  const sim = await ethCall(BRIDGE.ethBridge, ours, sender);
  if (sim.ok) return { state: 'claimable', data: ours };
  const first = classify(revertOf(sim));
  if (first !== 'proof') return first;
  const fromSigner = await signerCalldata(locked.epoch, locked.ethAddress);
  if (!fromSigner) return { state: 'blocked', reason: 'proof' };
  const second = await ethCall(BRIDGE.ethBridge, fromSigner, sender);
  if (second.ok) return { state: 'claimable', data: fromSigner };
  const again = classify(revertOf(second));
  return again === 'proof' ? { state: 'blocked', reason: 'proof' } : again;
}

export async function burnMessageId(hash: string): Promise<string | null> {
  const receipt = await rpcCall<{ logs?: Array<{ address?: string; topics?: string[] }> } | null>(
    (await ethereumMainnet()).rpcUrl,
    'eth_getTransactionReceipt',
    [hash]
  );
  const log = receipt?.logs?.find(
    (l) =>
      l.address?.toLowerCase() === BRIDGE.ethBridge.toLowerCase() &&
      l.topics?.[0]?.toLowerCase() === TOPIC.burnToOctra
  );
  return log?.topics?.[1] ?? null;
}

export async function findUnlock(args: {
  messageId: string | null;
  recipient: string;
  amountRaw: bigint;
  burnedAtMs: number;
}): Promise<string | null> {
  const pageSize = 50;
  for (let page = 0; page < 6; page++) {
    const res = await networkService.jsonRpcCall(
      'octra_transactionsByAddress',
      [BRIDGE.octraVault, pageSize, page * pageSize],
      true
    );
    const txs: Array<Record<string, unknown>> = res?.transactions ?? [];
    for (const tx of txs) {
      if (tx.encrypted_data !== 'unlock_trusted' || tx.status === 'rejected') continue;
      let fields: unknown[] = [];
      try {
        fields = JSON.parse(String(tx.message ?? '[]'));
      } catch {
        continue;
      }
      const [to, amount, ref] = fields.map(String);
      const byId = !!args.messageId && ref?.toLowerCase() === args.messageId.toLowerCase();
      const byTransfer =
        to === args.recipient &&
        amount === args.amountRaw.toString() &&
        (!tx.timestamp || Number(tx.timestamp) * 1000 >= args.burnedAtMs - 60_000);
      if (byId || byTransfer) return String(tx.hash ?? tx.tx_hash ?? '');
    }
    const oldest = txs[txs.length - 1];
    if (
      txs.length < pageSize ||
      (oldest?.timestamp && Number(oldest.timestamp) * 1000 < args.burnedAtMs - 10 * 60_000)
    ) {
      return null;
    }
  }
  return null;
}
