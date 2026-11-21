import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, waitFor, act } from '@testing-library/react';
import useRebackupNeeded from 'src/hooks/wallet/useRebackupNeeded';
import { markRebackupDone } from 'src/services/wallet/rebackup';

const store: Record<string, unknown> = {};

const affected = (address: string) => ({
  address,
  type: 'standard',
  metadata: { source: 'generate', createdAt: Date.UTC(2026, 6, 1) },
});

beforeEach(() => {
  for (const k of Object.keys(store)) delete store[k];
  vi.mocked(chrome.storage.local.get).mockImplementation((async (key: string) =>
    key in store ? { [key]: store[key] } : {}) as never);
  vi.mocked(chrome.storage.local.set).mockImplementation((async (items: object) => {
    Object.assign(store, items);
  }) as never);
});

describe('back up again prompt', () => {
  it('shows while the re-backup is not done', async () => {
    const { result } = renderHook(() => useRebackupNeeded(affected('oct1pending')));
    await waitFor(() => expect(result.current).toBe(true));
  });

  it('stays hidden once the re-backup is stored as done', async () => {
    store.rebackupDone = ['oct1stored'];
    const { result } = renderHook(() => useRebackupNeeded(affected('oct1stored')));
    await act(async () => {});
    expect(result.current).toBe(false);
  });

  it('hides right after the re-backup without a stale flash', async () => {
    const first = renderHook(() => useRebackupNeeded(affected('oct1fresh')));
    await waitFor(() => expect(first.result.current).toBe(true));
    first.unmount();
    await markRebackupDone('oct1fresh');
    const next = renderHook(() => useRebackupNeeded(affected('oct1fresh')));
    expect(next.result.current).toBe(false);
  });

  it('never asks for wallets outside the affected Create flow', async () => {
    const { result } = renderHook(() =>
      useRebackupNeeded({
        address: 'oct1other',
        type: 'standard',
        metadata: { source: 'generated' },
      })
    );
    await act(async () => {});
    expect(result.current).toBe(false);
  });
});
