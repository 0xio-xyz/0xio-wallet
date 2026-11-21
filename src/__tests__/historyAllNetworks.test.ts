import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig, syncCustomNetworks, type CustomNetwork } from 'src/utils/config';
import { NetworkService, pendingTxInScope } from 'src/services/network/NetworkService';
import {
  FAILED_ROW_TTL_MS,
  cancellableIds,
  dropExpiredFailed,
  historyReadNetworks,
  looseConfirmedMatch,
  mergeHistory,
  statusOutcome,
} from 'src/services/wallet/historyRows';
import { mempoolRows } from 'src/hooks/wallet/useTransactionHistory';
import {
  evmAmountSign,
  evmChainLabel,
  octraAmountSign,
  octraNetworkLabel,
} from 'src/shared/ui/txLabels';
import { txAsset } from 'src/utils/txDisplay';
import type { PendingTransaction, TransactionHistoryItem } from 'src/types/transaction';

const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const CUSTOM = 'custom_1700000000000';
const node: CustomNetwork = {
  id: CUSTOM,
  name: 'My Node',
  rpc_url: 'http://10.0.0.5:8080',
  explorer_url: '',
  explorer_address_url: '',
  indexer_url: '',
  supports_privacy: false,
  color: '#9b8cff',
};

const local = new Map<string, unknown>();
const t = (key: string, o?: Record<string, unknown>) =>
  String(o?.defaultValue ?? key).replace('{{name}}', String(o?.name ?? ''));

beforeEach(() => {
  local.clear();
  local.set(NET, 'mainnet');
  (chrome.storage as any).local = {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(local);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) local.delete(k);
    },
  };
});
afterEach(() => {
  syncCustomNetworks([]);
});

const row = (over: Partial<TransactionHistoryItem>): TransactionHistoryItem => ({
  hash: '',
  timestamp: 1_000_000,
  type: 'outgoing',
  amount: 1,
  from: A,
  to: B,
  address: B,
  nonce: 0,
  confirmed: false,
  status: 'processing',
  ...over,
});

const record = (over: Partial<PendingTransaction>): PendingTransaction => ({
  from: A,
  to: B,
  amount: 1,
  nonce: 3,
  message: '',
  timestamp: 1_000_000,
  type: 'outgoing',
  opType: 'transfer',
  confirmed: false,
  pending: true,
  txId: 'id-1',
  storageKey: 'pending_tx_id-1',
  network: 'mainnet',
  ...over,
});

describe('History reads every network of one address', () => {
  it('reads both built-ins, and a custom node only while it is active', () => {
    expect(historyReadNetworks('mainnet')).toEqual(['mainnet', 'devnet']);
    expect(historyReadNetworks('devnet')).toEqual(['mainnet', 'devnet']);
    expect(historyReadNetworks(CUSTOM)).toEqual(['mainnet', 'devnet', CUSTOM]);
  });

  it('keeps pending records sender-only: another wallet never sees them', () => {
    const tx = record({ network: 'devnet' });
    expect(pendingTxInScope(tx, A, historyReadNetworks('mainnet'))).toBe(true);
    expect(pendingTxInScope(tx, B, historyReadNetworks('mainnet'))).toBe(false);
    expect(pendingTxInScope({ ...tx, network: CUSTOM }, A, historyReadNetworks(CUSTOM))).toBe(true);
    expect(pendingTxInScope({ ...tx, network: CUSTOM }, B, historyReadNetworks(CUSTOM))).toBe(
      false
    );
  });

  it('merges mainnet, devnet and the active custom node into one list, each row tagged', async () => {
    syncCustomNetworks([node]);
    local.set(NET, CUSTOM);
    const listOf = (hash: string, ts: number) => ({
      result: { transactions: [{ hash, from: B, to: A, amount: '1000000', timestamp: ts }] },
    });
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        urls.push(url);
        const body = url.startsWith('https://octra.network')
          ? listOf('m1', 300)
          : url.startsWith('https://devnet.octrascan.io')
            ? listOf('d1', 200)
            : url.startsWith('http://10.0.0.5:8080')
              ? listOf('c1', 100)
              : { result: null };
        return new Response(JSON.stringify(body));
      })
    );
    const rows = await new NetworkService().getTransactionHistory(A);
    expect(rows.map((r) => [r.hash, r.network])).toEqual([
      ['m1', 'mainnet'],
      ['d1', 'devnet'],
      ['c1', CUSTOM],
    ]);
    expect(rows.map((r) => octraNetworkLabel(r.network!, t))).toEqual([
      'Octra Mainnet',
      'Octra Devnet',
      'My Node',
    ]);
  });

  it('caches each network apart, so a second read within the window fetches nothing', async () => {
    const empty: { result: { transactions: unknown[] } } = { result: { transactions: [] } };
    const fetchMock = vi.fn(async () => new Response(JSON.stringify(empty)));
    vi.stubGlobal('fetch', fetchMock);
    const svc = new NetworkService();
    await svc.getTransactionHistory(A);
    await svc.getTransactionHistory(A);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('labels EVM chains by their own name', () => {
    expect(evmChainLabel({ chainName: 'Sepolia' })).toBe('Sepolia');
    expect(evmChainLabel({ chainName: 'Ethereum' })).toBe('Ethereum');
  });
});

describe('status lookups', () => {
  const svc = () => new NetworkService();

  it('tells a node that does not know the hash from a lookup that failed', async () => {
    const s = svc();
    const call = vi.spyOn(s, 'jsonRpcCall');
    call.mockRejectedValueOnce(new Error('transaction not found'));
    expect((await s.getTransactionStatus('h')).status).toBe('unknown');
    call.mockRejectedValueOnce(new Error('HTTP 429 Too Many Requests'));
    const failed = await s.getTransactionStatus('h');
    expect(failed.status).toBe('error');
    expect(statusOutcome(failed)).toBe('error');
    expect(statusOutcome({ status: 'unknown', confirmed: false })).toBe('notFound');
  });

  it('reads dropped and expired as failed, like rejected', async () => {
    expect(statusOutcome({ status: 'dropped', confirmed: false })).toBe('rejected');
    expect(statusOutcome({ status: 'expired', confirmed: false })).toBe('rejected');
    expect(statusOutcome({ status: 'pending', confirmed: false })).toBe('pending');
    expect(statusOutcome({ status: 'confirmed', confirmed: true })).toBe('confirmed');

    const s = svc();
    vi.spyOn(s, 'jsonRpcCall').mockResolvedValue({ status: 'dropped' });
    expect(await s.verifyTxExecution('h', 50, 1)).toEqual({ status: 'rejected', error: 'dropped' });
  });

  it('keeps polling through failed lookups instead of reading them as an answer', async () => {
    const s = svc();
    vi.spyOn(s, 'jsonRpcCall')
      .mockRejectedValueOnce(new Error('timeout'))
      .mockResolvedValue({ status: 'confirmed', finality: 'confirmed' });
    expect(await s.verifyTxExecution('h', 1000, 1)).toEqual({ status: 'confirmed' });
  });
});

describe('merge keyed by txId', () => {
  it('replaces the hashless pending row when its hash lands', () => {
    const before = [row({ txId: 'T', pending: true })];
    const after = mergeHistory(before, [row({ txId: 'T', hash: 'X', pending: true })]);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ txId: 'T', hash: 'X' });
  });

  it('drops a cached row whose txId a fresh row carries, and keeps the txId on the chain row', () => {
    const cached = [row({ txId: 'T', pending: true, timestamp: 5 })];
    const fresh = [
      row({ txId: 'T', hash: 'X', pending: true }),
      row({ hash: 'X', confirmed: true, status: 'success', source: 'indexer' }),
    ];
    const out = mergeHistory(cached, fresh);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ hash: 'X', status: 'success', txId: 'T' });
  });

  it('never lets a later hashless copy wipe the hash', () => {
    const out = mergeHistory(
      [row({ txId: 'T', hash: 'X', pending: true })],
      [row({ txId: 'T', pending: true })]
    );
    expect(out).toHaveLength(1);
    expect(out[0].hash).toBe('X');
  });
});

describe('loose confirmed match', () => {
  const netOf = (tx: { network?: string }) => tx.network || 'mainnet';
  const chain = (over: Partial<TransactionHistoryItem>) =>
    row({
      hash: 'C',
      confirmed: true,
      status: 'success',
      source: 'indexer',
      network: 'mainnet',
      ...over,
    });

  it('matches only this wallet own send, by recipient, amount and time', () => {
    const tx = record({ hash: 'H' });
    expect(looseConfirmedMatch(tx, [chain({})], A, new Set(), netOf)).toBe('C');
    expect(looseConfirmedMatch(tx, [chain({ from: B })], A, new Set(), netOf)).toBeNull();
    expect(looseConfirmedMatch(tx, [chain({ amount: 2 })], A, new Set(), netOf)).toBeNull();
    expect(
      looseConfirmedMatch(tx, [chain({ timestamp: 1_000_000 + 600_000 })], A, new Set(), netOf)
    ).toBeNull();
    expect(looseConfirmedMatch(tx, [chain({ network: 'devnet' })], A, new Set(), netOf)).toBeNull();
  });

  it('skips hashless records, contract calls and hashes already claimed', () => {
    expect(looseConfirmedMatch(record({}), [chain({})], A, new Set(), netOf)).toBeNull();
    expect(
      looseConfirmedMatch(record({ hash: 'H', opType: 'call' }), [chain({})], A, new Set(), netOf)
    ).toBeNull();
    expect(
      looseConfirmedMatch(record({ hash: 'H' }), [chain({ opType: 'call' })], A, new Set(), netOf)
    ).toBeNull();
    const claimed = new Set<string>();
    expect(looseConfirmedMatch(record({ hash: 'H1' }), [chain({})], A, claimed, netOf)).toBe('C');
    expect(looseConfirmedMatch(record({ hash: 'H2' }), [chain({})], A, claimed, netOf)).toBeNull();
  });
});

describe('failed local rows', () => {
  it('age out a week after they failed, whatever the last save', () => {
    const now = Date.now();
    const rows = [
      row({ hash: 'old', status: 'failed', failedAt: now - FAILED_ROW_TTL_MS - 1 }),
      row({ hash: 'new', status: 'failed', failedAt: now - 1000 }),
      row({ hash: 'chain', status: 'failed', source: 'indexer', failedAt: 1 }),
    ];
    expect(dropExpiredFailed(rows, now).map((r) => r.hash)).toEqual(['new', 'chain']);
  });
});

describe('cancel', () => {
  it('lists only queue items that never reached a node', () => {
    expect(
      cancellableIds({
        queue: [
          { id: 'a', status: 'pending' },
          { id: 'b', status: 'retrying', sent: true },
          { id: 'c', status: 'processing' },
          { id: 'd', status: 'retrying' },
        ],
      })
    ).toEqual(['a', 'd']);
    expect(cancellableIds(undefined)).toEqual([]);
  });
});

describe('sign helper', () => {
  it('gives the row and the sheet one sign', () => {
    const tx = (over: Partial<TransactionHistoryItem>) => row({ amount: 2, ...over });
    const sign = (over: Partial<TransactionHistoryItem>) =>
      octraAmountSign(tx(over), txAsset(tx(over)));
    expect(sign({ type: 'incoming' })).toBe('+');
    expect(sign({ opType: 'decrypt' })).toBe('+');
    expect(sign({ opType: 'claim' })).toBe('+');
    expect(sign({})).toBe('-');
    expect(sign({ opType: 'key_switch' })).toBe('');
    expect(sign({ status: 'failed' })).toBe('');
    expect(evmAmountSign({ direction: 'incoming', failed: false })).toBe('+');
    expect(evmAmountSign({ direction: 'outgoing', failed: false })).toBe('-');
    expect(evmAmountSign({ direction: 'outgoing', failed: true })).toBe('');
    expect(evmAmountSign({ direction: 'self', failed: false })).toBe('');
  });
});

describe('mempool rows', () => {
  it('keeps this address only, in OCT, on the network it was read from', () => {
    const rows = mempoolRows(
      [
        { hash: 'm', from: A, to: B, amount: '1.5', amount_raw: '1500000', nonce: 4 },
        { hash: 'o', from: B, to: A, amount_raw: '1' },
      ],
      A,
      'devnet'
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ hash: 'm', amount: 1.5, nonce: 4, network: 'devnet' });
  });
});

describe('EVM native row', () => {
  it('keeps the ETH a tx spent in the same row as its token transfer', async () => {
    const { fetchEvmHistory } = await import('src/services/evm/history');
    const { evmNetworksFor } = await import('src/services/evm/networks');
    const ME = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
    const PEER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
    const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
    const h = (n: number) => `0x${String(n).padStart(64, '0')}`;
    const at = '2026-10-10T00:00:00.000000Z';
    const transfer = (n: number) => ({
      transaction_hash: h(n),
      timestamp: at,
      log_index: 1,
      from: { hash: ME },
      to: { hash: PEER },
      total: { value: '2500000', decimals: '6' },
      token: { address_hash: USDC },
    });
    const tx = (n: number, value: string) => ({
      hash: h(n),
      timestamp: at,
      from: { hash: ME },
      to: { hash: USDC },
      value,
      status: 'ok',
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        const items = url.includes('token-transfers')
          ? [transfer(1), transfer(2)]
          : [tx(1, '1000000000000000000'), tx(2, '0')];
        const body = url.includes('oracle.0xio.xyz')
          ? {
              transactions: [tx(1, '1000000000000000000'), tx(2, '0')],
              token_transfers: [transfer(1), transfer(2)],
            }
          : { items };
        return new Response(JSON.stringify(body), { status: 200 });
      })
    );
    const eth = evmNetworksFor('mainnet').filter((n) => n.chainId === 1);
    const { items } = await fetchEvmHistory(ME, eth);
    const keys = items.map((i) => i.key).sort();
    expect(keys).toEqual([`1:${h(1)}`, `1:${h(2)}`]);
    const both = items.find((i) => i.key === `1:${h(1)}`);
    expect(both).toMatchObject({ amount: '1' });
    expect(both?.moved?.map((m) => `${m.amount} ${m.token.symbol}`)).toEqual(['1 ETH', '2.5 USDC']);
    expect(items.find((i) => i.key === `1:${h(2)}`)).toMatchObject({ amount: '2.5', to: PEER });
  });
});
