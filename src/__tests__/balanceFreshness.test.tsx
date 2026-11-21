import { act, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Deferred<T> = { promise: Promise<T>; resolve: (v: T) => void };
function deferred<T>(): Deferred<T> {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const h = vi.hoisted(() => ({
  wallet: {
    id: 'w1',
    name: 'A',
    address: 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
    privateKey: 'pk',
    publicKey: 'pub',
  },
  getBalance: null as unknown as (...a: unknown[]) => Promise<unknown>,
  getEnc: null as unknown as (...a: unknown[]) => Promise<unknown>,
}));

vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: {
    isInitialized: async () => true,
    loadAllWallets: async () => [h.wallet],
    getActiveWalletId: async () => 'w1',
    setActiveWallet: async () => {},
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
  pvacManager: { isReady: false, pvacForeign: false, lastDecryptCorrupted: false },
}));
vi.mock('src/services/wallet/MigrationService', () => ({
  MigrationService: { checkAndMigrate: async () => ({ success: true, migrated: false }) },
}));
vi.mock('src/services/wallet/BalanceHistory', () => ({ appendSnapshot: async () => {} }));
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

const ADDR = h.wallet.address;
const CACHE_KEY = `balance_cache_devnet_${ADDR}`;

let store: Record<string, unknown> = {};
let sessionStore: Record<string, unknown> = {};
let listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
let clock = 1_000_000;
let perf = 0;
let ctx: ReturnType<typeof useWallet>;
let seen: Array<{ pub: string; priv: string | null; total: string | null }> = [];

const pubCalls: Array<Deferred<unknown>> = [];
const encCalls: Array<Deferred<unknown>> = [];
let joinNext = false;
let lastEnc: Promise<unknown> | null = null;

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

function Probe(): null {
  ctx = useWallet();
  const last = seen[seen.length - 1];
  const now = { pub: ctx.balance, priv: ctx.privateBalance, total: ctx.totalBalance };
  if (!last || last.pub !== now.pub || last.priv !== now.priv || last.total !== now.total) {
    seen.push(now);
  }
  return null;
}

const enc = (pub: number, priv: number) => ({
  success: true,
  public: pub,
  publicRaw: pub * 1e6,
  encrypted: priv,
  encryptedRaw: priv * 1e6,
  total: pub + priv,
});

async function mount() {
  const view = render(
    <WalletProvider>
      <Probe />
    </WalletProvider>
  );
  await flush();
  return view;
}

const totals = () => seen.map((s) => s.total).filter((t) => t !== null);
const pubs = () => seen.map((s) => s.pub);

beforeEach(() => {
  store = {};
  sessionStore = { wallet_unlocked: true };
  listeners = [];
  seen = [];
  clock = 1_000_000;
  perf = 0;
  pubCalls.length = 0;
  encCalls.length = 0;
  joinNext = false;
  lastEnc = null;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(performance, 'now').mockImplementation(() => ++perf);
  const pick = (keys: unknown) => {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in store) out[k as string] = store[k as string];
    return out;
  };
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn((keys: unknown, cb?: (r: unknown) => void) => {
    const r = pick(keys);
    if (cb) {
      cb(r);
      return undefined;
    }
    return Promise.resolve(r);
  });
  c.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(store, items);
  });
  c.storage.local.remove = vi.fn(async () => {});
  c.storage.session.get = vi.fn(async (keys: unknown) => {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
    const out: Record<string, unknown> = {};
    for (const k of list) if (k in sessionStore) out[k as string] = sessionStore[k as string];
    return out;
  });
  c.storage.session.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(sessionStore, items);
  });
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
    if (joinNext && lastEnc) {
      joinNext = false;
      return lastEnc;
    }
    const d = deferred<unknown>();
    encCalls.push(d);
    const readAt = performance.now();
    lastEnc = d.promise.then((r) => ({ ...(r as object), readAt }));
    return lastEnc;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('Home total balance only moves forward', () => {
  it('keeps the newer public balance when an older shared response lands last', async () => {
    const view = await mount();
    await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
    await flush();
    expect(ctx.balance).toBe('10');

    clock += 6_000;
    joinNext = true;
    await act(async () => {
      void ctx.refreshBalance(undefined, undefined, true);
    });
    await flush();
    await act(async () => pubCalls[1].resolve({ success: true, balance: 12 }));
    await flush();
    expect(ctx.balance).toBe('12');

    await act(async () => encCalls[0].resolve(enc(10, 5)));
    await flush();

    const firstNew = pubs().indexOf('12');
    expect(pubs().slice(firstNew)).not.toContain('10');
    expect(ctx.balance).toBe('12');

    expect(encCalls.length).toBe(2);
    await act(async () => encCalls[1].resolve(enc(12, 5)));
    await flush();
    expect(ctx.totalBalance).toBe('17');
    expect(totals()[totals().length - 1]).toBe('17');
    view.unmount();
  });

  it('does not re-apply an older cached balance over newer values', async () => {
    store[CACHE_KEY] = { balance: '10' };
    sessionStore[CACHE_KEY] = { privateBalance: '5', totalBalance: '15' };
    const view = await mount();
    expect(ctx.totalBalance).toBe('15');

    await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[0].resolve(enc(10, 5)));
    await flush();

    await act(async () => ctx.adjustBalanceOptimistic(-3, 3));
    await flush();
    expect(ctx.privateBalance).toBe('8');
    expect(ctx.totalBalance).toBe('15');
    expect(ctx.balance).toBe('7');

    await act(async () => {
      for (const l of listeners) l({ activeWalletId: { newValue: 'w1' } }, 'local');
    });
    await flush();

    expect(ctx.privateBalance).toBe('8');
    expect(ctx.balance).toBe('7');
    const firstOptimistic = seen.findIndex((s) => s.priv === '8');
    expect(seen.slice(firstOptimistic).map((s) => s.priv)).not.toContain('5');
    view.unmount();
  });

  it('never mixes a fresh public balance with a dropped or stale private half', async () => {
    const view = await mount();
    await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[0].resolve(enc(10, 5)));
    await flush();
    expect(ctx.totalBalance).toBe('15');

    clock += 6_000;
    await act(async () => {
      void ctx.refreshBalance(undefined, undefined, true);
    });
    await flush();
    await act(async () =>
      encCalls[1].resolve({
        success: false,
        public: 0,
        publicRaw: 0,
        encrypted: 0,
        encryptedRaw: 0,
        total: 0,
      })
    );
    await flush();
    for (const d of pubCalls.slice(1)) {
      await act(async () => d.resolve({ success: true, balance: 12 }));
    }
    await flush();

    expect(ctx.balance).toBe('12');
    expect(ctx.privateBalance).toBe('5');
    expect(ctx.totalBalance).toBe('15');
    view.unmount();
  });

  it('holds an optimistic value against a read that predates the tx', async () => {
    const view = await mount();
    await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[0].resolve(enc(10, 5)));
    await flush();

    await act(async () => ctx.adjustBalanceOptimistic(0, 2));
    expect(ctx.totalBalance).toBe('17');

    clock += 6_000;
    await act(async () => {
      void ctx.refreshBalance(undefined, undefined, true);
    });
    await flush();
    await act(async () => pubCalls[1].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[1].resolve(enc(10, 5)));
    await flush();
    expect(ctx.totalBalance).toBe('17');

    clock += 6_000;
    await act(async () => {
      void ctx.refreshBalance(undefined, undefined, true);
    });
    await flush();
    await act(async () => pubCalls[2].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[2].resolve(enc(10, 7)));
    await flush();
    expect(ctx.totalBalance).toBe('17');
    expect(ctx.privateBalance).toBe('7');
    view.unmount();
  });
});
