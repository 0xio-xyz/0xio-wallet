import { fromUnits } from 'src/utils/amount';
import type { EvmNetwork } from './networks';
import { isHex, rpcBatch, rpcCall, type RpcRequest } from './rpc';
import { evmTokensFor, loadCustomEvmTokens, type EvmToken } from './tokens';

export interface EvmBalanceRow {
  chainId: number;
  chainName: string;
  testnet: boolean;
  token: EvmToken;
  raw: string;
  amount: string;
}

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const BALANCE_OF = '0x70a08231';

export function isEvmAddress(value: unknown): value is string {
  return typeof value === 'string' && ADDRESS.test(value);
}

export function balanceOfCalldata(owner: string): string {
  if (!isEvmAddress(owner)) throw new Error('Invalid EVM address');
  return BALANCE_OF + owner.slice(2).toLowerCase().padStart(64, '0');
}

function parseQuantity(value: unknown): bigint {
  if (!isHex(value) || value.length < 3 || value.length > 66) throw new Error('Bad hex result');
  return BigInt(value);
}

function requestFor(token: EvmToken, address: string): RpcRequest {
  return token.address === null
    ? { method: 'eth_getBalance', params: [address, 'latest'] }
    : {
        method: 'eth_call',
        params: [{ to: token.address, data: balanceOfCalldata(address) }, 'latest'],
      };
}

export const evmTokenKey = (chainId: number, token: Pick<EvmToken, 'address'>) =>
  `${chainId}:${token.address?.toLowerCase() ?? 'native'}`;

async function fetchChain(
  address: string,
  network: EvmNetwork,
  tokens: EvmToken[],
  signal?: AbortSignal
): Promise<{ rows: EvmBalanceRow[]; failedTokens: string[] }> {
  const results = await rpcBatch(
    network.rpcUrl,
    tokens.map((t) => requestFor(t, address)),
    { signal }
  );
  const rows: EvmBalanceRow[] = [];
  const failedTokens: string[] = [];
  tokens.forEach((token, i) => {
    let raw: bigint;
    try {
      const result = results[i];
      if (result instanceof Error) throw result;
      raw = parseQuantity(result);
    } catch (e) {
      if (token.custom) {
        failedTokens.push(evmTokenKey(network.chainId, token));
        return;
      }
      throw e;
    }
    rows.push({
      chainId: network.chainId,
      chainName: network.name,
      testnet: network.testnet,
      token,
      raw: raw.toString(),
      amount: fromUnits(raw, token.decimals),
    });
  });
  return { rows, failedTokens };
}

/**
 * One batch per network: the native coin, curated tokens and the imported and detected tokens
 * passed in, less the hidden ones. A chain with any failed read lands in failedChains with no
 * rows, so an unknown balance never shows as 0.
 */
export async function fetchEvmBalances(
  address: string,
  networks: EvmNetwork[],
  opts: {
    signal?: AbortSignal;
    custom?: readonly EvmToken[];
    exclude?: ReadonlySet<string>;
  } = {}
): Promise<{ rows: EvmBalanceRow[]; failedChains: number[]; failedTokens: string[] }> {
  if (!isEvmAddress(address)) throw new Error('Invalid EVM address');
  const custom = opts.custom ?? (await loadCustomEvmTokens());
  const exclude = opts.exclude;
  const settled = await Promise.allSettled(
    networks.map((n) =>
      fetchChain(
        address,
        n,
        evmTokensFor(n.chainId, { network: n, custom }).filter(
          (t) => !exclude?.has(evmTokenKey(n.chainId, t))
        ),
        opts.signal
      )
    )
  );
  const rows: EvmBalanceRow[] = [];
  const failedChains: number[] = [];
  const failedTokens: string[] = [];
  settled.forEach((s, i) => {
    if (s.status === 'fulfilled') {
      rows.push(...s.value.rows);
      failedTokens.push(...s.value.failedTokens);
    } else failedChains.push(networks[i].chainId);
  });
  return { rows, failedChains, failedTokens };
}

export async function fetchTokenBalance(
  address: string,
  network: EvmNetwork,
  token: Pick<EvmToken, 'address'>,
  opts: { signal?: AbortSignal } = {}
): Promise<bigint> {
  if (!isEvmAddress(address)) throw new Error('Invalid EVM address');
  const req = requestFor(token as EvmToken, address);
  return parseQuantity(await rpcCall<unknown>(network.rpcUrl, req.method, req.params, opts));
}
