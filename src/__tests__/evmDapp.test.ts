import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';
import { contractAddressFor, deriveEvmPrivateKey, erc20ApproveData } from 'src/services/evm/tx';

const ABANDON = [...Array(11).fill('abandon'), 'about'];
const EVM_A = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const EVM_B = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const SITE = 'https://app.example';
const OTHER = 'https://other.example';

const state = vi.hoisted(() => ({
  locked: false,
  approve: true as boolean,
  edit: null as unknown,
  pick: null as string | null,
  during: null as null | (() => void),
  approvals: [] as any[],
  local: new Map<string, unknown>(),
}));

const vault = [
  {
    id: 'wallet-a',
    name: 'Main',
    address: 'octA',
    type: 'standard',
    mnemonic: ABANDON,
    metadata: { evm: { enabled: true, address: EVM_A, index: 0 } },
  },
  {
    id: 'wallet-b',
    name: 'Second',
    address: 'octB',
    type: 'standard',
    mnemonic: ABANDON,
    metadata: { evm: { enabled: true, address: EVM_B, index: 1 } },
  },
  {
    id: 'wallet-off',
    name: 'Off',
    address: 'octC',
    type: 'standard',
    mnemonic: ABANDON,
    metadata: { evm: { enabled: false, address: EVM_A, index: 0 } },
  },
  {
    id: 'wallet-key',
    name: 'Trading',
    address: 'octK',
    type: 'standard',
    privateKey: 'key',
    metadata: {},
  },
  {
    id: 'wallet-watch',
    name: 'Watched',
    address: 'octW',
    type: 'watch',
    metadata: {},
  },
] as any[];
const fullVault = [...vault];

vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => (state.locked ? null : 'session')) },
}));
vi.mock('../services/wallet/WalletStorage', () => ({
  walletStorage: { loadVault: vi.fn(async () => structuredClone(vault)) },
}));
vi.mock('../background/services/wallet', () => ({
  waitForWalletUnlock: vi.fn(async () => null),
  getActiveWallet: vi.fn(async () => null),
}));
vi.mock('../background/services/evmApprovals', () => ({
  hasPendingEvmApproval: vi.fn(() => false),
  requestEvmApproval: vi.fn(async (data: unknown) => {
    state.approvals.push(data);
    state.during?.();
    return {
      approved: state.approve,
      edit: state.approve ? state.edit : null,
      walletId: state.approve ? state.pick : null,
    };
  }),
}));
vi.mock('../services/evm/signer', () => ({
  withEvmKey: vi.fn(async (_id: string, index: number, _addr: string, fn: any) =>
    fn(await deriveEvmPrivateKey(ABANDON, index))
  ),
  prepareCall: vi.fn(async (network: any, call: any) => ({
    tx: {
      chainId: network.chainId,
      nonce: 0,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 10n,
      gasLimit: call.gasLimit ?? 50_000n,
      to: call.to,
      value: call.value ?? 0n,
      data: call.data,
    },
    feeWei: 500_000n,
    totalNative: (call.value ?? 0n) + 500_000n,
  })),
  signAndBroadcast: vi.fn(async () => '0x' + 'ab'.repeat(32)),
}));
const fees = vi.hoisted(() => ({ fail: false }));
vi.mock('../services/evm/send', () => ({
  getNonce: vi.fn(async () => 7),
  estimateGas: vi.fn(async () => 50_000n),
  estimateFees: vi.fn(async () => {
    if (fees.fail) throw new Error('RPC eth_feeHistory: down');
    return { baseFeePerGas: 4n, maxPriorityFeePerGas: 1n, maxFeePerGas: 10n };
  }),
}));
vi.mock('../services/evm/customTokens', () => ({
  EvmTokenError: class extends Error {},
  addCustomEvmToken: vi.fn(),
  readErc20Metadata: vi.fn(async () => ({ symbol: 'USDC', name: 'USD Coin', decimals: 6 })),
  resolveCustomEvmToken: vi.fn(),
}));

import {
  connectSiteWallet,
  handleEvmRequest,
  isEvmMethod,
  pickSiteChain,
  setSiteWallet,
} from '../background/handlers/evmRequest';
import {
  EVM_SITES_KEY,
  connectEvmSite,
  disconnectEvmSite,
  loadEvmSites,
  pushEvmState,
  setSiteChain,
  siteChainId,
  syncEvmSites,
} from '../background/services/evmSites';
import { signAndBroadcast } from '../services/evm/signer';
import { getNonce } from '../services/evm/send';

const tabSender = (origin = SITE) =>
  ({ id: 'mock-extension-id', origin, url: `${origin}/page`, tab: { id: 1 }, frameId: 0 }) as any;

async function call(method: string, params?: unknown, sender = tabSender()) {
  let out: any;
  await handleEvmRequest({ method, params }, sender, (r) => (out = r));
  return out as {
    success: boolean;
    data?: any;
    error?: { code: number; message: string; data?: unknown };
  };
}

const ok = async (method: string, params?: unknown, sender?: any) => {
  const r = await call(method, params, sender);
  if (!r.success) throw new Error(`${method}: ${r.error?.code} ${r.error?.message}`);
  return r.data;
};

const code = async (method: string, params?: unknown, sender?: any) =>
  (await call(method, params, sender)).error?.code;

const setActive = (id: string) => {
  const w = vault.find((v) => v.id === id)!;
  state.local.set('activeWalletId', w.id);
  state.local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, w.address);
};

beforeEach(() => {
  vault.splice(0, vault.length, ...fullVault);
  state.locked = false;
  state.approve = true;
  state.edit = null;
  state.pick = null;
  state.during = null;
  state.approvals = [];
  state.local = new Map();
  setActive('wallet-a');
  const get = vi.fn(async (keys: unknown) => {
    const list = keys === null ? [...state.local.keys()] : Array.isArray(keys) ? keys : [keys];
    const out: Record<string, unknown> = {};
    for (const k of list as string[]) {
      if (state.local.has(k)) out[k] = structuredClone(state.local.get(k));
    }
    return out;
  });
  vi.stubGlobal('chrome', {
    runtime: { id: 'mock-extension-id', getManifest: () => ({ version: '3.0.0' }) },
    storage: {
      local: {
        get,
        set: vi.fn(async (items: Record<string, unknown>) => {
          for (const [k, v] of Object.entries(items)) state.local.set(k, structuredClone(v));
        }),
        remove: vi.fn(),
      },
      session: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) },
      onChanged: { addListener: vi.fn() },
    },
    tabs: {
      get: vi.fn(async () => ({ title: 'Example', favIconUrl: `${SITE}/favicon.ico` })),
      query: vi.fn((_q: unknown, cb: (tabs: unknown[]) => void) => cb([])),
      sendMessage: vi.fn(async () => {}),
    },
    action: { openPopup: vi.fn(async () => {}) },
    windows: { create: vi.fn(async () => ({})) },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 1, result: '0x10' })))
  );
});

describe('EVM method routing', () => {
  it('routes only EIP-1193 names', () => {
    for (const m of ['eth_chainId', 'personal_sign', 'wallet_switchEthereumChain', 'net_version'])
      expect(isEvmMethod(m)).toBe(true);
    for (const m of ['connect', 'octra_sendTransaction', 'signMessage', 'rpc_call', 7])
      expect(isEvmMethod(m)).toBe(false);
  });

  it('answers the default chain for each side', async () => {
    expect(await ok('eth_chainId')).toBe('0x1');
    expect(await ok('net_version')).toBe('1');
    state.local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
    expect(await ok('eth_chainId')).toBe('0xaa36a7');
  });

  it('refuses requests that do not come from a page', async () => {
    expect(
      await code('eth_chainId', [], { id: 'mock-extension-id', url: 'chrome-extension://x/' })
    ).toBe(4100);
    expect(
      await code('eth_chainId', [], { id: 'someone-else', origin: SITE, tab: { id: 1 } })
    ).toBe(4100);
  });

  it('refuses eth_sign and unknown methods with 4200', async () => {
    expect(await code('eth_sign', [EVM_A, '0x' + '00'.repeat(32)])).toBe(4200);
    expect(await code('eth_signTransaction', [{}])).toBe(4200);
    expect(await code('eth_mine')).toBe(4200);
  });
});

describe('connecting a site', () => {
  it('returns no accounts until the user approves', async () => {
    expect(await ok('eth_accounts')).toEqual([]);
    expect(await ok('eth_requestAccounts')).toEqual([EVM_A.toLowerCase()]);
    expect(state.approvals[0]).toMatchObject({
      kind: 'connect',
      origin: SITE,
      open: { walletId: 'wallet-a', name: 'Main', address: EVM_A },
      wallets: [],
      preselect: null,
    });
    expect(await ok('eth_accounts')).toEqual([EVM_A.toLowerCase()]);
    expect(await ok('eth_accounts', [], tabSender(OTHER))).toEqual([]);
    expect(await ok('eth_requestAccounts')).toEqual([EVM_A.toLowerCase()]);
    expect(state.approvals).toHaveLength(1);
  });

  it('maps a rejection to 4001 and stores nothing', async () => {
    state.approve = false;
    expect(await code('eth_requestAccounts')).toBe(4001);
    expect(await ok('eth_accounts')).toEqual([]);
  });

  it('shows no accounts while locked, then the same ones after unlock without a prompt', async () => {
    await ok('eth_requestAccounts');
    state.locked = true;
    expect(await ok('eth_accounts')).toEqual([]);
    expect(await ok('wallet_getProviderState')).toMatchObject({ accounts: [], isUnlocked: false });
    state.locked = false;
    expect(await ok('eth_accounts')).toEqual([EVM_A.toLowerCase()]);
    expect(state.approvals).toHaveLength(1);
  });

  it('tells a site that is not connected nothing about the lock', async () => {
    const stranger = tabSender('https://stranger.app');
    const openPopup = chrome.action.openPopup as unknown as ReturnType<typeof vi.fn>;
    const unlockedState = await ok('wallet_getProviderState', [], stranger);
    const unlockedSign = await call('personal_sign', ['0x68656c6c6f', EVM_A], stranger);
    state.locked = true;
    openPopup.mockClear();
    expect(await ok('wallet_getProviderState', [], stranger)).toEqual(unlockedState);
    expect(await call('personal_sign', ['0x68656c6c6f', EVM_A], stranger)).toEqual(unlockedSign);
    expect(unlockedSign.error?.code).toBe(4100);
    expect(openPopup).not.toHaveBeenCalled();
  });

  it('tells the site frame when it is disconnected', async () => {
    await ok('eth_requestAccounts');
    const send = chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>;
    send.mockClear();
    await ok('wallet_revokePermissions', [{ eth_accounts: {} }]);
    await vi.waitFor(() =>
      expect(send).toHaveBeenCalledWith(
        1,
        { type: 'EVM_EVENT', data: { origin: SITE, accounts: [], chainId: '0x1' } },
        { frameId: 0 }
      )
    );
  });

  it('grants and revokes the eth_accounts permission', async () => {
    const perms = await ok('wallet_requestPermissions', [{ eth_accounts: {} }]);
    expect(perms[0]).toMatchObject({ parentCapability: 'eth_accounts', invoker: SITE });
    expect(await code('wallet_requestPermissions', [{ snap_dialog: {} }])).toBe(-32602);
    expect(await ok('wallet_getPermissions')).toHaveLength(1);
    await ok('wallet_revokePermissions', [{ eth_accounts: {} }]);
    expect(await ok('eth_accounts')).toEqual([]);
    expect(await ok('wallet_getPermissions')).toEqual([]);
  });
});

describe('chains', () => {
  it('switches to a known chain after review and answers 4902 for an unknown one', async () => {
    expect(await code('wallet_switchEthereumChain', [{ chainId: '0x539' }])).toBe(4902);
    expect(await code('wallet_switchEthereumChain', [{ chainId: 4663 }])).toBe(-32602);
    expect(await ok('wallet_switchEthereumChain', [{ chainId: '0x1237' }])).toBeNull();
    expect(state.approvals[state.approvals.length - 1]).toMatchObject({
      kind: 'switchChain',
      to: { chainId: 4663 },
    });
    expect(await ok('eth_chainId')).toBe('0x1237');
    expect(await ok('eth_chainId', [], tabSender(OTHER))).toBe('0x1');
  });

  it('forwards reads to the site chain and keeps RPC errors intact', async () => {
    expect(await ok('eth_blockNumber')).toBe('0x10');
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    expect(fetchMock.mock.calls[0][0]).toBe('https://ethereum-rpc.publicnode.com');
    fetchMock.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          error: { code: 3, message: 'execution reverted', data: '0xa2ad39b9' },
        })
      )
    );
    const r = await call('eth_call', [{ to: EVM_A, data: '0x' }, 'latest']);
    expect(r.error).toEqual({ code: 3, message: 'execution reverted', data: '0xa2ad39b9' });
    expect(await code('eth_call', { to: EVM_A })).toBe(-32602);
  });

  it('never fills a read with the open wallet for a site that is not connected', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    fetchMock.mockClear();
    await call(
      'eth_call',
      [{ to: EVM_A, data: '0x' }, 'latest'],
      tabSender('https://stranger.app')
    );
    const body = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
    expect(body.params).toEqual([{ to: EVM_A, data: '0x' }, 'latest']);
    expect(body.params[0]).not.toHaveProperty('from');
  });
});

describe('signing', () => {
  it('needs a connection, then signs personal_sign like viem', async () => {
    expect(await code('personal_sign', ['0x48656c6c6f', EVM_A])).toBe(4100);
    await ok('eth_requestAccounts');
    expect(await code('personal_sign', ['hi', EVM_B])).toBe(4100);
    const sig = await ok('personal_sign', ['Hello from 0xio', EVM_A]);
    expect(sig).toBe(
      '0x5d9321c9afa33ec788c2399d945a14983b096af4f3d08d4dff4f638df24c6ec65e819e9f55bc05683c6b1742735c9ed0bf79290209824ae1279d54b0145caf2b1c'
    );
    expect(state.approvals[state.approvals.length - 1]).toMatchObject({
      kind: 'personalSign',
      text: 'Hello from 0xio',
    });
    state.approve = false;
    expect(await code('personal_sign', ['again', EVM_A])).toBe(4001);
  });

  it('checks typed data and its domain chain before any review', async () => {
    await ok('eth_requestAccounts');
    const typed = {
      types: { Thing: [{ name: 'n', type: 'uint8' }] },
      primaryType: 'Thing',
      domain: { name: 'T', chainId: 11155111 },
      message: { n: 1 },
    };
    const before = state.approvals.length;
    expect(await code('eth_signTypedData_v4', [EVM_A, JSON.stringify(typed)])).toBe(-32602);
    expect(await code('eth_signTypedData_v4', [EVM_A, '{not json'])).toBe(-32602);
    expect(state.approvals.length).toBe(before);
    const sig = await ok('eth_signTypedData_v4', [
      EVM_A,
      JSON.stringify({ ...typed, primaryType: 'Thing', domain: { name: 'T', chainId: 1 } }),
    ]);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
  });
});

describe('eth_sendTransaction', () => {
  const USDC = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48';
  const approveData =
    '0x095ea7b3' + '3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad'.padStart(64, '0') + 'f'.repeat(64);

  it('reviews, then signs and returns the hash', async () => {
    await ok('eth_requestAccounts');
    expect(await code('eth_sendTransaction', [{ from: EVM_B, to: USDC }])).toBe(4100);
    expect(await code('eth_sendTransaction', [{ from: EVM_A, data: '0x' }])).toBe(-32602);
    expect(await code('eth_sendTransaction', [{ from: EVM_A, to: USDC, value: 'lots' }])).toBe(
      -32602
    );
    const hash = await ok('eth_sendTransaction', [
      { from: EVM_A.toLowerCase(), to: USDC, data: approveData, gas: '0x60000' },
    ]);
    expect(hash).toBe('0x' + 'ab'.repeat(32));
    const review = state.approvals[state.approvals.length - 1];
    expect(review).toMatchObject({
      kind: 'sendTx',
      selector: '0x095ea7b3',
      call: { kind: 'approve', unlimited: true },
      token: { symbol: 'USDC', decimals: 6 },
      gasLimit: String(0x60000),
    });
    const calls = (signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const sent = calls[calls.length - 1];
    expect(sent[1]).toMatchObject({ chainId: 1, nonce: 7, gasLimit: 0x60000n });
    expect(sent[2]).toEqual({ id: 'wallet-a', evmIndex: 0, evmAddress: EVM_A });
  });

  it("uses the wallet's live fee, and the site's fee only when the network gives none", async () => {
    await ok('eth_requestAccounts');
    const sends = () => (signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls;
    await ok('eth_sendTransaction', [
      { from: EVM_A, to: USDC, value: '0x1', maxFeePerGas: '0x99' },
    ]);
    expect(sends()[sends().length - 1][1]).toMatchObject({
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    });
    expect(state.approvals[state.approvals.length - 1]).toMatchObject({ feeFromSite: false });

    fees.fail = true;
    try {
      await ok('eth_sendTransaction', [
        { from: EVM_A, to: USDC, value: '0x1', maxFeePerGas: '0x99', maxPriorityFeePerGas: '0x2' },
      ]);
      expect(sends()[sends().length - 1][1]).toMatchObject({
        maxFeePerGas: 0x99n,
        maxPriorityFeePerGas: 2n,
      });
      expect(state.approvals[state.approvals.length - 1]).toMatchObject({ feeFromSite: true });
      await ok('eth_sendTransaction', [{ from: EVM_A, to: USDC, value: '0x1', gasPrice: '0x50' }]);
      expect(sends()[sends().length - 1][1]).toMatchObject({
        maxFeePerGas: 0x50n,
        maxPriorityFeePerGas: 0x50n,
      });
      expect(await code('eth_sendTransaction', [{ from: EVM_A, to: USDC, value: '0x1' }])).toBe(
        -32603
      );
    } finally {
      fees.fail = false;
    }
  });

  it('deploys a contract after a review that shows its future address', async () => {
    await ok('eth_requestAccounts');
    const init = '0x6080604052348015600f57600080fd5b50';
    await ok('eth_sendTransaction', [{ from: EVM_A, data: init }]);
    const review = state.approvals[state.approvals.length - 1];
    expect(review).toMatchObject({
      kind: 'sendTx',
      deploy: { codeSize: 17 },
      selector: null,
      call: null,
      to: contractAddressFor(EVM_A, 7),
    });
    const calls = (signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][1]).toMatchObject({ to: null, data: init, nonce: 7 });
    expect(
      await code('eth_sendTransaction', [{ from: EVM_A, data: '0x' + '00'.repeat(49_153) }])
    ).toBe(-32602);
  });

  it('refuses a deployment when the nonce moved after the review', async () => {
    await ok('eth_requestAccounts');
    const nonce = getNonce as unknown as ReturnType<typeof vi.fn>;
    nonce.mockResolvedValueOnce(7).mockResolvedValueOnce(8);
    expect(await code('eth_sendTransaction', [{ from: EVM_A, data: '0x60806040' }])).toBe(-32603);
  });

  it('signs the approve amount the user chose on the review', async () => {
    await ok('eth_requestAccounts');
    const sends = () => (signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const spender = '0x3fC91A3afd70395Cd496C647d5a6CC9D4B2b7FAD';

    state.edit = { unlimited: false, amount: '250000000' };
    await ok('eth_sendTransaction', [{ from: EVM_A, to: USDC, data: approveData }]);
    expect(sends()[sends().length - 1][1].data).toBe(erc20ApproveData(spender, 250_000_000n));
    expect(state.approvals[state.approvals.length - 1].data).toBe(approveData);

    const finite = erc20ApproveData(spender, 5_000_000n);
    state.edit = { unlimited: true };
    await ok('eth_sendTransaction', [{ from: EVM_A, to: USDC, data: finite }]);
    expect(sends()[sends().length - 1][1].data).toBe(erc20ApproveData(spender, (1n << 256n) - 1n));

    const before = sends().length;
    state.edit = { unlimited: false, amount: '5000001' };
    expect(await code('eth_sendTransaction', [{ from: EVM_A, to: USDC, data: finite }])).toBe(
      -32603
    );
    state.edit = { unlimited: false, amount: '1' };
    expect(await code('eth_sendTransaction', [{ from: EVM_A, to: USDC, value: '0x1' }])).toBe(
      -32603
    );
    expect(sends().length).toBe(before);
  });

  it('sends nothing when the review is rejected', async () => {
    await ok('eth_requestAccounts');
    const before = (signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.length;
    state.approve = false;
    expect(await code('eth_sendTransaction', [{ from: EVM_A, to: USDC, value: '0x1' }])).toBe(4001);
    expect((signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls.length).toBe(
      before
    );
  });
});

describe('site storage', () => {
  it('keeps chains per side and accounts per wallet', async () => {
    await setSiteChain(SITE, 4663);
    state.local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
    expect(await siteChainId(SITE)).toBe(11155111);
    await setSiteChain(SITE, 46630);
    state.local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'mainnet');
    expect(await siteChainId(SITE)).toBe(4663);

    await Promise.all([
      connectEvmSite(SITE, 'wallet-a', EVM_A),
      connectEvmSite(SITE, 'wallet-b', EVM_B),
      connectEvmSite(OTHER, 'wallet-a', EVM_A),
    ]);
    let sites = await loadEvmSites();
    expect(Object.keys(sites[SITE].accounts).sort()).toEqual(['wallet-a', 'wallet-b']);
    await disconnectEvmSite(SITE, 'wallet-b');
    sites = await loadEvmSites();
    expect(Object.keys(sites[SITE].accounts)).toEqual(['wallet-a']);
    await disconnectEvmSite(OTHER);
    sites = await loadEvmSites();
    expect(sites[OTHER]).toBeUndefined();
    expect(sites[SITE].chains).toEqual({ mainnet: 4663, testnet: 46630 });
  });
});

describe('the footer chain pick', () => {
  it('moves a connected site to an enabled chain on the shown side and tells its page', async () => {
    await ok('eth_requestAccounts');
    const push = (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mock;
    const pick = (over: Record<string, unknown> = {}) =>
      pickSiteChain({
        origin: SITE,
        chainId: 4663,
        walletId: 'wallet-a',
        side: 'mainnet',
        ...over,
      });

    expect(await pick({ side: 'testnet' })).toBe(false);
    expect(await pick({ walletId: 'wallet-b' })).toBe(false);
    expect(await pick({ chainId: 46630 })).toBe(false);
    expect(await pick({ chainId: 999 })).toBe(false);
    expect(await pick({ origin: 'javascript:alert(1)' })).toBe(false);
    expect(await siteChainId(SITE)).toBe(1);

    expect(await pick()).toBe(true);
    expect(await siteChainId(SITE)).toBe(4663);
    expect(await ok('eth_chainId')).toBe('0x1237');
    await vi.waitFor(() =>
      expect(push.calls.some((c) => (c[1] as any)?.data?.chainId === '0x1237')).toBe(true)
    );
  });
});

describe('the wagmi injected connector', () => {
  const connectLikeWagmi = async () => {
    const perms = await ok('wallet_requestPermissions', [{ eth_accounts: {} }]);
    const granted: string[] = perms[0]?.caveats?.[0]?.value ?? [];
    const accounts: string[] = await ok('eth_accounts');
    const chainId = Number(await ok('eth_chainId'));
    const caps = await ok('wallet_getCapabilities', [EVM_A]);
    return { granted, accounts, chainId, caps };
  };

  it('connects after one review and reports no extra capabilities', async () => {
    expect(await connectLikeWagmi()).toEqual({
      granted: [EVM_A.toLowerCase()],
      accounts: [EVM_A.toLowerCase()],
      chainId: 1,
      caps: {},
    });
    expect(state.approvals.map((a) => a.kind)).toEqual(['connect']);
    expect(await connectLikeWagmi()).toMatchObject({ accounts: [EVM_A.toLowerCase()] });
    expect(state.approvals).toHaveLength(1);
  });

  it('answers capabilities only for the connected address', async () => {
    expect(await code('wallet_getCapabilities', [EVM_A])).toBe(4100);
    await ok('eth_requestAccounts');
    expect(await code('wallet_getCapabilities', [EVM_B])).toBe(4100);
    expect(await ok('wallet_getCapabilities', [EVM_A.toLowerCase(), ['0x1']])).toEqual({});
    expect(await code('wallet_sendCalls', [{ calls: [] }])).toBe(4200);
  });

  it('opens the picker when the open wallet has EVM off', async () => {
    setActive('wallet-off');
    state.pick = 'wallet-b';
    const perms = await ok('wallet_requestPermissions', [{ eth_accounts: {} }]);
    expect(perms[0].caveats[0].value).toEqual([EVM_B.toLowerCase()]);
    expect(state.approvals[0]).toMatchObject({ kind: 'connect', open: { address: null } });
  });
});

describe('reads', () => {
  it('answers web3_sha3 and net_listening itself', async () => {
    expect(await ok('web3_sha3', ['0x68656c6c6f'])).toBe(
      '0x1c8aff950685c2ed4bc3174f3472287b56d9517b9c948127319a09a7a36deac8'
    );
    expect(await code('web3_sha3', ['hello'])).toBe(-32602);
    expect(await ok('net_listening')).toBe(true);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('forwards syncing, filter and proof reads to the site chain', async () => {
    const fetchMock = fetch as unknown as ReturnType<typeof vi.fn>;
    for (const method of [
      'eth_syncing',
      'eth_newBlockFilter',
      'eth_newFilter',
      'eth_getFilterChanges',
      'eth_uninstallFilter',
      'eth_getProof',
      'eth_createAccessList',
      'eth_getBlockReceipts',
    ]) {
      expect(await ok(method, [])).toBe('0x10');
      const body = JSON.parse(fetchMock.mock.calls[fetchMock.mock.calls.length - 1][1].body);
      expect(body.method).toBe(method);
    }
  });

  it('serves a burst of reads from one site without -32005', async () => {
    const sender = tabSender('https://burst.example');
    const out = await Promise.all(
      Array.from({ length: 150 }, (_, i) =>
        call('eth_getBalance', ['0x' + i.toString(16).padStart(40, '0'), 'latest'], sender)
      )
    );
    expect(out.filter((r) => !r.success)).toEqual([]);
    for (let i = 0; i < 100; i++) await ok('eth_chainId', [], sender);
  });

  it('still refuses a flood', async () => {
    const sender = tabSender('https://flood.example');
    const out = await Promise.all(
      Array.from({ length: 400 }, () => call('eth_blockNumber', [], sender))
    );
    expect(out.some((r) => r.error?.code === -32005)).toBe(true);
  });
});

describe('the same request sent twice at once', () => {
  it('shares one connect review between both calls', async () => {
    const [a, b, perms] = await Promise.all([
      call('eth_requestAccounts'),
      call('eth_requestAccounts'),
      call('wallet_requestPermissions', [{ eth_accounts: {} }]),
    ]);
    expect(a.data).toEqual([EVM_A.toLowerCase()]);
    expect(b.data).toEqual([EVM_A.toLowerCase()]);
    expect(perms.data[0].caveats[0].value).toEqual([EVM_A.toLowerCase()]);
    expect(state.approvals.filter((x) => x.kind === 'connect')).toHaveLength(1);
  });

  it('shares one switch review, and a rejection reaches both', async () => {
    state.approve = false;
    const twice = await Promise.all([
      call('wallet_switchEthereumChain', [{ chainId: '0x1237' }]),
      call('wallet_switchEthereumChain', [{ chainId: '0x1237' }]),
    ]);
    expect(twice.map((r) => r.error?.code)).toEqual([4001, 4001]);
    expect(state.approvals).toHaveLength(1);
    state.approve = true;
    await ok('wallet_switchEthereumChain', [{ chainId: '0x1237' }]);
    expect(state.approvals).toHaveLength(2);
  });
});

const A = EVM_A.toLowerCase();
const B = EVM_B.toLowerCase();

const open = async (id: string) => {
  setActive(id);
  await syncEvmSites();
};

const lastPush = (origin = SITE) => {
  const calls = (chrome.tabs.sendMessage as unknown as ReturnType<typeof vi.fn>).mock.calls;
  const mine = calls.filter((c) => (c[1] as any)?.data?.origin === origin);
  return (mine[mine.length - 1]?.[1] as any)?.data;
};

describe('connecting when the open wallet has no EVM address', () => {
  it('lists the wallets with one and picks the one used last', async () => {
    await connectEvmSite(OTHER, 'wallet-b', EVM_B);
    await open('wallet-key');
    state.pick = 'wallet-b';
    expect(await ok('eth_requestAccounts')).toEqual([B]);
    const review = state.approvals[0];
    expect(review).toMatchObject({
      kind: 'connect',
      open: { walletId: 'wallet-key', name: 'Trading', address: null },
      preselect: 'wallet-b',
    });
    expect(review.wallets.map((w: any) => w.walletId)).toEqual(['wallet-a', 'wallet-b']);
    expect((await loadEvmSites())[SITE]).toMatchObject({
      inUse: 'wallet-b',
      seenOpen: 'wallet-key',
    });
  });

  it('answers 4001 when nothing is picked or the pick has no EVM address', async () => {
    await open('wallet-key');
    expect(await code('eth_requestAccounts')).toBe(4001);
    state.pick = 'wallet-watch';
    expect(await code('eth_requestAccounts')).toBe(4001);
    state.pick = 'wallet-off';
    expect(await code('eth_requestAccounts')).toBe(4001);
    expect(await ok('eth_accounts')).toEqual([]);
    expect((await loadEvmSites())[SITE]).toBeUndefined();
  });

  it('opens the empty review when no wallet has one, and Close answers 4001', async () => {
    vault.splice(0, vault.length, ...fullVault.filter((w) => !w.metadata?.evm));
    await open('wallet-key');
    state.approve = false;
    expect(await code('eth_requestAccounts')).toBe(4001);
    expect(state.approvals[0]).toMatchObject({ kind: 'connect', wallets: [], preselect: null });
  });

  it('connects a wallet added while the review is open', async () => {
    vault.splice(0, vault.length, ...fullVault.filter((w) => !w.metadata?.evm));
    await open('wallet-key');
    state.during = () => vault.push(fullVault[0]);
    state.pick = 'wallet-a';
    expect(await ok('eth_requestAccounts')).toEqual([A]);
  });
});

describe('several wallets per site', () => {
  it('follows the open wallet when it is one of the site wallets', async () => {
    await ok('eth_requestAccounts');
    await open('wallet-b');
    await ok('wallet_requestPermissions', [{ eth_accounts: {} }]);
    expect(state.approvals.map((r) => r.open.walletId)).toEqual(['wallet-a', 'wallet-b']);
    expect(await ok('eth_accounts')).toEqual([B]);
    await open('wallet-a');
    expect(await ok('eth_accounts')).toEqual([A]);
    await pushEvmState([SITE]);
    expect(lastPush().accounts).toEqual([A]);
    await open('wallet-b');
    expect(await ok('eth_accounts')).toEqual([B]);
  });

  it('keeps its last wallet when the open one is not connected, and never disconnects', async () => {
    await ok('eth_requestAccounts');
    await open('wallet-key');
    expect(await ok('eth_accounts')).toEqual([A]);
    await open('wallet-off');
    expect(await ok('eth_accounts')).toEqual([A]);
    expect(await ok('eth_requestAccounts')).toEqual([A]);
    await pushEvmState([SITE]);
    expect(lastPush().accounts).toEqual([A]);
    expect(state.approvals).toHaveLength(1);
  });

  it('adds the open wallet from the popup review and uses it', async () => {
    await ok('eth_requestAccounts');
    await open('wallet-b');
    expect(await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' })).toBe(true);
    expect(await ok('eth_accounts')).toEqual([B]);
    expect(await connectSiteWallet({ origin: SITE, walletId: 'wallet-watch' })).toBe(false);
    expect(await connectSiteWallet({ origin: SITE, walletId: 'wallet-off' })).toBe(false);
    expect(await connectSiteWallet({ origin: 'javascript:1', walletId: 'wallet-a' })).toBe(false);
  });

  it('never offers or signs with a watch-only wallet, even one carrying an EVM address', async () => {
    const watch = vault.find((w) => w.id === 'wallet-watch')!;
    watch.metadata = {
      evm: { enabled: true, address: EVM_B, index: 1, sourceWalletId: 'wallet-a' },
    };
    try {
      await open('wallet-watch');
      expect(await code('personal_sign', ['0x48656c6c6f', EVM_B])).toBe(4100);
      expect(await code('eth_sendTransaction', [{ from: EVM_B, to: EVM_A, value: '0x1' }])).toBe(
        4100
      );
      state.pick = 'wallet-watch';
      expect(await code('eth_requestAccounts')).toBe(4001);
      expect(state.approvals[0]).toMatchObject({ kind: 'connect', open: { address: null } });
      expect(state.approvals[0].wallets.map((w: any) => w.walletId)).not.toContain('wallet-watch');
      expect(await connectSiteWallet({ origin: SITE, walletId: 'wallet-watch' })).toBe(false);
      expect(await ok('eth_accounts')).toEqual([]);
    } finally {
      watch.metadata = {};
    }
  });

  it('switches the wallet in use until another connected wallet is opened', async () => {
    await ok('eth_requestAccounts');
    await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' });
    await open('wallet-b');
    expect(await ok('eth_accounts')).toEqual([B]);
    expect(await setSiteWallet({ origin: SITE, walletId: 'wallet-a' })).toBe(true);
    expect(await ok('eth_accounts')).toEqual([A]);
    await open('wallet-key');
    expect(await ok('eth_accounts')).toEqual([A]);
    await open('wallet-b');
    expect(await ok('eth_accounts')).toEqual([B]);
    expect(await setSiteWallet({ origin: SITE, walletId: 'wallet-off' })).toBe(false);
  });

  it('removes one wallet, then the site, and tells the page', async () => {
    await ok('eth_requestAccounts');
    await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' });
    expect(await ok('eth_accounts')).toEqual([B]);
    await disconnectEvmSite(SITE, 'wallet-b');
    expect(await ok('eth_accounts')).toEqual([A]);
    await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' });
    await disconnectEvmSite(SITE);
    expect(await ok('eth_accounts')).toEqual([]);
    await pushEvmState([SITE]);
    expect(lastPush().accounts).toEqual([]);
  });

  it('drops a wallet removed from 0xio from every site', async () => {
    await ok('eth_requestAccounts');
    await ok('eth_requestAccounts', [], tabSender(OTHER));
    await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' });
    vault.splice(0, 1);
    await open('wallet-b');
    const sites = await loadEvmSites();
    expect(Object.keys(sites[SITE].accounts)).toEqual(['wallet-b']);
    expect(sites[OTHER]).toBeUndefined();
    expect(await ok('eth_accounts', [], tabSender(OTHER))).toEqual([]);
    await pushEvmState([OTHER]);
    expect(lastPush(OTHER).accounts).toEqual([]);
  });

  it('wallet_revokePermissions disconnects every wallet', async () => {
    await ok('eth_requestAccounts');
    await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' });
    await ok('wallet_revokePermissions', [{ eth_accounts: {} }]);
    expect((await loadEvmSites())[SITE]).toBeUndefined();
    await open('wallet-b');
    expect(await ok('eth_accounts')).toEqual([]);
  });

  it('reads sites stored with one wallet each without losing them', async () => {
    state.local.set(EVM_SITES_KEY, {
      [SITE]: {
        origin: SITE,
        chains: { mainnet: 4663 },
        accounts: {
          'wallet-a': { address: EVM_A, connectedAt: 1 },
          'wallet-b': { address: EVM_B, connectedAt: 2 },
          broken: { address: 'nope', connectedAt: 3 },
        },
      },
    });
    setActive('wallet-key');
    expect(await ok('eth_accounts')).toEqual([B]);
    expect(await ok('eth_chainId')).toBe('0x1237');
    await open('wallet-a');
    expect(await ok('eth_accounts')).toEqual([A]);
    expect(Object.keys((await loadEvmSites())[SITE].accounts).sort()).toEqual([
      'wallet-a',
      'wallet-b',
    ]);
  });
});

describe("signing with the site's wallet", () => {
  it('signs with the wallet the site uses and names it and the open wallet', async () => {
    await ok('eth_requestAccounts');
    await open('wallet-key');
    const sig = await ok('personal_sign', ['Hello from 0xio', EVM_A]);
    expect(sig).toMatch(/^0x[0-9a-f]{130}$/);
    expect(state.approvals[state.approvals.length - 1]).toMatchObject({
      kind: 'personalSign',
      signer: { walletId: 'wallet-a', name: 'Main', address: EVM_A, octra: 'octA' },
      openWallet: { walletId: 'wallet-key', name: 'Trading' },
    });
    await ok('personal_sign', ['no address']);
    expect(state.approvals[state.approvals.length - 1].signer.walletId).toBe('wallet-a');
  });

  it('refuses a request naming a connected wallet the site does not use', async () => {
    await ok('eth_requestAccounts');
    await connectSiteWallet({ origin: SITE, walletId: 'wallet-b' });
    expect(await ok('eth_accounts')).toEqual([B]);
    const before = state.approvals.length;
    expect(await code('personal_sign', ['hi', EVM_A])).toBe(4100);
    expect(state.approvals.length).toBe(before);
  });

  it('refuses when the open wallet it named changes during the review', async () => {
    await ok('eth_requestAccounts');
    state.during = () => setActive('wallet-b');
    expect(await code('personal_sign', ['hi', EVM_A])).toBe(4100);
  });

  it('still signs when the review named another wallet and the open one changes', async () => {
    await ok('eth_requestAccounts');
    await open('wallet-key');
    state.during = () => setActive('wallet-off');
    expect(await ok('personal_sign', ['hi', EVM_A])).toMatch(/^0x/);
  });

  it('refuses when the signing wallet leaves the site during the review', async () => {
    await ok('eth_requestAccounts');
    await open('wallet-key');
    state.during = () => state.local.delete(EVM_SITES_KEY);
    expect(await code('personal_sign', ['hi', EVM_A])).toBe(4100);
  });

  it("sends a transaction with the site's wallet key", async () => {
    await ok('eth_requestAccounts');
    await open('wallet-key');
    await ok('eth_sendTransaction', [{ from: EVM_A, to: EVM_B, value: '0x1' }]);
    const calls = (signAndBroadcast as unknown as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls[calls.length - 1][2]).toEqual({ id: 'wallet-a', evmIndex: 0, evmAddress: EVM_A });
    expect(state.approvals[state.approvals.length - 1]).toMatchObject({
      kind: 'sendTx',
      signer: { walletId: 'wallet-a' },
      openWallet: { walletId: 'wallet-key' },
    });
  });
});

describe('a chain on the other side', () => {
  const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;

  it('asks to move all of 0xio, then moves the side and the site', async () => {
    expect(await ok('wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }])).toBeNull();
    expect(state.approvals[0]).toMatchObject({
      kind: 'switchSide',
      side: 'testnet',
      from: { chainId: 1 },
      to: { chainId: 11155111, testnet: true },
    });
    expect(state.local.get(NET)).toBe('devnet');
    expect(await ok('eth_chainId')).toBe('0xaa36a7');
  });

  it('changes nothing when rejected, and shares one review between duplicates', async () => {
    state.approve = false;
    const twice = await Promise.all([
      call('wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }]),
      call('wallet_switchEthereumChain', [{ chainId: '0xaa36a7' }]),
    ]);
    expect(twice.map((r) => r.error?.code)).toEqual([4001, 4001]);
    expect(state.approvals).toHaveLength(1);
    expect(state.local.get(NET)).toBeUndefined();
    expect(await ok('eth_chainId')).toBe('0x1');
  });

  it('moves back to Mainnet the same way from Testnet', async () => {
    state.local.set(NET, 'devnet');
    await ok('wallet_addEthereumChain', [
      {
        chainId: '0x1',
        chainName: 'Ethereum',
        rpcUrls: ['https://x.example'],
        nativeCurrency: { symbol: 'ETH', decimals: 18 },
      },
    ]);
    expect(state.approvals[0]).toMatchObject({ kind: 'switchSide', side: 'mainnet' });
    expect(state.local.get(NET)).toBe('mainnet');
  });

  it('keeps the plain switch review on the same side', async () => {
    await ok('wallet_switchEthereumChain', [{ chainId: '0x1237' }]);
    expect(state.approvals[0].kind).toBe('switchChain');
  });
});
