import type { TransactionHistoryItem, TokenTransferInfo } from 'src/types/transaction';

export interface TokenCall {
  recipient: string;
  raw_amount: string;
  native?: { label: string };
}

/** Contract events that pay native OCT to an address: [recipient, micro-OCT, ...]. */
const NATIVE_PAYOUTS: Record<string, string> = {
  Unlocked: 'Bridge unlock',
};

export function nativePayoutFromEvent(
  receipt: ContractReceipt | null | undefined
): TokenCall | null {
  for (const e of receipt?.events || []) {
    const label = NATIVE_PAYOUTS[String(e.event || '')];
    if (!label) continue;
    const v = (e.values || []).map((x) => String(x));
    if (v.length >= 2 && /^oct/i.test(v[0]) && /^\d+$/.test(v[1])) {
      return { recipient: v[0], raw_amount: v[1], native: { label } };
    }
  }
  return null;
}

interface ContractReceipt {
  method?: string;
  events?: Array<{ event?: string; values?: unknown[] }>;
}

export interface ContractKind {
  kind: 'token' | 'nft';
  name?: string;
  symbol?: string;
  decimals?: number;
}

export const TRANSFER_METHODS = new Set(['transfer', 'transfer_from', 'safe_transfer_from']);

/** The Transferred event names both sides: [from, to, amount or token id], or [to, amount] on older contracts. */
export function transferFromEvent(receipt: ContractReceipt | null | undefined): TokenCall | null {
  for (const e of receipt?.events || []) {
    if (!String(e.event || '').startsWith('Transfer')) continue;
    const v = (e.values || []).map((x) => String(x));
    if (v.length >= 3) return { recipient: v[1], raw_amount: v[2] };
    if (v.length === 2) return { recipient: v[0], raw_amount: v[1] };
  }
  return null;
}

export function transferArgs(tx: { message?: string | null } | null | undefined): TokenCall | null {
  if (!tx?.message) return null;
  try {
    const args = JSON.parse(tx.message);
    if (Array.isArray(args) && args.length >= 2) {
      return { recipient: String(args[0]), raw_amount: String(args[1]) };
    }
  } catch {}
  return null;
}

export function classifyTx(
  tx: { from?: string; to?: string; opType?: string },
  address: string
): { isStealth: boolean; notParty: boolean; ownCall: boolean; isIncoming: boolean } {
  const me = address.toLowerCase();
  const from = (tx.from || '').toLowerCase();
  const to = (tx.to || '').toLowerCase();
  const isStealth = to === 'stealth';
  const notParty = !isStealth && !!from && !!to && from !== me && to !== me;
  const ownCall = tx.opType === 'call' && from === me && to !== me;
  const isIncoming = !isStealth && ((to === me && from !== me) || notParty);
  return { isStealth, notParty, ownCall, isIncoming };
}

export interface TransferDeps {
  networkId: string;
  rpc: (method: string, params: unknown[]) => Promise<any>;
  abiMethods: (contract: string) => Promise<string[]>;
  held: () => Promise<
    Array<{ contractAddress: string; name?: string; symbol?: string; decimals?: number }>
  >;
  nftInfo: (contract: string) => Promise<{ name?: string; symbol?: string } | null>;
  tokenInfo: (contract: string) => Promise<{ symbol?: string; decimals?: number }>;
  store?: { get: (key: string) => Promise<any>; set: (key: string, value: any) => Promise<void> };
  budget?: number;
  stillOn?: () => Promise<boolean>;
}

const CALLS_KEY = 'token_calls_v2';
const KINDS_KEY = 'contract_kinds_v1';

const chromeStore = {
  get: async (key: string) => (await chrome.storage.local.get(key))[key],
  set: (key: string, value: any) => chrome.storage.local.set({ [key]: value }),
};

async function readTokenCall(
  hash: string,
  deps: TransferDeps
): Promise<TokenCall | null | undefined> {
  let receipt: ContractReceipt | null;
  try {
    receipt = (await deps.rpc('contract_receipt', [hash])) ?? null;
  } catch {
    return undefined;
  }
  if (!receipt) return null;
  if (!TRANSFER_METHODS.has(receipt.method || '')) return nativePayoutFromEvent(receipt);
  const fromEvent = transferFromEvent(receipt);
  if (fromEvent) return fromEvent;
  try {
    const detail = await deps.rpc('octra_transaction', [hash]);
    return transferArgs(detail?.parsed_tx || detail);
  } catch {
    return undefined;
  }
}

async function readContractKind(
  contract: string,
  deps: TransferDeps
): Promise<ContractKind | undefined> {
  type Held = Awaited<ReturnType<TransferDeps['held']>>;
  const held = (await deps.held().catch((): Held => [])).find(
    (t) => t.contractAddress?.toLowerCase() === contract.toLowerCase()
  );
  const methods = await deps.abiMethods(contract).catch(() => [] as string[]);
  let kind: 'token' | 'nft' | undefined;
  if (methods.length) {
    kind = methods.includes('owner_of') || methods.includes('token_uri') ? 'nft' : 'token';
  } else if (held && (held.name || held.symbol)) {
    kind = held.decimals === 0 ? 'nft' : 'token';
  }
  if (!kind) return undefined;
  if (kind === 'nft') {
    const info =
      held?.name || held?.symbol ? held : await deps.nftInfo(contract).catch((): null => null);
    if (!info) return undefined;
    return { kind, name: info.name || undefined, symbol: info.symbol || undefined };
  }
  if (held && held.symbol)
    return { kind, name: held.name, symbol: held.symbol, decimals: held.decimals };
  const info = await deps
    .tokenInfo(contract)
    .catch(() => ({}) as { symbol?: string; decimals?: number });
  return { kind, symbol: info.symbol, decimals: info.decimals };
}

export async function enrichTokenTransfers(
  txs: TransactionHistoryItem[],
  address: string,
  deps: TransferDeps
): Promise<TransactionHistoryItem[]> {
  const store = deps.store ?? chromeStore;
  const calls: Record<string, TokenCall | null> =
    (await store.get(CALLS_KEY).catch((): null => null)) || {};
  const kinds: Record<string, ContractKind> =
    (await store.get(KINDS_KEY).catch((): null => null)) || {};
  let budget = deps.budget ?? 12;
  let callsDirty = false;
  let kindsDirty = false;

  const out: TransactionHistoryItem[] = [];
  for (const tx of txs) {
    const { notParty, ownCall, isIncoming } = classifyTx(tx, address);
    if (!notParty && !ownCall) {
      out.push(tx);
      continue;
    }
    let next: TransactionHistoryItem = {
      ...tx,
      type: isIncoming ? 'incoming' : tx.type,
      amount: notParty ? 0 : tx.amount,
    };
    const onActive = (tx.network || deps.networkId) === deps.networkId;
    if (!next.token_transfer && tx.hash && onActive) {
      const callKey = `${deps.networkId}:${tx.hash}`;
      let call: TokenCall | null | undefined = calls[callKey];
      if (call === undefined && !(callKey in calls) && budget > 0) {
        budget--;
        call = await readTokenCall(tx.hash, deps);
        if (call !== undefined) {
          calls[callKey] = call;
          callsDirty = true;
        }
      }
      const toMe = !!call && call.recipient.toLowerCase() === address.toLowerCase();
      if (call?.native) {
        if (toMe) {
          next = {
            ...next,
            type: 'incoming',
            amount: parseInt(call.raw_amount, 10) / 1_000_000,
            callLabel: call.native.label,
          };
        }
      } else if (call && (ownCall || toMe)) {
        const kindKey = `${deps.networkId}:${tx.to}`;
        let kind = kinds[kindKey];
        if (!kind && budget > 0) {
          budget--;
          kind = (await readContractKind(tx.to, deps)) as ContractKind;
          if (kind && (kind.kind === 'token' || kind.name || kind.symbol)) {
            kinds[kindKey] = kind;
            kindsDirty = true;
          }
        }
        const transfer: TokenTransferInfo = {
          recipient: call.recipient,
          raw_amount: call.raw_amount,
          contract_address: tx.to,
          kind: kind?.kind,
          name: kind?.name,
          symbol: kind?.symbol,
          decimals: kind?.kind === 'nft' ? 0 : kind?.decimals,
        };
        next = { ...next, token_transfer: transfer };
      }
    }
    next.address =
      next.type === 'incoming'
        ? tx.from
        : next.token_transfer
          ? next.token_transfer.recipient
          : tx.to;
    const read = !!tx.hash && `${deps.networkId}:${tx.hash}` in calls && onActive;
    const settled = !!next.token_transfer || !!next.callLabel;
    next.insideCall = notParty && !settled && !read ? true : undefined;
    next.amountUnknown = notParty && !settled && read ? true : undefined;
    out.push(next);
  }

  if ((callsDirty || kindsDirty) && deps.stillOn && !(await deps.stillOn().catch(() => false))) {
    return txs;
  }
  if (callsDirty) await store.set(CALLS_KEY, calls).catch(() => {});
  if (kindsDirty) await store.set(KINDS_KEY, kinds).catch(() => {});
  return out;
}
