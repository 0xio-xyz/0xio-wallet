import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from 'src/types/wallet';
import { keysForRemovedAddresses, sweepWalletData } from 'src/services/wallet/WalletStorage';
import { registerSessionCache, clearSessionCaches } from 'src/utils/sessionCaches';

const GONE = 'octGoneGoneGoneGoneGoneGoneGoneGoneGoneGoneGone1';
const KEPT = 'octKeptKeptKeptKeptKeptKeptKeptKeptKeptKeptKept1';
const GONE_LONGER = `${GONE}x`;
const GONE_EVM = '0xAbCdEf0000000000000000000000000000000001';
const KEPT_EVM = '0xabcdef0000000000000000000000000000000002';

const wallet = (id: string, address: string, evm?: string): Wallet =>
  ({
    id,
    name: id,
    address,
    type: 'standard',
    privateKey: `sk-${id}`,
    mnemonic: null,
    publicKey: null,
    isActive: false,
    metadata: {
      source: 'imported',
      createdAt: 0,
      isPadded: false,
      ...(evm ? { evm: { enabled: true, address: evm, index: 0 } } : {}),
    },
  }) as Wallet;

const local = new Map<string, unknown>();
const session = new Map<string, unknown>();
const area = (store: Map<string, unknown>) => ({
  get: async (keys?: string | string[] | null) => {
    if (keys == null) return Object.fromEntries(store);
    const list = Array.isArray(keys) ? keys : [keys];
    return Object.fromEntries(list.filter((k) => store.has(k)).map((k) => [k, store.get(k)]));
  },
  set: async (items: Record<string, unknown>) => {
    for (const [k, v] of Object.entries(items)) store.set(k, structuredClone(v));
  },
  remove: async (keys: string | string[]) => {
    for (const k of Array.isArray(keys) ? keys : [keys]) store.delete(k);
  },
});

beforeEach(() => {
  local.clear();
  session.clear();
  (chrome.storage as any).local = area(local);
  (chrome.storage as any).session = area(session);
});

describe('keysForRemovedAddresses', () => {
  it('matches whole address tokens only, 0x in any case', () => {
    const keys = [
      `balance_cache_mainnet_${GONE}`,
      `balance_cache_mainnet_${GONE_LONGER}`,
      `evm_bal:mainnet:${GONE_EVM.toLowerCase()}`,
      `evm_hist:${GONE_EVM.toLowerCase()}`,
      `evm_hist:${KEPT_EVM}`,
      'settings',
    ];
    expect(keysForRemovedAddresses(keys, [GONE, GONE_EVM], [KEPT, KEPT_EVM])).toEqual([
      `balance_cache_mainnet_${GONE}`,
      `evm_bal:mainnet:${GONE_EVM.toLowerCase()}`,
      `evm_hist:${GONE_EVM.toLowerCase()}`,
    ]);
  });

  it('keeps everything for an address another wallet still uses', () => {
    expect(keysForRemovedAddresses([`balance_cache_mainnet_${GONE}`], [GONE], [GONE])).toEqual([]);
  });
});

describe('sweepWalletData', () => {
  it('removes the wallet data in local and session storage and nothing else', async () => {
    const goneKeys = [
      `balance_cache_mainnet_${GONE}`,
      `0xio_bal_hist_mainnet_${GONE}`,
      `evm_bal:mainnet:${GONE_EVM.toLowerCase()}`,
      `evm_hist:${GONE_EVM.toLowerCase()}`,
      `bridge_transfers:mainnet:${GONE}`,
      `bridge_recovered:mainnet:${GONE}`,
      `pvac_corrupted_devnet_${GONE}`,
      `tx_history_mainnet_${GONE}_v3`,
      `0xio_bal_hist_custom_1700000000_${GONE}`,
      `evm_bal:custom_1700000000:${GONE_EVM.toLowerCase()}`,
      'pending_tx_1',
    ];
    const keptKeys = [
      `balance_cache_mainnet_${KEPT}`,
      `balance_cache_mainnet_${GONE_LONGER}`,
      `0xio_bal_hist_devnet_${GONE.slice(0, 12)}`,
      `evm_hist:${KEPT_EVM}`,
      `bridge_transfers:mainnet:${KEPT}`,
      'pending_tx_2',
      'settings',
    ];
    for (const k of [...goneKeys, ...keptKeys]) local.set(k, {});
    local.set('pending_tx_1', { from: GONE });
    local.set('pending_tx_2', { from: KEPT });
    local.set('tx_queue_state', { queue: [{ from: GONE }, { from: KEPT }] });
    session.set(`balance_cache_mainnet_${GONE}`, { privateBalance: '5' });
    session.set(`balance_cache_mainnet_${KEPT}`, { privateBalance: '7' });
    session.set(`balance_cache_hist_custom_1700000000_${GONE}`, [{ time: 1, priv: 5 }]);

    await sweepWalletData(wallet('g', GONE, GONE_EVM), [
      wallet('k', KEPT, KEPT_EVM),
      wallet('l', GONE_LONGER),
    ]);

    for (const k of goneKeys) expect(local.has(k), k).toBe(false);
    for (const k of keptKeys) expect(local.has(k), k).toBe(true);
    expect(local.get('tx_queue_state')).toEqual({ queue: [{ from: KEPT }] });
    expect(session.has(`balance_cache_mainnet_${GONE}`)).toBe(false);
    expect(session.has(`balance_cache_hist_custom_1700000000_${GONE}`)).toBe(false);
    expect(session.has(`balance_cache_mainnet_${KEPT}`)).toBe(true);
  });

  it('clears legacy chart points unless another wallet shares their short key', async () => {
    local.set(`0xio_bal_hist_devnet_${GONE.slice(0, 12)}`, []);
    await sweepWalletData(wallet('g', GONE), [wallet('k', KEPT)]);
    expect(local.size).toBe(0);
  });

  it('keeps the data of an address imported twice', async () => {
    local.set(`balance_cache_mainnet_${GONE}`, {});
    local.set(`evm_hist:${GONE_EVM.toLowerCase()}`, {});
    local.set('pending_tx_1', { from: GONE });
    await sweepWalletData(wallet('g', GONE, GONE_EVM), [wallet('g2', GONE, GONE_EVM)]);
    expect([...local.keys()]).toEqual([
      `balance_cache_mainnet_${GONE}`,
      `evm_hist:${GONE_EVM.toLowerCase()}`,
      'pending_tx_1',
    ]);
  });

  it('keeps a shared 0x address while the Octra address goes', async () => {
    local.set(`balance_cache_mainnet_${GONE}`, {});
    local.set(`evm_hist:${GONE_EVM.toLowerCase()}`, {});
    await sweepWalletData(wallet('g', GONE, GONE_EVM), [wallet('k', KEPT, GONE_EVM)]);
    expect([...local.keys()]).toEqual([`evm_hist:${GONE_EVM.toLowerCase()}`]);
  });
});

describe('session caches', () => {
  it('clears every registered cache, even when one throws', () => {
    const a = new Map([['k', 1]]);
    const b = new Map([['k', 2]]);
    const offA = registerSessionCache(() => a.clear());
    const offBad = registerSessionCache(() => {
      throw new Error('boom');
    });
    const offB = registerSessionCache(() => b.clear());
    clearSessionCaches();
    expect(a.size).toBe(0);
    expect(b.size).toBe(0);
    offA();
    offBad();
    offB();
  });
});

describe('PvacManager.destroy', () => {
  it('drops the key and seed and closes the offscreen document', async () => {
    const { PvacManager } = await import('src/services/pvac/PvacManager');
    const send = vi.fn(() => Promise.resolve());
    (chrome.runtime as any).sendMessage = send;
    const m = new PvacManager() as any;
    m.currentKeyB64 = 'key';
    m.walletSeed = new Uint8Array(32).fill(7);
    m._seedFpFor = m.walletSeed;
    m._seedFp = Promise.resolve('fp');
    m.initialized = true;
    m.destroy();
    expect(m.currentKey).toBeNull();
    expect(m.walletSeed).toBeNull();
    expect(m._seedFpFor).toBeNull();
    expect(m._seedFp).toBeNull();
    expect(m.isReady).toBe(false);
    expect(send).toHaveBeenCalledWith({ type: 'CLOSE_PVAC_OFFSCREEN' });
  });
});
