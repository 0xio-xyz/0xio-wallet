import { logger } from 'src/utils/logger';

/**
 * The bridge site's stats count transfers made in 0xio too. Only what the transfer already shows on
 * chain is sent (type, hash, amount, the addresses in the tx) with source "extension"; no key, no
 * wallet name, no install id. The oracle counts a row only once it finds the transfer on chain.
 */
const EVENT_URL = 'https://oracle.0xio.xyz/api/bridge/event';
const SENT_KEY = 'bridge_reported:mainnet';
const SENT_CAP = 300;
const TIMEOUT_MS = 8_000;

export type BridgeReportKind = 'lock' | 'burn' | 'claim' | 'any_swap';

const DIRECTION: Record<BridgeReportKind, 'o2e' | 'e2o' | 'a2o'> = {
  lock: 'o2e',
  claim: 'o2e',
  burn: 'e2o',
  any_swap: 'a2o',
};

export interface BridgeReport {
  kind: BridgeReportKind;
  txHash: string;
  amountRaw: bigint | string;
  octraAddr?: string;
  ethAddr: string;
}

const OCTRA_ADDRESS = /^oct[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const EVM_ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const EVM_HASH = /^0x[0-9a-fA-F]{64}$/;
const OCTRA_HASH = /^[0-9a-fA-F]{64}$/;
const MAX_RAW = 10n ** 15n;

const display = (raw: bigint): string => {
  const whole = raw / 1_000_000n;
  const frac = (raw % 1_000_000n).toString().padStart(6, '0').replace(/0+$/, '');
  return frac ? `${whole}.${frac}` : `${whole}`;
};

export function reportBody(r: BridgeReport): Record<string, string> | null {
  let raw: bigint;
  try {
    raw = BigInt(r.amountRaw);
  } catch {
    return null;
  }
  if (raw <= 0n || raw > MAX_RAW) return null;
  const hashOk = r.kind === 'lock' ? OCTRA_HASH.test(r.txHash) : EVM_HASH.test(r.txHash);
  if (!hashOk || !EVM_ADDRESS.test(r.ethAddr)) return null;
  if (r.octraAddr !== undefined && !OCTRA_ADDRESS.test(r.octraAddr)) return null;
  if (r.kind !== 'claim' && r.octraAddr === undefined) return null;
  return {
    event_type: r.kind,
    direction: DIRECTION[r.kind],
    ...(r.octraAddr ? { octra_addr: r.octraAddr } : {}),
    eth_addr: r.ethAddr.toLowerCase(),
    amount_raw: raw.toString(),
    amount_display: display(raw),
    tx_hash: r.txHash.toLowerCase(),
    source: 'extension',
  };
}

const sentKey = (r: BridgeReport) => `${r.kind}:${r.txHash.toLowerCase()}`;
const sentHere = new Set<string>();

async function alreadySent(key: string): Promise<boolean> {
  if (sentHere.has(key)) return true;
  sentHere.add(key);
  const stored = (await chrome.storage.local.get([SENT_KEY]))?.[SENT_KEY];
  const list: string[] = Array.isArray(stored) ? stored.filter((k) => typeof k === 'string') : [];
  if (list.includes(key)) return true;
  await chrome.storage.local.set({ [SENT_KEY]: [key, ...list].slice(0, SENT_CAP) });
  return false;
}

export function reportBridge(r: BridgeReport, networkId: string): void {
  if (networkId !== 'mainnet') return;
  const body = reportBody(r);
  if (!body) return;
  void (async () => {
    try {
      if (await alreadySent(sentKey(r))) return;
      await fetch(EVENT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        keepalive: true,
        credentials: 'omit',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (e) {
      logger.debug('[Bridge] stats report dropped', e);
    }
  })();
}

export function forgetSentReportsForTests(): void {
  sentHere.clear();
}
