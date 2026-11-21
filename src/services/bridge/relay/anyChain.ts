import { chainLogoUrl } from '../../evm/chains';
import type { EvmNetwork } from '../../evm/networks';
import { rpcCall } from '../../evm/rpc';
import { curatedEvmTokens } from '../../evm/tokens';
import { addressCall, readUint } from '../abi';

const API = 'https://rpc-proxy.0xio.xyz/bridge/any';
/** Feed logos come through the proxy: their hosts send no CORP header, and they never see the user. */
const LOGO_API = `${API}/logo`;
const TIMEOUT_MS = 45_000;

export const NATIVE_TOKEN = '0x0000000000000000000000000000000000000000';
export const MIN_OUT_RAW = 1_000_000n;

export interface AnyToken {
  address: string;
  symbol: string;
  name: string;
  decimals: number;
  logo: string | null;
  verified?: boolean;
}

export interface AnyChain {
  id: number;
  name: string;
  icon: string | null;
  explorer: string | null;
  rpc: string | null;
  tokens: AnyToken[];
}

export interface RelayTxData {
  to: string;
  data: string;
  value?: string;
  chainId: number;
  gas?: string;
}

interface RelayItem {
  status?: string;
  data?: RelayTxData;
}

interface RelayStep {
  id: string;
  kind: string;
  requestId?: string;
  items?: RelayItem[];
}

interface RelayAmount {
  amount?: string;
  amountUsd?: string;
}

export interface AnyRelayQuote {
  steps?: RelayStep[];
  details?: { currencyIn?: RelayAmount; currencyOut?: RelayAmount; timeEstimate?: number };
  fees?: Record<string, RelayAmount | undefined>;
}

export interface AnyQuote {
  outRaw: string;
  quote: AnyRelayQuote;
}

export interface RelayStatus {
  status: string;
  txHashes?: string[];
  inTxHashes?: string[];
  failReason?: string | null;
}

export interface QuoteTx {
  kind: 'approve' | 'deposit';
  data: RelayTxData;
}

async function call<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      method,
      headers: body === undefined ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      credentials: 'omit',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw new Error('Could not reach the swap service');
  }
  const data = (await res.json().catch((): null => null)) as (T & { error?: string }) | null;
  if (res.ok && data) return data;
  throw new Error(data?.error || `The swap service answered HTTP ${res.status}`);
}

export const fetchChains = (): Promise<AnyChain[]> =>
  call<{ chains: AnyChain[] }>('GET', '/chains').then((d) =>
    Array.isArray(d.chains) ? d.chains : []
  );

export type QuoteMode = 'spend' | 'receive';

export const fetchQuote = (req: {
  user: string;
  originChainId: number;
  originCurrency: string;
  octraRecipient: string;
  amountRaw: string;
  mode?: QuoteMode;
}): Promise<AnyQuote> => call<AnyQuote>('POST', '/quote', { ...req, mode: req.mode ?? 'spend' });

export function payRawOf(quote: AnyRelayQuote): string | null {
  const amount = quote.details?.currencyIn?.amount;
  return typeof amount === 'string' && /^\d+$/.test(amount) ? amount : null;
}

export const fetchStatus = (requestId: string): Promise<RelayStatus> =>
  call<RelayStatus>('GET', `/status?requestId=${encodeURIComponent(requestId)}`);

export function requestIdOf(quote: AnyRelayQuote): string | null {
  for (const step of quote.steps ?? []) if (step.requestId) return step.requestId;
  return null;
}

export function feesUsd(quote: AnyRelayQuote): number | null {
  let total = 0;
  let found = false;
  for (const key of ['gas', 'relayer', 'app']) {
    const usd = Number(quote.fees?.[key]?.amountUsd);
    if (Number.isFinite(usd)) {
      total += usd;
      found = true;
    }
  }
  return found ? total : null;
}

/**
 * The transactions a quote needs, an approval first when Relay asks for one. A signature step is
 * refused: this wallet only sends the transactions it reviews.
 */
export function quoteTxs(quote: AnyRelayQuote): QuoteTx[] {
  const out: QuoteTx[] = [];
  for (const step of quote.steps ?? []) {
    if (step.kind !== 'transaction') {
      throw new Error('This route needs a signature step. Try another token or chain.');
    }
    for (const item of step.items ?? []) {
      if (item.status === 'complete' || !item.data) continue;
      out.push({ kind: step.id === 'approve' ? 'approve' : 'deposit', data: item.data });
    }
  }
  if (!out.some((t) => t.kind === 'deposit')) throw new Error('The quote has no deposit');
  return out;
}

export function chainNetwork(chain: AnyChain): EvmNetwork {
  if (!chain.rpc || !/^https:\/\//.test(chain.rpc)) throw new Error(`No RPC for ${chain.name}`);
  const native = chain.tokens.find((t) => t.address === NATIVE_TOKEN);
  return {
    chainId: chain.id,
    name: chain.name,
    rpcUrl: chain.rpc,
    testnet: false,
    nativeSymbol: native?.symbol ?? 'ETH',
    nativeName: native?.name ?? 'Ether',
    logoChainId: chain.id,
  };
}

export async function tokenBalance(
  chain: AnyChain,
  token: AnyToken,
  owner: string
): Promise<bigint> {
  const url = chainNetwork(chain).rpcUrl;
  if (token.address === NATIVE_TOKEN) {
    return BigInt(await rpcCall<string>(url, 'eth_getBalance', [owner, 'latest']));
  }
  const res = await rpcCall<string>(url, 'eth_call', [
    { to: token.address, data: addressCall('0x70a08231', owner) },
    'latest',
  ]);
  return readUint(res);
}

const proxiedLogo = (url: string | null): string | null =>
  url && /^https:\/\//.test(url) ? `${LOGO_API}?u=${encodeURIComponent(url)}` : null;

const present = (list: (string | null | undefined)[]): string[] =>
  list.filter((x): x is string => !!x);

export function chainLogos(chain: AnyChain): string[] {
  return present([chainLogoUrl(chain.id), proxiedLogo(chain.icon)]);
}

export function tokenLogos(chain: AnyChain, token: AnyToken): string[] {
  const address = token.address.toLowerCase();
  const bundled = curatedEvmTokens(chain.id).find((t) => t.address?.toLowerCase() === address);
  if (bundled?.logo) return [bundled.logo];
  if (address === NATIVE_TOKEN && !token.logo) return chainLogos(chain);
  return present([proxiedLogo(token.logo)]);
}
