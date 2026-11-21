import { beforeEach, describe, expect, it, vi } from 'vitest';

type Area = 'local' | 'session';
type Listener = (changes: Record<string, chrome.storage.StorageChange>, area: Area) => void;

let stores: Record<Area, Record<string, unknown>>;
let listeners: Listener[];
const setIcon = vi.fn<(details: chrome.action.TabIconDetails) => Promise<void>>(async () => {});

function emit(area: Area, changes: Record<string, chrome.storage.StorageChange>) {
  if (Object.keys(changes).length) listeners.forEach((l) => l(changes, area));
}

function fakeArea(area: Area) {
  return {
    get: vi.fn(async (keys: string | string[]) => {
      const list = typeof keys === 'string' ? [keys] : keys;
      return Object.fromEntries(
        list.filter((k) => k in stores[area]).map((k) => [k, stores[area][k]])
      );
    }),
    set: vi.fn(async (items: Record<string, unknown>) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const [k, v] of Object.entries(items)) {
        changes[k] = { oldValue: stores[area][k], newValue: v };
        stores[area][k] = v;
      }
      emit(area, changes);
    }),
    remove: vi.fn(async (keys: string | string[]) => {
      const changes: Record<string, chrome.storage.StorageChange> = {};
      for (const k of typeof keys === 'string' ? [keys] : keys) {
        if (!(k in stores[area])) continue;
        changes[k] = { oldValue: stores[area][k] };
        delete stores[area][k];
      }
      emit(area, changes);
    }),
    clear: vi.fn(async () => {
      const changes = Object.fromEntries(
        Object.entries(stores[area]).map(([k, v]) => [k, { oldValue: v }])
      );
      stores[area] = {};
      emit(area, changes);
    }),
  };
}

async function loadModule() {
  vi.resetModules();
  vi.stubGlobal('chrome', {
    storage: {
      local: fakeArea('local'),
      session: fakeArea('session'),
      onChanged: { addListener: (l: Listener) => listeners.push(l) },
    },
    action: { setIcon },
  });
  return import('../lockIcon');
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const lastPath = () => setIcon.mock.calls[setIcon.mock.calls.length - 1]?.[0].path;

describe('toolbar lock icon', () => {
  beforeEach(() => {
    stores = { local: {}, session: {} };
    listeners = [];
    setIcon.mockClear();
  });

  it('uses the full 16/32/48/128 sets', async () => {
    const { LOCKED_ICON, NORMAL_ICON } = await loadModule();
    expect(NORMAL_ICON).toEqual({
      16: '/icon16.png',
      32: '/icon32.png',
      48: '/icon48.png',
      128: '/icon128.png',
    });
    expect(LOCKED_ICON).toEqual({
      16: '/icon-locked-16.png',
      32: '/icon-locked-32.png',
      48: '/icon-locked-48.png',
      128: '/icon-locked-128.png',
    });
  });

  it('shows the normal icon on startup when unlocked', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h' };
    stores.session = { wallet_unlocked: true };
    const { initLockIcon, NORMAL_ICON } = await loadModule();
    initLockIcon();
    await settle();
    expect(setIcon).toHaveBeenCalledTimes(1);
    expect(lastPath()).toEqual(NORMAL_ICON);
  });

  it('shows the locked icon on startup when locked', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h' };
    const { initLockIcon, LOCKED_ICON } = await loadModule();
    initLockIcon();
    await settle();
    expect(lastPath()).toEqual(LOCKED_ICON);
  });

  it('shows the normal icon when no wallet exists', async () => {
    const { initLockIcon, NORMAL_ICON } = await loadModule();
    initLockIcon();
    await settle();
    expect(lastPath()).toEqual(NORMAL_ICON);
  });

  it('switches to the locked icon on a manual lock', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h', lastActivityTime: 1 };
    stores.session = { wallet_unlocked: true, sessionKey: 'k', sessionVerification: {} };
    const { initLockIcon, LOCKED_ICON } = await loadModule();
    initLockIcon();
    await settle();

    await chrome.storage.session.remove([
      'wallet_unlocked',
      'sessionKey',
      'sessionKeyJWK',
      'sessionVerification',
      'lastActivityTime',
      'lastUnlockTime',
    ]);
    await chrome.storage.local.remove(['lastActivityTime', 'lastUnlockTime']);
    await settle();
    expect(lastPath()).toEqual(LOCKED_ICON);
  });

  it('switches to the locked icon on an auto lock', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h', lastActivityTime: 1 };
    stores.session = { wallet_unlocked: true, sessionKey: 'k', lastActivityTime: 1 };
    const { initLockIcon, LOCKED_ICON } = await loadModule();
    initLockIcon();
    await settle();

    await chrome.storage.session.remove([
      'wallet_unlocked',
      'sessionKey',
      'lastActivityTime',
      'lastUnlockTime',
    ]);
    await settle();
    expect(lastPath()).toEqual(LOCKED_ICON);
  });

  it('switches back to the normal icon on unlock', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h' };
    const { initLockIcon, LOCKED_ICON, NORMAL_ICON } = await loadModule();
    initLockIcon();
    await settle();
    expect(lastPath()).toEqual(LOCKED_ICON);

    await chrome.storage.session.set({ wallet_unlocked: true, sessionKey: 'k' });
    await settle();
    expect(lastPath()).toEqual(NORMAL_ICON);
  });

  it('shows the normal icon after a wallet reset', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h' };
    const { initLockIcon, LOCKED_ICON, NORMAL_ICON } = await loadModule();
    initLockIcon();
    await settle();
    expect(lastPath()).toEqual(LOCKED_ICON);

    await (chrome.storage.local as unknown as { clear: () => Promise<void> }).clear();
    await settle();
    expect(lastPath()).toEqual(NORMAL_ICON);
  });

  it('keeps the normal icon while onboarding writes the first wallet unlocked', async () => {
    const { initLockIcon, NORMAL_ICON } = await loadModule();
    initLockIcon();
    await settle();

    await chrome.storage.session.set({ wallet_unlocked: true });
    await chrome.storage.local.set({ vault: { empty: false }, hashedPassword: 'h' });
    await settle();
    expect(setIcon.mock.calls.every(([d]) => d.path === NORMAL_ICON)).toBe(true);
  });

  it('ignores unrelated storage changes', async () => {
    stores.local = { vault: { empty: false }, hashedPassword: 'h' };
    stores.session = { wallet_unlocked: true };
    const { initLockIcon } = await loadModule();
    initLockIcon();
    await settle();
    setIcon.mockClear();

    await chrome.storage.local.set({ settings: { auto_refresh: true } });
    await chrome.storage.session.set({ lastActivityTime: 2 });
    await settle();
    expect(setIcon).not.toHaveBeenCalled();
  });

  it('treats a no-password wallet as unlocked', async () => {
    stores.local = { vault: { empty: false }, passwordSkipped: true };
    const { initLockIcon, NORMAL_ICON } = await loadModule();
    initLockIcon();
    await settle();
    expect(lastPath()).toEqual(NORMAL_ICON);
  });
});
