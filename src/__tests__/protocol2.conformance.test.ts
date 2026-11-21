import { vi } from 'vitest';

const fake = vi.hoisted(() => {
  const address = 'oct' + 'W'.repeat(44);
  const wallet = { id: 'w1', address, publicKey: 'pkW', name: 'Main', balance: '10' };
  return {
    address,
    wallet,
    locked: false,
    signatures: 0,
    nonce: 1,
    chain: new Map<string, Record<string, unknown>>(),
    account: { registered: false, balanceRaw: '1000000000000', foreignKey: false } as {
      registered: boolean;
      balanceRaw: string;
      foreignKey?: boolean;
    },
    keySwitches: new Set<string>(),
    unlockWaiters: [] as ((w: unknown) => void)[],
  };
});

vi.mock('../background/services/wallet', () => ({
  getActiveWallet: vi.fn(async () => (fake.locked ? null : { ...fake.wallet })),
  waitForWalletUnlock: vi.fn(
    (ms: number) =>
      new Promise((resolve) => {
        if (!fake.locked) return resolve({ ...fake.wallet });
        const timer = setTimeout(() => resolve(null), ms);
        fake.unlockWaiters.push((w) => {
          clearTimeout(timer);
          resolve(w);
        });
      })
  ),
}));
vi.mock('../services/crypto/PasswordManager', () => ({
  passwordManager: {
    getSessionKey: vi.fn(async () => (fake.locked ? null : 'session-key')),
    lockWallet: vi.fn(async () => {}),
  },
}));
vi.mock('../services/wallet/WalletStorage', () => {
  const vault = () => [{ ...fake.wallet, privateKey: 'skW', type: 'standard' }];
  return {
    walletStorage: {
      loadVault: vi.fn(async () => vault()),
      loadAllWallets: vi.fn(async () => vault()),
      setActiveWallet: vi.fn(async () => null),
    },
  };
});
vi.mock('../services/network/NetworkService', () => {
  const signed = (tx: Record<string, unknown>) => {
    fake.signatures++;
    return { ...tx, timestamp: Date.now() / 1000, signature: 'c2lnbmF0dXJl', public_key: 'pkW' };
  };
  return {
    networkService: {
      signMessage: vi.fn(async () => {
        fake.signatures++;
        return 'signature';
      }),
      buildAndSignTransaction: vi.fn(async (p: any) =>
        signed({
          from: p.from,
          to_: p.to,
          amount: String(p.amount),
          nonce: p.nonce,
          ou: String(p.ou),
          op_type: 'standard',
          ...(p.message ? { message: p.message } : {}),
        })
      ),
      buildContractCallTransaction: vi.fn(async (p: any) =>
        signed({
          from: p.from,
          to_: p.contract,
          amount: String(p.amount),
          nonce: p.nonce,
          ou: String(p.ou),
          op_type: 'call',
          encrypted_data: p.method,
          message: p.rawMessage,
        })
      ),
      getNextNonce: vi.fn(async () => fake.nonce++),
      getRecommendedFeeStrict: vi.fn(async () => ({ minimum: '1000', recommended: '10000' })),
      jsonRpcCall: vi.fn(async (method: string, params: unknown[]) => {
        const hash = String(params?.[0]);
        if (method === 'octra_transaction') return fake.chain.get(hash) ?? { status: 'pending' };
        if (method === 'octra_viewPubkey') {
          return { view_pubkey: fake.account.registered ? 'view-pk' : null };
        }
        if (method === 'octra_balance') return { balance_raw: fake.account.balanceRaw };
        if (method === 'contract_receipt') {
          return { contract: 'c', method: 'm', success: true, effort: 1, events: [], error: null };
        }
        throw new Error(`unexpected read ${method}`);
      }),
    },
    privacyNetworkService: {
      getPvacPubkey: vi.fn(async () =>
        fake.account.foreignKey ? 'pvac-other' : fake.account.registered ? 'pvac-pk' : null
      ),
      getKeySwitchFeeQuote: vi.fn(async () => '10000'),
      signKeySwitch: vi.fn(
        async (
          from: string,
          _pk: string,
          _sk: string,
          _pub: string,
          _m: unknown,
          _t: unknown,
          ou: string,
          scope: unknown
        ) => ({
          signedTx: signed({
            from,
            to_: from,
            amount: '0',
            nonce: fake.nonce,
            ou,
            op_type: 'key_switch',
            encrypted_data: '{"new_pubkey":"pvac-pk"}',
          }),
          nonce: fake.nonce++,
          scope,
        })
      ),
    },
  };
});
vi.mock('../services/pvac/PvacManager', () => ({
  pvacManager: {
    ensureOffscreenReady: vi.fn(async () => {}),
    verifyRegistration: vi.fn(async () => true),
    getPublicKeyAsync: vi.fn(async () => 'pvac-pk'),
  },
}));
vi.mock('../background/services/balance', () => ({ refreshAndBroadcastBalance: vi.fn() }));

import { computeTxHash } from '../utils/octra/txHash';
import {
  OCTRA_PER_SECOND,
  RATE_LIMITED_RESPONSE,
  dappRequestMessage,
  rateWindow,
} from '../content/pageRelay';

type Listener = (...a: any[]) => unknown;

interface Page {
  origin: string;
  frame: string;
  tabId: number;
  frameId: number;
  closed: boolean;
  listeners: Set<(e: { type: string; data: unknown }) => void>;
  send(request: any): Promise<any>;
  onEvent(listener: (e: { type: string; data: unknown }) => void): () => void;
  close(): Promise<void>;
}

interface Win {
  id: number;
  url: string;
  rid: string | null;
  open: boolean;
}

const OPEN = new Set(['pending', 'locked', 'review_open', 'signing']);

async function createExtensionAdapter() {
  vi.useFakeTimers({
    shouldAdvanceTime: true,
    toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
  });
  vi.resetModules();
  fake.locked = false;
  fake.account = { registered: false, balanceRaw: '1000000000000', foreignKey: false };
  fake.keySwitches.clear();
  fake.signatures = 0;
  fake.chain.clear();
  fake.unlockWaiters.length = 0;

  const local = new Map<string, unknown>();
  const session = new Map<string, unknown>();
  const changeListeners = new Set<Listener>();
  const messageListeners = new Set<Listener>();
  const windows: Win[] = [];
  const pages: Page[] = [];
  let nextWindow = 1;
  let nextTab = 1;
  let nextFrame = 1;
  let unlockPopup = false;

  const copy = (v: unknown) => {
    try {
      return JSON.parse(JSON.stringify(v));
    } catch {
      return v;
    }
  };
  const area = (store: Map<string, unknown>, name: string) => ({
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries([...store].map(([k, v]) => [k, copy(v)]));
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(
        list.filter((k) => store.has(k)).map((k) => [k, copy(store.get(k))])
      );
    },
    set: async (items: Record<string, unknown>) => {
      const changes: Record<string, { newValue: unknown }> = {};
      for (const [k, v] of Object.entries(items)) {
        store.set(k, copy(v));
        changes[k] = { newValue: copy(v) };
      }
      for (const l of [...changeListeners]) l(changes, name);
    },
    remove: async (keys: string | string[]) => {
      const changes: Record<string, { newValue: undefined }> = {};
      for (const k of Array.isArray(keys) ? keys : [keys]) {
        store.delete(k);
        changes[k] = { newValue: undefined };
      }
      for (const l of [...changeListeners]) l(changes, name);
    },
  });

  const reviewQueue = (url: string) =>
    url.includes('dapp-approval')
      ? approvals.approvalQueue
      : url.includes('approve-transaction')
        ? approvals.txApprovalQueue
        : approvals.msgApprovalQueue;

  vi.stubGlobal('chrome', {
    runtime: {
      id: 'mock-extension-id',
      getURL: (p: string) => `chrome-extension://mock-id/${p}`,
      getManifest: () => ({ version: '3.0.6' }),
      sendMessage: vi.fn(async () => {}),
      onMessage: {
        addListener: (l: Listener) => messageListeners.add(l),
        removeListener: (l: Listener) => messageListeners.delete(l),
      },
    },
    storage: {
      local: area(local, 'local'),
      session: area(session, 'session'),
      onChanged: {
        addListener: (l: Listener) => changeListeners.add(l),
        removeListener: (l: Listener) => changeListeners.delete(l),
      },
    },
    tabs: {
      get: async () => {
        throw new Error('no tab');
      },
      query: (_q: unknown, cb?: (tabs: unknown[]) => void) => {
        cb?.([]);
        return Promise.resolve([]);
      },
      sendMessage: async (tabId: number, msg: any, opts?: { frameId?: number }) => {
        if (msg?.type !== 'WALLET_EVENT') return;
        for (const page of pages) {
          if (page.closed || page.tabId !== tabId || page.origin !== msg.origin) continue;
          if (opts?.frameId !== undefined && opts.frameId !== page.frameId) continue;
          for (const l of [...page.listeners])
            l({ type: msg.eventData?.type, data: msg.eventData?.data });
        }
      },
      onUpdated: { addListener: () => {}, removeListener: () => {} },
      onRemoved: { addListener: () => {} },
    },
    windows: {
      getAll: async (): Promise<unknown[]> => [],
      create: (opts: { url: string }, cb?: (w: unknown) => void) => {
        const id = nextWindow++;
        const key = (reviewQueue(opts.url)?.currentApproval?.review as { key?: string } | undefined)
          ?.key;
        const win: Win = {
          id,
          url: opts.url,
          rid: key ? key.split(' ')[1] : opts.url.includes('approv') ? 'legacy' : null,
          open: true,
        };
        if (win.rid) windows.push(win);
        const shaped = { id, tabs: [{ id: id * 10 }] };
        if (cb) {
          cb(shaped);
          return undefined;
        }
        return Promise.resolve(shaped);
      },
      remove: async (id: number) => {
        const win = windows.find((w) => w.id === id);
        if (win) win.open = false;
      },
      onRemoved: { addListener: () => {}, removeListener: () => {} },
    },
    action: {
      openPopup: async () => {
        unlockPopup = true;
      },
    },
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: { body?: string }) => {
      const body = init?.body ? JSON.parse(init.body) : {};
      if (!String(url).endsWith('/rpc') || body.method !== 'octra_submit') {
        throw new Error('offline');
      }
      let tx_hash: string;
      try {
        tx_hash = computeTxHash(body.params[0]);
      } catch {
        tx_hash = (++fake.nonce).toString(16).padStart(64, '0');
      }
      if (body.params[0]?.op_type === 'key_switch') fake.keySwitches.add(tx_hash);
      const text = JSON.stringify({
        jsonrpc: '2.0',
        id: body.id,
        result: { status: 'accepted', tx_hash },
      });
      return { ok: true, status: 200, text: async () => text, json: async () => JSON.parse(text) };
    })
  );

  const { handleDAppRequest } = await import('../background/handlers/dappRequest');
  const approvals = await import('../background/services/approvals');
  const { requestLifecycle } = await import('../background/services/requestLifecycle');
  const keySwitch = await import('../services/pvac/keySwitchService');

  const records = () =>
    [...session.entries()]
      .filter(([k]) => k.startsWith('rlc_'))
      .map(([, v]) => v as { rid: string; status: string; hash?: string; updatedAt: number });
  const step = (ms: number) => vi.advanceTimersByTimeAsync(ms);
  const waitFor = async (cond: () => boolean, stepMs: number, steps: number) => {
    for (let i = 0; i < steps && !cond(); i++) await step(stepMs);
  };
  const settled = (rid: string) => () =>
    records().every((r) => r.rid !== rid || !OPEN.has(r.status));
  const latestOpen = () => [...windows].reverse().find((w) => w.open) ?? null;
  const windowFor = (rid?: string) =>
    rid ? [...windows].reverse().find((w) => w.open && w.rid === rid) : latestOpen();

  const answer = async (rid: string | undefined, approved: boolean) => {
    await waitFor(() => !!windowFor(rid), 20, 100);
    const win = windowFor(rid);
    if (!win) throw new Error(`no review on screen for ${rid ?? 'any request'}`);
    const approvalId = win.url.split('/').pop();
    const type = win.url.includes('dapp-approval')
      ? 'DAPP_APPROVAL_RESPONSE'
      : win.url.includes('approve-transaction')
        ? 'TRANSACTION_APPROVAL_RESPONSE'
        : 'MESSAGE_APPROVAL_RESPONSE';
    win.open = false;
    for (const l of [...messageListeners]) {
      l({ type, approvalId, approved }, { url: 'chrome-extension://mock-id/index.html' }, () => {});
    }
    if (rid && rid !== 'legacy') await waitFor(settled(rid), 500, 80);
    else await step(50);
  };

  const openPage = async (origin: string, options: { tab?: Page; frame?: string } = {}) => {
    const limit = rateWindow(OCTRA_PER_SECOND);
    const page: Page = {
      origin,
      frame: options.frame ?? 'main',
      tabId: options.tab ? options.tab.tabId : nextTab++,
      frameId: options.frame && options.frame !== 'main' ? nextFrame++ : 0,
      closed: false,
      listeners: new Set(),
      send(request: any) {
        if (page.closed) return Promise.reject(new Error('page closed'));
        if (!limit.take()) return Promise.resolve({ id: request.id, ...RATE_LIMITED_RESPONSE });
        const asked =
          request.method === 'connect'
            ? {
                ...request,
                params: {
                  ...request.params,
                  permissions: [...(request.params?.permissions ?? []), 'private_transfers'],
                },
              }
            : request;
        const message = dappRequestMessage({ requestId: request.id, ...asked });
        const sender = {
          id: 'mock-extension-id',
          origin,
          url: `${origin}/`,
          tab: { id: page.tabId },
          frameId: page.frameId,
        } as unknown as chrome.runtime.MessageSender;
        return new Promise((resolve) =>
          handleDAppRequest(message, sender, (r: any) =>
            resolve({
              id: request.id,
              success: r?.success === true,
              data: r?.data,
              error:
                typeof r?.error === 'string'
                  ? { code: 'UNKNOWN_ERROR', message: r.error }
                  : r?.error,
              ...(r?.rid ? { rid: r.rid } : {}),
              ...(r?.status ? { status: r.status } : {}),
            })
          )
        );
      },
      onEvent(listener) {
        page.listeners.add(listener);
        return () => page.listeners.delete(listener);
      },
      async close() {
        page.closed = true;
        requestLifecycle.pageGone(page.tabId, page.frameId);
        await step(50);
      },
    };
    pages.push(page);
    return page;
  };

  return {
    name: 'extension',
    features: { clock: true, chain: true, lock: true, frames: true, account: true },
    openPage,
    approve: (rid?: string) => answer(rid, true),
    reject: (rid?: string) => answer(rid, false),
    async reviewOnScreen() {
      const win = latestOpen();
      if (win) return win.rid;
      if (!unlockPopup) return null;
      const locked = records()
        .filter((r) => r.status === 'locked' || r.status === 'review_open')
        .sort((a, b) => b.updatedAt - a.updatedAt)[0];
      return locked?.rid ?? null;
    },
    async lock() {
      fake.locked = true;
      await chrome.storage.session.set({ wallet_unlocked: false });
    },
    async unlock() {
      fake.locked = false;
      unlockPopup = false;
      for (const resolve of fake.unlockWaiters.splice(0)) resolve({ ...fake.wallet });
      await chrome.storage.session.set({ wallet_unlocked: true });
      await waitFor(() => records().every((r) => r.status !== 'locked'), 20, 100);
    },
    async setAccount(account: {
      registered: boolean;
      balanceRaw: string;
      foreignKey?: boolean;
      pendingRegistration?: boolean;
    }) {
      fake.account = {
        registered: account.registered,
        balanceRaw: account.balanceRaw,
        foreignKey: !!account.foreignKey,
      };
      if (account.pendingRegistration) {
        await keySwitch.recordPendingKeySwitch(
          { networkId: 'mainnet', address: fake.address },
          'f'.repeat(64)
        );
      }
    },
    async confirmOnChain(hash: string) {
      fake.chain.set(hash, { status: 'confirmed', epoch: 500, op_type: 'call' });
      if (fake.keySwitches.has(hash)) fake.account.registered = true;
      await waitFor(
        () => records().every((r) => r.hash !== hash || r.status !== 'submitted'),
        2500,
        6
      );
    },
    async failOnChain(hash: string, reason: string) {
      fake.chain.set(hash, { status: 'rejected', error: { type: 'execution', reason } });
      await waitFor(
        () => records().every((r) => r.hash !== hash || r.status !== 'submitted'),
        2500,
        6
      );
    },
    async dropOnChain(hash: string) {
      fake.chain.set(hash, { status: 'dropped' });
      await waitFor(
        () => records().every((r) => r.hash !== hash || r.status !== 'submitted'),
        2500,
        6
      );
    },
    advance: async (ms: number): Promise<void> => {
      await step(ms);
    },
    async stats() {
      return { signatures: fake.signatures, reviewsOpened: windows.length };
    },
    async dispose() {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    },
  };
}

// The suite lives in the sibling 0xio-sdk checkout; vitest.conformance.config.ts maps it.
const suite: string = '@0xio/conformance/suite';
const { defineConformanceSuite } = await import(/* @vite-ignore */ suite);

defineConformanceSuite({
  name: 'extension',
  features: { clock: true, chain: true, lock: true, frames: true, account: true },
  create: () => createExtensionAdapter(),
});
