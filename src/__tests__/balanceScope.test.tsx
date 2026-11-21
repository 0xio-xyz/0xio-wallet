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
  getBalance: null as unknown as (...a: unknown[]) => Promise<unknown>,
  getEnc: null as unknown as (...a: unknown[]) => Promise<unknown>,
  netGate: null as Promise<void> | null,
}));

vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: {
    isInitialized: async () => true,
    loadAllWallets: async () => h.wallets,
    getActiveWalletId: async () => h.activeId,
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
  storedNetworkId: async () => {
    if (h.netGate) await h.netGate;
    return 'devnet';
  },
  resolveNetworkPin: async (networkId: string) => ({ networkId, rpcUrl: 'http://node' }),
}));

import { WalletProvider, useWallet } from 'src/contexts/WalletContext';

let listeners: Array<(changes: Record<string, unknown>, area: string) => void> = [];
let clock = 1_000_000;
let ctx: ReturnType<typeof useWallet>;
let renders: Array<{ addr: string | undefined; pub: string | null; total: string | null }> = [];
const pubCalls: Array<Deferred<unknown>> = [];
const encCalls: Array<Deferred<unknown>> = [];

function Probe(): null {
  ctx = useWallet();
  renders.push({ addr: ctx.activeWallet?.address, pub: ctx.balance, total: ctx.totalBalance });
  return null;
}

const flush = () =>
  act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });

const enc = (pub: number, priv: number) => ({
  success: true,
  public: pub,
  publicRaw: pub * 1e6,
  encrypted: priv,
  encryptedRaw: priv * 1e6,
  total: pub + priv,
});

beforeEach(() => {
  listeners = [];
  renders = [];
  clock = 1_000_000;
  h.activeId = 'w1';
  h.netGate = null;
  pubCalls.length = 0;
  encCalls.length = 0;
  let perf = 0;
  vi.spyOn(Date, 'now').mockImplementation(() => clock);
  vi.spyOn(performance, 'now').mockImplementation(() => ++perf);
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn((_keys: unknown, cb?: (r: unknown) => void) => {
    if (cb) {
      cb({});
      return undefined;
    }
    return Promise.resolve({});
  });
  c.storage.local.set = vi.fn(async () => {});
  c.storage.local.remove = vi.fn(async () => {});
  c.storage.session.get = vi.fn(async () => ({ wallet_unlocked: true }));
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

describe('shown balances are tagged with their wallet and network', () => {
  it('never shows the previous wallet balance under the new one', async () => {
    const view = render(
      <WalletProvider>
        <Probe />
      </WalletProvider>
    );
    await flush();
    expect(ctx.balance).toBeNull();
    await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[0].resolve(enc(10, 5)));
    await flush();
    expect(ctx.totalBalance).toBe('15');

    renders = [];
    h.activeId = 'w2';
    const gate = deferred<void>();
    h.netGate = gate.promise;
    await act(async () => {
      for (const l of listeners) l({ activeWalletId: { newValue: 'w2' } }, 'local');
    });
    await flush();
    await act(async () => {
      h.netGate = null;
      gate.resolve();
    });
    await flush();

    const underB = renders.filter((r) => r.addr === h.wallets[1].address);
    expect(underB.length).toBeGreaterThan(0);
    for (const r of underB) {
      expect(r.pub).toBeNull();
      expect(r.total).toBeNull();
    }
    view.unmount();
  });

  it('drops the decrypted private balance on a lock from elsewhere', async () => {
    const view = render(
      <WalletProvider>
        <Probe />
      </WalletProvider>
    );
    await flush();
    await act(async () => pubCalls[0].resolve({ success: true, balance: 10 }));
    await act(async () => encCalls[0].resolve(enc(10, 5)));
    await flush();
    expect(ctx.privateBalance).toBe('5');

    await act(async () => {
      for (const l of listeners) l({ wallet_unlocked: { newValue: undefined } }, 'session');
    });
    await flush();
    expect(ctx.privateBalance).toBeNull();
    expect(ctx.totalBalance).toBeNull();
    view.unmount();
  });
});
