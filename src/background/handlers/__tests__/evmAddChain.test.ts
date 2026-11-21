import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sites = vi.hoisted(() => ({
  siteChainId: vi.fn(async () => 1),
  setSiteChain: vi.fn(async () => {}),
}));
const approvals = vi.hoisted(() => ({
  requestEvmApproval: vi.fn(async () => ({ approved: true, edit: null as unknown })),
}));

vi.mock('../../services/evmSites', () => ({
  accountsFor: vi.fn(() => []),
  evmVault: vi.fn(async () => ({
    status: 'ok',
    open: { walletId: 'w1', walletName: 'Main', octraAddress: 'oct1', evm: null },
    evm: new Map(),
    ids: new Set(['w1']),
  })),
  recentEvmWallet: vi.fn(() => null),
  siteAccounts: vi.fn(() => []),
  connectEvmSite: vi.fn(),
  currentSide: vi.fn(async () => 'mainnet'),
  disconnectEvmSite: vi.fn(),
  loadEvmSites: vi.fn(async () => ({})),
  markEvmOrigin: vi.fn(async () => {}),
  pushEvmState: vi.fn(async () => {}),
  setSiteChain: sites.setSiteChain,
  siteChainId: sites.siteChainId,
  siteNetwork: vi.fn(async () => ({
    chainId: 1,
    name: 'Ethereum',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    testnet: false,
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    logoChainId: 1,
  })),
  toHexChain: (n: number) => `0x${n.toString(16)}`,
}));
vi.mock('../../services/evmApprovals', () => ({
  hasPendingEvmApproval: () => false,
  requestEvmApproval: approvals.requestEvmApproval,
}));
vi.mock('../../services/wallet', () => ({ waitForWalletUnlock: vi.fn(async () => true) }));

import {
  CUSTOM_NETWORKS_KEY,
  findNetwork,
  setNetworkEnabled,
} from '../../../services/evm/registry';
import { NETWORK_PREFS_KEY } from '../../../services/evm/networkPrefs';
import { handleEvmRequest } from '../evmRequest';

let store: Record<string, unknown> = {};
const ORIGIN = 'https://app.example.com';
const sender = {
  id: 'ext',
  origin: ORIGIN,
  tab: { id: 7 },
} as unknown as chrome.runtime.MessageSender;

const BASE = {
  custom: true,
  chainId: 8453,
  name: 'Base',
  rpcUrl: 'https://base-rpc.publicnode.com',
  testnet: false,
  nativeSymbol: 'ETH',
  nativeName: 'Ether',
  logoChainId: 8453,
};

function request(method: string, params: unknown) {
  return new Promise<{ success: boolean; data?: unknown; error?: { code: number } }>((resolve) => {
    void handleEvmRequest({ method, params }, sender, (r) => resolve(r as never));
  });
}

const addBase = (overrides: Record<string, unknown> = {}) =>
  request('wallet_addEthereumChain', [
    {
      chainId: '0x2105',
      chainName: 'Base',
      rpcUrls: ['https://base.example'],
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      ...overrides,
    },
  ]);

beforeEach(() => {
  store = {};
  sites.siteChainId.mockResolvedValue(1);
  approvals.requestEvmApproval.mockClear();
  vi.stubGlobal('chrome', {
    runtime: { id: 'ext', getManifest: () => ({ version: '0' }) },
    tabs: { get: vi.fn(async () => ({ title: 'App' })) },
    storage: {
      local: {
        get: vi.fn(async (keys: string[]) =>
          Object.fromEntries(keys.filter((k) => k in store).map((k) => [k, store[k]]))
        ),
        set: vi.fn(async (items: Record<string, unknown>) => {
          Object.assign(store, items);
        }),
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x2105' })))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('wallet_addEthereumChain', () => {
  it('adds a new chain after review, on, with the site recorded', async () => {
    const res = await addBase();
    expect(res.success).toBe(true);
    expect(approvals.requestEvmApproval).toHaveBeenCalledTimes(1);
    expect(await findNetwork(8453)).toMatchObject({
      enabled: true,
      addedBy: ORIGIN,
      rpcUrl: 'https://base.example',
    });
  });

  it('never overwrites a chain the wallet has, and an approved switch turns it on', async () => {
    store[CUSTOM_NETWORKS_KEY] = [BASE];
    await setNetworkEnabled(8453, false);
    const res = await addBase({
      chainName: 'Evil Base',
      rpcUrls: ['https://evil.example'],
      nativeCurrency: { name: 'Evil', symbol: 'EVL', decimals: 18 },
    });
    expect(res.success).toBe(true);
    expect(approvals.requestEvmApproval).toHaveBeenCalledWith(
      expect.objectContaining({ kind: 'switchChain' })
    );
    expect(store[CUSTOM_NETWORKS_KEY]).toEqual([BASE]);
    expect(await findNetwork(8453)).toMatchObject({
      name: 'Base',
      nativeSymbol: 'ETH',
      rpcUrl: 'https://base-rpc.publicnode.com',
      enabled: true,
    });
    expect((store[NETWORK_PREFS_KEY] as Record<string, unknown>)['8453']).toEqual({
      enabled: true,
    });
    expect(sites.setSiteChain).toHaveBeenCalledWith(ORIGIN, 8453);
  });

  it('leaves an off chain off when the review is declined', async () => {
    store[CUSTOM_NETWORKS_KEY] = [BASE];
    await setNetworkEnabled(8453, false);
    approvals.requestEvmApproval.mockResolvedValueOnce({ approved: false, edit: null });
    const res = await addBase();
    expect(res.success).toBe(false);
    expect(res.error?.code).toBe(4001);
    expect((await findNetwork(8453))?.enabled).toBe(false);
  });
});
