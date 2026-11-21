import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ZeroXIOConfig } from 'src/utils/config';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const state = vi.hoisted(() => ({ locked: false }));

vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () =>
    state.locked ? null : { id: 'id-a', address: A, publicKey: 'pkA', name: 'A', balance: '1' }
  ),
  waitForWalletUnlock: vi.fn(async () => null),
}));
vi.mock('../background/services/approvals', () => ({
  approvalQueue: { add: vi.fn() },
  txApprovalQueue: { add: vi.fn() },
  msgApprovalQueue: { add: vi.fn() },
  hasPendingApproval: vi.fn(() => false),
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => (state.locked ? null : 'session-key')) },
}));
vi.mock('../services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => []),
    loadAllWallets: vi.fn(async () => [{ id: 'id-a', address: A, publicKey: 'pkA', name: 'A' }]),
    setActiveWallet: vi.fn(async () => null),
  },
}));
vi.mock('../services/network/NetworkService', () => ({
  networkService: { contractCallView: vi.fn(async () => 'ok') },
  privacyNetworkService: {},
}));
vi.mock('../services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('../background/services/txQueue', () => ({ txQueue: {} }));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));

import { waitForWalletUnlock } from '../background/services/wallet';
import {
  hasPendingApproval,
  txApprovalQueue,
  msgApprovalQueue,
} from '../background/services/approvals';
import { dappConnections, persistDAppConnection } from '../background/services/dappConnections';
import { networkService } from '../services/network/NetworkService';
import { handleDAppRequest } from '../background/handlers/dappRequest';

const local = new Map<string, unknown>();

beforeEach(() => {
  local.clear();
  dappConnections.clear();
  state.locked = false;
  local.set(ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET, A);
  local.set(ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK, 'devnet');
  (chrome.runtime as any).getManifest = () => ({ version: '3.0.6' });
  (chrome.storage as any).local = {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(local);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
    },
    remove: async () => {},
  };
  (chrome as any).action = { openPopup: vi.fn(async () => {}) };
  (chrome as any).windows = { create: vi.fn(async () => ({})) };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok: false, json: async () => ({}) }))
  );
  vi.mocked(waitForWalletUnlock).mockClear();
});

const ask = (method: string, params: unknown = {}) =>
  new Promise<any>((resolve) =>
    handleDAppRequest(
      { method, params },
      {
        origin: 'https://stranger.app',
        tab: { id: 3 },
        frameId: 0,
      } as chrome.runtime.MessageSender,
      resolve
    )
  );

const METHODS: [string, unknown][] = [
  ['getConnectionStatus', {}],
  ['ping', {}],
  ['getWalletInfo', {}],
  ['get_balance', {}],
  ['getBalance', {}],
  ['getPublicKey', {}],
  ['getAddress', {}],
  ['signMessage', { message: 'hi' }],
  ['send_transaction', { to: A, amount: '1' }],
  ['call_contract', { contract: A, method: 'm', amount: '0' }],
  ['get_private_balance_info', {}],
  ['register_private_view_key', { address: A }],
  ['switch_network', { networkId: 'mainnet' }],
];

describe('a site that is not connected while 0xio is locked', () => {
  it('gets the same answers as while unlocked, and no unlock prompt', async () => {
    const unlocked: Record<string, unknown> = {};
    for (const [m, p] of METHODS) unlocked[m] = await ask(m, p);
    state.locked = true;
    for (const [m, p] of METHODS) expect(await ask(m, p), m).toEqual(unlocked[m]);
    expect(chrome.action.openPopup).not.toHaveBeenCalled();
    expect(chrome.windows.create).not.toHaveBeenCalled();
    expect(waitForWalletUnlock).not.toHaveBeenCalled();
  });

  it('is refused NOT_CONNECTED for anything but public reads, and learns no address', async () => {
    for (const m of ['getWalletInfo', 'get_balance', 'signMessage', 'send_transaction']) {
      const res = await ask(m, {});
      expect(res, m).toMatchObject({ success: false, error: { code: 'NOT_CONNECTED' } });
      expect(JSON.stringify(res)).not.toContain(A);
    }
    const status = await ask('getConnectionStatus');
    expect(status.data).toMatchObject({ connected: false });
    for (const key of ['address', 'publicKey', 'balance', 'canSign']) {
      expect(status.data).not.toHaveProperty(key);
    }
    expect(status.data).not.toHaveProperty('locked');
  });

  it('is refused NOT_CONNECTED at once even while another review of the site is open', async () => {
    vi.mocked(hasPendingApproval).mockReturnValue(true);
    try {
      for (const locked of [false, true]) {
        state.locked = locked;
        for (const [m, p] of [
          ['switch_network', { networkId: 'mainnet' }],
          ['send_transaction', { to: A, amount: '1' }],
          ['send_private_transfer', { to: A, amount_raw: '1' }],
        ] as const) {
          const res = await new Promise<any>((resolve) =>
            handleDAppRequest(
              { method: m, params: p, v: 2, rid: 'e'.repeat(32) },
              {
                origin: 'https://other-stranger.app',
                tab: { id: 3 },
                frameId: 0,
              } as chrome.runtime.MessageSender,
              resolve
            )
          );
          expect(res, m).toMatchObject({ success: false, error: { code: 'NOT_CONNECTED' } });
        }
      }
      expect(txApprovalQueue.add).not.toHaveBeenCalled();
      expect(msgApprovalQueue.add).not.toHaveBeenCalled();
      expect(chrome.action.openPopup).not.toHaveBeenCalled();
    } finally {
      vi.mocked(hasPendingApproval).mockReturnValue(false);
    }
  });

  it('runs a contract view as the caller the site names, never as the open wallet', async () => {
    const view = (origin: string, params: Record<string, unknown>) =>
      new Promise<any>((resolve) =>
        handleDAppRequest(
          { method: 'contract_call_view', params: { contract: A, method: 'whoami', ...params } },
          { origin, tab: { id: 4 }, frameId: 0 } as chrome.runtime.MessageSender,
          resolve
        )
      );
    const calls = vi.mocked((networkService as any).contractCallView);
    calls.mockClear();
    await view('https://viewer.app', {});
    expect(calls.mock.calls[0][3]).toBe('');
    await view('https://viewer.app', { caller: 'octCaller' });
    expect(calls.mock.calls[1][3]).toBe('octCaller');
    await persistDAppConnection('https://viewer.app', {
      origin: 'https://viewer.app',
      address: A,
      connected: true,
      connectedAt: Date.now(),
      permissions: [],
    });
    await view('https://viewer.app', {});
    expect(calls.mock.calls[2][3]).toBe(A);
  });
});
