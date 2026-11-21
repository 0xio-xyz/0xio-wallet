import { networkService } from '../network/NetworkService';
import { rawTransactions } from '../evm/history';
import { rpcCall } from '../evm/rpc';
import { burnMessageId, ethereumMainnet, isVaultLock, lockProgress } from './bridge';
import { BRIDGE, SELECTOR } from './constants';
import type { BridgeTransfer } from './transfers';

const LOCK_PAGES = 4;
const LOCK_PAGE_SIZE = 30;

export function decodeBurn(input: string): { amountRaw: bigint; octra: string } | null {
  if (!input?.toLowerCase().startsWith(SELECTOR.burnToOctra)) return null;
  const hex = input.slice(10);
  if (hex.length < 64 * 3) return null;
  const word = (i: number) => hex.slice(i * 64, (i + 1) * 64);
  const amountRaw = BigInt('0x' + word(1));
  const offset = Number(BigInt('0x' + word(0))) / 32;
  const len = Number(BigInt('0x' + word(offset)));
  if (!Number.isSafeInteger(len) || len <= 0 || len > 128) return null;
  const bytes = hex.slice((offset + 1) * 64, (offset + 1) * 64 + len * 2);
  if (bytes.length !== len * 2) return null;
  const octra = new TextDecoder().decode(
    Uint8Array.from(bytes.match(/../g)!.map((b) => parseInt(b, 16)))
  );
  return { amountRaw, octra };
}

const knownHashes = (list: BridgeTransfer[]) =>
  new Set(
    list
      .flatMap((t) => [t.lockHash, t.locked?.hash, t.burnHash, t.claimHash, t.approveHash])
      .filter((h): h is string => !!h)
      .map((h) => h.toLowerCase())
  );

async function lockTransfer(
  hash: string,
  octAddress: string,
  evmAddress: string | null,
  sentAtMs: number
): Promise<BridgeTransfer | null> {
  const p = await lockProgress(hash, octAddress, sentAtMs);
  if (p.state === 'failed') return null;
  const now = Date.now();
  if (p.state === 'pending') {
    return {
      id: `o2e-${hash.slice(0, 12)}`,
      direction: 'o2e',
      amountRaw: '0',
      octAddress,
      evmAddress: evmAddress ?? '',
      recipient: evmAddress ?? '',
      createdAt: sentAtMs,
      updatedAt: now,
      status: 'locking',
      lockHash: p.hash ?? hash,
    };
  }
  const { locked } = p;
  return {
    id: `o2e-${locked.hash.slice(0, 12)}`,
    direction: 'o2e',
    amountRaw: locked.amountRaw.toString(),
    octAddress,
    evmAddress: evmAddress ?? locked.ethAddress,
    recipient: locked.ethAddress,
    createdAt: sentAtMs,
    updatedAt: now,
    status: 'waiting',
    lockHash: locked.hash,
    locked: { ...locked, amountRaw: locked.amountRaw.toString() },
  };
}

async function burnTransfer(
  hash: string,
  octAddress: string,
  evmAddress: string | null,
  at: number
): Promise<BridgeTransfer | null> {
  const tx = await rpcCall<{ input?: string; to?: string; from?: string } | null>(
    (await ethereumMainnet()).rpcUrl,
    'eth_getTransactionByHash',
    [hash]
  );
  if (!tx || tx.to?.toLowerCase() !== BRIDGE.ethBridge.toLowerCase()) return null;
  const burn = decodeBurn(tx.input ?? '');
  if (!burn) return null;
  const now = Date.now();
  return {
    id: `e2o-${hash.slice(0, 12)}`,
    direction: 'e2o',
    amountRaw: burn.amountRaw.toString(),
    octAddress,
    evmAddress: evmAddress ?? tx.from ?? '',
    recipient: burn.octra,
    createdAt: at,
    updatedAt: now,
    status: 'unlocking',
    burnHash: hash,
    burnedAt: at,
    messageId: await burnMessageId(hash).catch((): null => null),
  };
}

export async function recoverTransfers(args: {
  octAddress: string;
  evmAddress: string | null;
  known: BridgeTransfer[];
}): Promise<BridgeTransfer[]> {
  const known = knownHashes(args.known);
  const found: BridgeTransfer[] = [];

  for (let page = 0; page < LOCK_PAGES; page++) {
    const res = await networkService.jsonRpcCall(
      'octra_transactionsByAddress',
      [args.octAddress, LOCK_PAGE_SIZE, page * LOCK_PAGE_SIZE],
      true
    );
    const txs: Array<Record<string, unknown>> = res?.transactions ?? [];
    for (const tx of txs) {
      const hash = String(tx.hash ?? tx.tx_hash ?? '');
      if (!hash || known.has(hash.toLowerCase())) continue;
      if (!isVaultLock(tx)) continue;
      if (tx.status !== undefined && tx.status !== 'confirmed') continue;
      const t = await lockTransfer(
        hash,
        args.octAddress,
        args.evmAddress,
        Number(tx.timestamp ?? 0) * 1000
      );
      if (t) {
        found.push(t);
        known.add(hash.toLowerCase());
      }
    }
    if (txs.length < LOCK_PAGE_SIZE) break;
  }

  if (!args.evmAddress) return found;
  const evmTxs = await rawTransactions(BRIDGE.ethChainId, args.evmAddress).catch(
    (): Array<Record<string, unknown>> => []
  );
  for (const tx of evmTxs) {
    const hash = String(tx.hash ?? '');
    const to = (tx.to as { hash?: string } | null)?.hash?.toLowerCase();
    if (!hash || known.has(hash.toLowerCase()) || to !== BRIDGE.ethBridge.toLowerCase()) continue;
    if (tx.status === 'error') continue;
    const at = Date.parse(String(tx.timestamp ?? '')) || Date.now();
    const t = await burnTransfer(hash, args.octAddress, args.evmAddress, at);
    if (t) {
      found.push(t);
      known.add(hash.toLowerCase());
    }
  }
  return found;
}

export async function transferFromHash(args: {
  hash: string;
  octAddress: string;
  evmAddress: string | null;
}): Promise<BridgeTransfer | null> {
  const hash = args.hash.trim();
  if (/^0x[0-9a-fA-F]{64}$/.test(hash)) {
    return burnTransfer(hash, args.octAddress, args.evmAddress, Date.now());
  }
  if (/^[0-9a-fA-F]{64}$/.test(hash)) {
    return lockTransfer(hash, args.octAddress, args.evmAddress, Date.now());
  }
  return null;
}
