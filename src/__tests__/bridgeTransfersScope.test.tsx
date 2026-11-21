import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BridgeTransfer } from 'src/services/bridge/transfers';

const h = vi.hoisted(() => ({
  stored: {} as Record<string, BridgeTransfer[]>,
  recoverTransfers: vi.fn(),
}));

vi.mock('src/services/bridge/transfers', () => ({
  ACTIVE: new Set<string>(),
  advance: vi.fn(async () => null),
  loadTransfers: vi.fn(async (oct: string) => h.stored[oct] ?? []),
  saveTransfers: vi.fn(async (oct: string, list: BridgeTransfer[]) => {
    h.stored[oct] = list;
  }),
}));

vi.mock('src/services/bridge/recover', () => ({
  recoverTransfers: h.recoverTransfers,
  transferFromHash: vi.fn(),
}));

import { useBridgeTransfers } from 'src/hooks/wallet/useBridgeTransfers';

const transfer = (id: string, octAddress: string, createdAt = 1): BridgeTransfer => ({
  id,
  direction: 'o2e',
  amountRaw: '1',
  octAddress,
  evmAddress: '0xE',
  recipient: '0xE',
  createdAt,
  updatedAt: createdAt,
  status: 'done' as BridgeTransfer['status'],
});

const ids = (list: BridgeTransfer[]) => list.map((t) => t.id);

describe('useBridgeTransfers scope', () => {
  beforeEach(() => {
    h.stored = {};
    h.recoverTransfers.mockReset();
  });

  it('saves a late recover result under the wallet it ran for, never the one now shown', async () => {
    h.stored.octA = [transfer('a0', 'octA', 1)];
    h.stored.octB = [transfer('b0', 'octB', 1)];
    let finishA: (found: BridgeTransfer[]) => void = () => {};
    h.recoverTransfers.mockImplementation(({ octAddress }: { octAddress: string }) =>
      octAddress === 'octA'
        ? new Promise<BridgeTransfer[]>((resolve) => {
            finishA = resolve;
          })
        : Promise.resolve([])
    );

    const { result, rerender } = renderHook(({ oct }) => useBridgeTransfers(oct, '0xE'), {
      initialProps: { oct: 'octA' },
    });
    await waitFor(() => expect(ids(result.current.transfers)).toEqual(['a0']));
    await waitFor(() => expect(h.recoverTransfers).toHaveBeenCalledTimes(1));

    rerender({ oct: 'octB' });
    expect(result.current.transfers).toEqual([]);
    await waitFor(() => expect(ids(result.current.transfers)).toEqual(['b0']));

    await act(async () => {
      finishA([transfer('a1', 'octA', 2)]);
    });
    await waitFor(() => expect(ids(h.stored.octA)).toEqual(['a1', 'a0']));
    expect(ids(result.current.transfers)).toEqual(['b0']);
    expect(ids(h.stored.octB ?? [])).toEqual(['b0']);
  });

  it('clears the list on a wallet switch before the next one loads', async () => {
    h.stored.octA = [transfer('a0', 'octA')];
    h.recoverTransfers.mockResolvedValue([]);
    const { result, rerender } = renderHook(({ oct }) => useBridgeTransfers(oct, '0xE'), {
      initialProps: { oct: 'octA' as string | null },
    });
    await waitFor(() => expect(ids(result.current.transfers)).toEqual(['a0']));
    rerender({ oct: 'octC' });
    expect(result.current.transfers).toEqual([]);
    rerender({ oct: null });
    expect(result.current.transfers).toEqual([]);
  });

  it('keeps a transfer added before the stored list loads', async () => {
    h.stored.octA = [transfer('a0', 'octA')];
    h.recoverTransfers.mockResolvedValue([]);
    const { result } = renderHook(() => useBridgeTransfers('octA', '0xE'));
    act(() => result.current.add(transfer('new', 'octA', 5)));
    await waitFor(() => expect(ids(result.current.transfers)).toEqual(['new', 'a0']));
    await waitFor(() => expect(ids(h.stored.octA)).toEqual(['new', 'a0']));
  });
});
