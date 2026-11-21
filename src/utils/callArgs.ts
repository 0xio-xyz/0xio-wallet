import { evmNetworksFor } from 'src/services/evm/networks';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export type ArgLabel =
  | 'recipient'
  | 'amount'
  | 'expires'
  | 'asset'
  | 'toNetwork'
  | 'minReceived'
  | 'swapId'
  | 'payoutHash'
  | 'amountSent';

const LABEL_WORDS: Record<ArgLabel, string> = {
  recipient: 'Recipient',
  amount: 'Amount',
  expires: 'Expires',
  asset: 'Asset',
  toNetwork: 'To network',
  minReceived: 'Minimum received',
  swapId: 'Swap ID',
  payoutHash: 'Payout hash',
  amountSent: 'Amount sent',
};

export type ArgKind = 'address' | 'chain' | 'amount' | 'expiry' | 'epoch' | 'asset' | 'text';

const norm = (name: string) => name.replace(/[^a-zA-Z0-9]/g, '').toLowerCase();

const NAMED: Record<string, { label: ArgLabel; kind: ArgKind }> = {};
const alias = (label: ArgLabel, kind: ArgKind, ...names: string[]) => {
  for (const n of names) NAMED[n] = { label, kind };
};
alias(
  'recipient',
  'address',
  'recipient',
  'receiver',
  'to',
  'destaddr',
  'destaddress',
  'destination',
  'toaddress',
  'recipientaddress',
  'ethrecipient'
);
alias('amount', 'amount', 'amount', 'value', 'wad', 'amt', 'rawamount', 'quantity', 'qty');
alias(
  'expires',
  'expiry',
  'expiry',
  'expires',
  'expiresat',
  'expiration',
  'deadline',
  'timeout',
  'validuntil'
);
alias('asset', 'asset', 'asset', 'token', 'symbol', 'desttoken');
alias('toNetwork', 'chain', 'destchain', 'dstchain', 'tochain', 'destinationchain', 'targetchain');
alias(
  'minReceived',
  'amount',
  'minreceive',
  'minreceived',
  'minamountout',
  'amountoutmin',
  'amountoutminimum',
  'minout'
);

const ACRONYMS = new Set(['id', 'nft', 'oct', 'ou', 'usd', 'eth', 'evm', 'url', 'uri', 'bps']);

export const argLabelWords = (label: ArgLabel, t: Translate): string =>
  t(`txDetail.arg.${label}`, { defaultValue: LABEL_WORDS[label] });

export function argLabel(raw: string, t: Translate): string {
  const bare = raw.replace(/^_+|_+$/g, '');
  const known = NAMED[norm(bare)];
  if (known) return argLabelWords(known.label, t);
  const words = bare
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((w) => (ACRONYMS.has(w.toLowerCase()) ? w.toUpperCase() : w.toLowerCase()));
  if (!words.length) return raw;
  const [first, ...rest] = words;
  return [first.charAt(0).toUpperCase() + first.slice(1), ...rest].join(' ');
}

export const argKind = (raw: string): ArgKind => NAMED[norm(raw)]?.kind ?? 'text';

const NETWORK_ALIASES: Record<string, string> = {
  eth: 'Ethereum',
  ethereum: 'Ethereum',
  octra: 'Octra',
  robinhood: 'Robinhood Chain',
};

export function networkName(value: string): string {
  const key = norm(value);
  if (!key) return value;
  const listed = [...evmNetworksFor('mainnet'), ...evmNetworksFor('devnet')].find(
    (n) => norm(n.name) === key
  );
  return listed?.name ?? NETWORK_ALIASES[key] ?? value;
}

export const CALL_VALUE_MAX = 4096;

export const capCallText = (text: string): string =>
  text.length > CALL_VALUE_MAX ? `${text.slice(0, CALL_VALUE_MAX)}…` : text;

export function plausibleTime(value: unknown): number | null {
  const text = String(value ?? '').trim();
  if (!/^\d{9,13}$/.test(text)) return null;
  const n = Number(text);
  if (n >= 946_684_800 && n < 4_102_444_800) return n * 1000;
  if (n >= 946_684_800_000 && n < 4_102_444_800_000) return n;
  return null;
}

export interface ArgSpec {
  index: number;
  name: string;
  label?: ArgLabel;
  kind?: ArgKind;
  unit?:
    | { decimals: number; symbol: string }
    | { assetArg: number; decimals: Record<string, number> };
  onlyWhenUnread?: boolean;
}

export type KnownCalls = 'swapVault' | 'octBridge';

const OCT = { decimals: 6, symbol: 'OCT' };
const swapId: ArgSpec = { index: 0, name: 'intent_hash', label: 'swapId' };
const oneSwap = [swapId];

const KNOWN_CALLS: Record<KnownCalls, Record<string, ArgSpec[]>> = {
  swapVault: {
    lock: [
      { index: 1, name: 'dest_chain', label: 'toNetwork', kind: 'chain' },
      { index: 2, name: 'dest_addr', label: 'recipient', kind: 'address' },
      {
        index: 4,
        name: 'min_receive',
        label: 'minReceived',
        kind: 'amount',
        unit: { assetArg: 5, decimals: { ETH: 18 } },
      },
      { index: 5, name: 'dest_token', label: 'asset', kind: 'asset', onlyWhenUnread: true },
      { index: 3, name: 'expiry', label: 'expires', kind: 'epoch' },
      swapId,
    ],
    fill: [
      swapId,
      { index: 1, name: 'dest_tx_hash', label: 'payoutHash' },
      { index: 2, name: 'amount_sent', label: 'amountSent', kind: 'amount' },
    ],
    update_fill: [
      swapId,
      { index: 1, name: 'new_dest_tx_hash', label: 'payoutHash' },
      { index: 2, name: 'new_amount', label: 'amountSent', kind: 'amount' },
    ],
    attest: oneSwap,
    settle: oneSwap,
    refund: oneSwap,
    refund_stale_fill: oneSwap,
    slash: oneSwap,
    emergency_refund: oneSwap,
    get_swap: oneSwap,
    is_hash_used: oneSwap,
    withdraw_bond: [{ index: 0, name: 'amount', kind: 'amount', unit: OCT }],
    set_treasury: [{ index: 0, name: 'new_treasury', kind: 'address' }],
    set_oracle: [{ index: 0, name: 'new_oracle', kind: 'address' }],
    set_solver: [{ index: 0, name: 'new_solver', kind: 'address' }],
    transfer_ownership: [{ index: 0, name: 'new_owner', kind: 'address' }],
    set_paused: [{ index: 0, name: 'is_paused' }],
    set_limits: [
      { index: 0, name: 'new_min', kind: 'amount', unit: OCT },
      { index: 1, name: 'new_max', kind: 'amount', unit: OCT },
    ],
    set_min_bond: [{ index: 0, name: 'new_min_bond', kind: 'amount', unit: OCT }],
    set_min_fee: [{ index: 0, name: 'new_min_fee', kind: 'amount', unit: OCT }],
    set_fee: [{ index: 0, name: 'new_fee_bps' }],
    set_challenge_window: [{ index: 0, name: 'epochs' }],
    set_fill_timeout: [{ index: 0, name: 'epochs' }],
    set_max_expiry: [{ index: 0, name: 'delta' }],
  },
  octBridge: {
    lock_to_eth: [{ index: 0, name: 'eth_recipient', label: 'recipient', kind: 'address' }],
    unlock_trusted: [
      { index: 0, name: 'to', label: 'recipient', kind: 'address' },
      { index: 1, name: 'amount', label: 'amount', kind: 'amount', unit: OCT },
      { index: 2, name: 'message_id' },
    ],
  },
};

export function knownCallArgs(
  calls: KnownCalls | null | undefined,
  method: string | null | undefined
): ArgSpec[] | null {
  if (!calls || !method) return null;
  return KNOWN_CALLS[calls][method.trim()] ?? null;
}

export function abiParamNames(raw: unknown): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const nameOf = (p: unknown): string =>
    typeof p === 'string' ? p : String((p as { name?: unknown })?.name ?? '');
  const read = (list: unknown) => {
    if (!Array.isArray(list)) return;
    for (const m of list) {
      if (!m || typeof m !== 'object') continue;
      const entry = m as Record<string, unknown>;
      const method = typeof entry.name === 'string' ? entry.name : '';
      const inputs = Array.isArray(entry.inputs) ? entry.inputs : null;
      const params =
        entry.input_names ??
        entry.params ??
        entry.args ??
        (inputs?.every((p) => p && typeof p === 'object') ? inputs : null);
      if (!method || !Array.isArray(params)) continue;
      const names = params.map(nameOf);
      if (names.some((n) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(n))) out[method] = names;
    }
  };
  let body: unknown = raw;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return out;
    }
  }
  if (Array.isArray(body)) read(body);
  else if (body && typeof body === 'object') {
    const r = body as Record<string, unknown>;
    read(r.methods);
    read(r.functions);
    if (r.abi) {
      for (const [method, names] of Object.entries(abiParamNames(r.abi))) out[method] ??= names;
    }
  }
  return out;
}
