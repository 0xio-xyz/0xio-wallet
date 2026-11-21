import { BRIDGE } from '../constants';
import type { AnyRelayQuote, AnyToken } from './anyChain';
import {
  parseRelayChains,
  QuoteCheckError,
  verifyQuote,
  type RelayChainInfo,
  type RelayQuote,
} from './quoteCheck';

/** Relay's own chain list is the reference for its contracts; nothing in a quote vouches for itself. */
const RELAY_CHAINS_URL = 'https://api.relay.link/chains';
const TTL_MS = 10 * 60_000;
let cache: { at: number; chains: Map<number, RelayChainInfo> } | null = null;

async function relayChains(): Promise<Map<number, RelayChainInfo>> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.chains;
  let chains = new Map<number, RelayChainInfo>();
  try {
    const res = await fetch(RELAY_CHAINS_URL, {
      credentials: 'omit',
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) chains = parseRelayChains(((await res.json()) as { chains?: unknown })?.chains);
  } catch {}
  if (chains.size === 0) {
    throw new Error("Could not read Relay's chain list to check the order. Nothing was sent.");
  }
  cache = { at: Date.now(), chains };
  return chains;
}

/**
 * Refuses a quote that would move funds anywhere but where the user confirmed: the burn goes to
 * their Octra address for the shown amount, the payment stays within what they entered, refunds
 * come back to them.
 */
export async function checkQuote(params: {
  quote: AnyRelayQuote;
  outRaw: string;
  user: string;
  octraRecipient: string;
  chainId: number;
  token: AnyToken;
  maxPayRaw: string;
}): Promise<void> {
  const chains = await relayChains();
  try {
    verifyQuote(
      {
        ...params,
        quote: params.quote as unknown as RelayQuote,
        woct: BRIDGE.wOCT,
        octraBridge: BRIDGE.ethBridge,
      },
      chains
    );
  } catch (e) {
    if (e instanceof QuoteCheckError) {
      throw new Error(
        `The order does not match what you confirmed (${e.message}). Nothing was sent.`
      );
    }
    throw e;
  }
}
