// networkService.contractCall resolves on mempool acceptance, NOT
// execution: a call can settle `confirmed` (fee charged) while it reverted. So poll to
// settlement, then RE-READ the intended on-chain state to prove the effect actually landed.

import { networkService } from 'src/services/network/NetworkService';
import { txScopeMismatch, type TxScope } from 'src/services/network/txScope';

export type TxStatus = 'confirmed' | 'rejected' | 'dropped' | 'timeout' | 'switched';
export interface Receipt {
  status: TxStatus;
  reason: string | null;
}

interface RawReceipt {
  status?: string;
  error?: { type?: string; reason?: string };
  reject_reason?: string;
}

const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));

const SWITCHED: Receipt = {
  status: 'switched',
  reason:
    'The network or wallet changed before this transaction settled. Switch back to see its result.',
};

export async function waitForReceipt(
  txHash: string,
  scope: TxScope,
  opts: { intervalMs?: number; timeoutMs?: number } = {}
): Promise<Receipt> {
  const intervalMs = opts.intervalMs ?? 2500;
  const timeoutMs = opts.timeoutMs ?? 60000;
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await txScopeMismatch(scope)) return SWITCHED;
    try {
      const r = (await networkService.jsonRpcCall(
        'octra_transaction',
        [txHash],
        true,
        scope
      )) as RawReceipt | null;
      if (await txScopeMismatch(scope)) return SWITCHED;
      const status = r?.status;
      if (status && status !== 'pending') {
        const raw = r?.error?.reason ?? r?.reject_reason ?? null;
        return { status: status as TxStatus, reason: raw ? parseChainError(raw) : null };
      }
    } catch {}
    await sleep(intervalMs);
  }
  return { status: 'timeout', reason: null };
}

export function parseChainError(reason: string): string {
  const m = reason.match(/execution reverted\s*\[[^:\]]*:\s*([^\]]+)\]/i);
  let msg = (m ? m[1] : reason).trim();
  const colon = msg.indexOf(':');
  if (colon > -1 && colon < 24) msg = msg.slice(colon + 1).trim();
  return msg ? msg.charAt(0).toUpperCase() + msg.slice(1) : reason;
}

export async function verifyEffect(check: () => Promise<boolean>): Promise<boolean> {
  try {
    return await check();
  } catch {
    return false;
  }
}
