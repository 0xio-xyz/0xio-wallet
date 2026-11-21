import { act, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  ctx: { activeWallet: null as { address: string } | null, networkId: 'mainnet' },
  local: {} as Record<string, unknown>,
  heldAddress: '',
}));

vi.mock('src/contexts/WalletContext', () => ({ useWallet: () => h.ctx }));
vi.mock('src/shared/ui/KeySwitchOverlay', () => ({
  blockedAckKey: (net: string, addr: string) => `blocked_${net}_${addr}`,
}));
vi.mock('src/services/network/NetworkService', () => ({
  networkService: {
    getPendingTransactions: async (): Promise<unknown[]> => [],
    getTransactionHistory: async (): Promise<unknown[]> => [],
    getTransactionStatuses: async () => new Map(),
  },
  pendingTxInScope: () => false,
}));
vi.mock('src/services/network/txScope', () => ({
  resolveNetworkPin: async (networkId: string) => ({ networkId, rpcUrl: 'http://node' }),
}));
vi.mock('src/services/wallet/backupPending', () => ({
  BACKUP_PENDING_KEY: 'backup_pending',
  isBackupPending: async (address: string) => address === h.heldAddress,
  readPendingFromChange: () => false,
}));
vi.mock('src/services/privacy/setupPrivateReads', () => ({
  readMigrationStatus: async (_net: string, address: string) =>
    address === h.heldAddress
      ? { cipher_class: 'v5', can_key_switch: false, reason: 'held' }
      : null,
}));

import { usePvacBlocked } from 'src/hooks/privacy/usePvacBlocked';
import { useTransactionHistory } from 'src/hooks/wallet/useTransactionHistory';
import { usePrivateStatus } from 'src/hooks/privacy/usePrivateStatus';
import { useTokenVisibility } from 'src/hooks/wallet/useTokenPrefs';
import useBackupPending from 'src/hooks/wallet/useBackupPending';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

const flush = () =>
  act(async () => {
    for (let i = 0; i < 20; i++) await Promise.resolve();
  });

beforeEach(() => {
  h.local = {};
  h.ctx = { activeWallet: { address: A }, networkId: 'mainnet' };
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn(async (keys: unknown) => {
    const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
    return Object.fromEntries(list.filter((k) => k in h.local).map((k) => [k, h.local[k]]));
  });
  c.storage.local.set = vi.fn(async () => {});
  c.storage.local.remove = vi.fn(async () => {});
  c.storage.onChanged = { addListener: () => {}, removeListener: () => {} };
});

describe('usePvacBlocked across a wallet switch', () => {
  it('never shows the previous wallet verdict and lands on the new one last known answer', async () => {
    h.local[`blocked_mainnet_${A}`] = 'ack';
    const seen: Array<{ addr: string; blocked: boolean }> = [];
    const Probe = (): null => {
      seen.push({ addr: h.ctx.activeWallet!.address, blocked: usePvacBlocked() });
      return null;
    };
    const view = render(<Probe />);
    await flush();
    expect(seen[seen.length - 1]).toEqual({ addr: A, blocked: true });

    seen.length = 0;
    h.ctx = { activeWallet: { address: B }, networkId: 'mainnet' };
    view.rerender(<Probe />);
    await flush();
    expect(seen.filter((s) => s.addr === B).every((s) => !s.blocked)).toBe(true);

    seen.length = 0;
    h.ctx = { activeWallet: { address: A }, networkId: 'mainnet' };
    view.rerender(<Probe />);
    expect(seen[0]).toEqual({ addr: A, blocked: true });
    view.unmount();
  });
});

describe('useTransactionHistory across a wallet switch', () => {
  it('reads loading, not empty, before the new wallet list is read', async () => {
    const seen: Array<{ addr: string; loading: boolean; rows: number }> = [];
    const Probe = ({ address }: { address: string }): null => {
      const r = useTransactionHistory(address);
      seen.push({ addr: address, loading: r.isLoading, rows: r.transactions.length });
      return null;
    };
    const view = render(<Probe address={A} />);
    await flush();
    expect(seen[seen.length - 1]).toMatchObject({ addr: A, loading: false });

    seen.length = 0;
    view.rerender(<Probe address={B} />);
    expect(seen[0]).toMatchObject({ addr: B, loading: true, rows: 0 });
    await flush();
    expect(seen[seen.length - 1]).toMatchObject({ addr: B, loading: false });
    view.unmount();
  });
});

describe('usePrivateStatus across a wallet switch', () => {
  it('lands on the new wallet last known status, never the previous wallet status', async () => {
    h.heldAddress = A;
    const seen: Array<{ addr: string; kind: string | null }> = [];
    const Probe = (): null => {
      seen.push({ addr: h.ctx.activeWallet!.address, kind: usePrivateStatus()?.kind ?? null });
      return null;
    };
    const view = render(<Probe />);
    await flush();
    expect(seen[seen.length - 1]).toEqual({ addr: A, kind: 'held' });

    seen.length = 0;
    h.ctx = { activeWallet: { address: B }, networkId: 'mainnet' };
    view.rerender(<Probe />);
    await flush();
    expect(seen.filter((s) => s.addr === B).every((s) => s.kind === null)).toBe(true);

    seen.length = 0;
    h.ctx = { activeWallet: { address: A }, networkId: 'mainnet' };
    view.rerender(<Probe />);
    expect(seen[0]).toEqual({ addr: A, kind: 'held' });
    view.unmount();
  });
});

describe('useTokenVisibility on a scope this window already read', () => {
  it('is ready in its first render', async () => {
    const key = `vis_test_${A}`;
    const seen: boolean[] = [];
    const Probe = (): null => {
      seen.push(useTokenVisibility([key]).ready);
      return null;
    };
    const first = render(<Probe />);
    expect(seen[0]).toBe(false);
    await flush();
    expect(seen[seen.length - 1]).toBe(true);
    first.unmount();

    seen.length = 0;
    const again = render(<Probe />);
    expect(seen[0]).toBe(true);
    again.unmount();
  });
});

describe('useBackupPending when Home mounts again', () => {
  it('shows the known flag in its first render', async () => {
    h.heldAddress = B;
    const seen: boolean[] = [];
    const Probe = (): null => {
      seen.push(useBackupPending({ address: B, type: 'standard' }));
      return null;
    };
    const first = render(<Probe />);
    await flush();
    expect(seen[seen.length - 1]).toBe(true);
    first.unmount();

    seen.length = 0;
    const again = render(<Probe />);
    expect(seen[0]).toBe(true);
    again.unmount();
  });
});
