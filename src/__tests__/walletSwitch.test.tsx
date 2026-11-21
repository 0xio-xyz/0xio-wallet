import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const h = vi.hoisted(() => ({
  wallets: [
    {
      id: 'w1',
      name: 'A',
      address: 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
      privateKey: 'pkA',
      publicKey: 'pubA',
    },
    {
      id: 'w2',
      name: 'B',
      address: 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
      privateKey: 'pkB',
      publicKey: 'pubB',
    },
  ],
  activeId: 'w1',
  local: {} as Record<string, unknown>,
  session: {} as Record<string, unknown>,
  getBalance: null as unknown as (...a: unknown[]) => Promise<unknown>,
  getEnc: null as unknown as (...a: unknown[]) => Promise<unknown>,
}));

vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: {
    isInitialized: async () => true,
    loadAllWallets: async () => h.wallets,
    getActiveWalletId: async () => h.activeId,
    setActiveWallet: async (id: string) => {
      h.activeId = id;
    },
  },
}));
vi.mock('src/services/crypto/PasswordManager', () => ({
  passwordManager: {
    initializeUnlockStatus: async () => {},
    isPasswordSkipped: async () => false,
    isUnlocked: () => true,
    setupActivityTracking: () => {},
    getSessionKey: async () => 'session',
  },
  WrongPasswordError: class extends Error {},
  LockedOutError: class extends Error {},
}));
vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getBalance: (...a: unknown[]) => h.getBalance(...a),
    balanceCache: new Map(),
    txDetailCache: new Map(),
  },
  privacyNetworkService: {
    getEncryptedBalanceDevnet: (...a: unknown[]) => h.getEnc(...a),
    clearDecryptCache: () => {},
    getPvacPubkey: async (): Promise<string | null> => null,
  },
}));
vi.mock('src/services/pvac/PvacManager', () => ({
  pvacManager: { isReady: false, pvacForeign: false, lastDecryptCorrupted: false, destroy() {} },
}));
vi.mock('src/services/wallet/MigrationService', () => ({
  MigrationService: { checkAndMigrate: async () => ({ success: true, migrated: false }) },
}));
vi.mock('src/services/wallet/BalanceHistory', () => ({
  appendSnapshot: async () => {},
  stripPrivateFromSnapshots: async () => {},
}));
vi.mock('src/services/pvac/keySwitchService', () => ({
  getPendingKeySwitch: async (): Promise<null> => null,
  clearPendingKeySwitch: async () => {},
  resolveRotationState: async () => ({ kind: 'none' }),
}));
vi.mock('src/services/network/txScope', () => ({
  storedNetworkId: async () => 'devnet',
  resolveNetworkPin: async (networkId: string) => ({ networkId, rpcUrl: 'http://node' }),
}));

import { WalletProvider, useWallet } from 'src/contexts/WalletContext';
import { balanceCacheKey } from 'src/services/wallet/balanceCache';
import { registerScopeWarmer } from 'src/utils/scopeWarmers';

const A = h.wallets[0].address;
const B = h.wallets[1].address;

let listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
let ctx: ReturnType<typeof useWallet>;
let renders: Array<{
  addr: string | undefined;
  pub: string | null;
  total: string | null;
  loading: boolean;
  foreign: boolean;
}> = [];
const pubCalls: Array<Deferred<unknown>> = [];
const encCalls: Array<Deferred<unknown>> = [];

function Probe(): null {
  ctx = useWallet();
  renders.push({
    addr: ctx.activeWallet?.address,
    pub: ctx.balance,
    total: ctx.totalBalance,
    loading: ctx.isLoading,
    foreign: ctx.pvacForeign,
  });
  return null;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

const pick = (store: Record<string, unknown>, keys: unknown) => {
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
  return Object.fromEntries(list.filter((k) => k in store).map((k) => [k, store[k]]));
};

async function mountOnA() {
  const view = render(
    <WalletProvider>
      <Probe />
    </WalletProvider>
  );
  await flush();
  await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
  await act(async () =>
    encCalls[0].resolve({
      success: true,
      public: 10,
      publicRaw: 10e6,
      encrypted: 5,
      encryptedRaw: 5e6,
      total: 15,
    })
  );
  await flush();
  expect(ctx.activeWallet?.address).toBe(A);
  expect(ctx.totalBalance).toBe('15');
  return view;
}

beforeEach(() => {
  listeners = [];
  renders = [];
  h.activeId = 'w1';
  h.local = {};
  h.session = { wallet_unlocked: true };
  pubCalls.length = 0;
  encCalls.length = 0;
  let perf = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => ++perf);
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn((keys: unknown, cb?: (r: unknown) => void) => {
    if (cb) {
      cb({});
      return undefined;
    }
    return Promise.resolve(pick(h.local, keys));
  });
  c.storage.local.set = vi.fn(async () => {});
  c.storage.local.remove = vi.fn(async () => {});
  c.storage.session.get = vi.fn(async (keys: unknown) => pick(h.session, keys));
  c.storage.session.set = vi.fn(async () => {});
  c.storage.session.remove = vi.fn(async () => {});
  c.storage.onChanged = {
    addListener: (fn: (typeof listeners)[number]) => listeners.push(fn),
    removeListener: (fn: (typeof listeners)[number]) => {
      listeners = listeners.filter((l) => l !== fn);
    },
  };
  c.runtime.sendMessage = vi.fn(() => Promise.resolve());
  h.getBalance = vi.fn(() => {
    const d = deferred<unknown>();
    pubCalls.push(d);
    return d.promise;
  });
  h.getEnc = vi.fn(() => {
    const d = deferred<unknown>();
    encCalls.push(d);
    return d.promise;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('switching wallets', () => {
  it('lands on the new wallet stored figures in its first render, with no loading screen or empty wallet', async () => {
    const view = await mountOnA();
    const key = balanceCacheKey('devnet', B);
    h.local[key] = { balance: '7' };
    h.session[key] = { privateBalance: '3', totalBalance: '10' };

    renders = [];
    await act(async () => {
      await ctx.switchWallet(B);
    });
    await flush();

    expect(renders.some((r) => r.loading)).toBe(false);
    expect(renders.some((r) => r.addr === undefined)).toBe(false);
    const underB = renders.filter((r) => r.addr === B);
    expect(underB.length).toBeGreaterThan(0);
    expect(underB[0]).toMatchObject({ pub: '7', total: '10' });
    for (const r of underB) expect(r.total).not.toBe('15');
    view.unmount();
  });

  it('says which wallet it switched to, only when the wallet changes', async () => {
    const view = await mountOnA();
    await act(async () => {
      await ctx.switchWallet(B);
    });
    await flush();
    expect(ctx.message?.type).toBe('info');
    expect(ctx.message?.text).toBeTruthy();
    act(() => ctx.hideMessage());
    await act(async () => {
      await ctx.switchWallet(B);
    });
    await flush();
    expect(ctx.message).toBeNull();
    view.unmount();
  });

  it('drops a late read of the previous wallet', async () => {
    const view = await mountOnA();
    await act(async () => {
      await ctx.refreshBalance(A, ctx.activeWallet, true);
    });
    const late = pubCalls[pubCalls.length - 1];

    renders = [];
    await act(async () => {
      await ctx.switchWallet(B);
    });
    await act(async () => late.resolve({ success: true, balance: 99 }));
    await flush();

    const underB = renders.filter((r) => r.addr === B);
    expect(underB.length).toBeGreaterThan(0);
    for (const r of underB) expect(r.pub).not.toBe('99');
    view.unmount();
  });

  it('a switch from another window clears the previous wallet key verdict in the same render', async () => {
    const view = await mountOnA();
    await act(async () => ctx.setPvacForeign(true));
    expect(ctx.pvacForeign).toBe(true);

    renders = [];
    h.activeId = 'w2';
    await act(async () => {
      for (const l of listeners) l({ activeWalletId: { newValue: 'w2' } }, 'local');
    });
    await flush();

    const underB = renders.filter((r) => r.addr === B);
    expect(underB.length).toBeGreaterThan(0);
    for (const r of underB) expect(r.foreign).toBe(false);
    view.unmount();
  });

  it('fills the registered caches for the new wallet before it shows', async () => {
    const view = await mountOnA();
    const seen: string[] = [];
    const off = registerScopeWarmer(async ({ networkId, wallet }) => {
      seen.push(`${networkId}:${wallet.address}:${ctx.activeWallet?.address}`);
    });
    await act(async () => {
      await ctx.switchWallet(B);
    });
    off();
    expect(seen[0]).toBe(`devnet:${B}:${A}`);
    expect(ctx.activeWallet?.address).toBe(B);
    view.unmount();
  });
});
