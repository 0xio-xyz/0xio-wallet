import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import useWhatsNew from 'src/hooks/wallet/useWhatsNew';
import { WHATS_NEW_PENDING_KEY, WHATS_NEW_SEEN_KEY } from 'src/services/wallet/whatsNew';

const local = chrome.storage.local as unknown as {
  get: ReturnType<typeof vi.fn>;
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

const stored = (values: Record<string, unknown>) =>
  local.get.mockImplementation(async () => values);

beforeEach(() => {
  local.get.mockReset();
  local.set.mockClear();
  local.remove.mockClear();
});

describe('useWhatsNew', () => {
  it('shows when the 3.0.0 notice is pending and unseen', async () => {
    stored({ [WHATS_NEW_PENDING_KEY]: '3.0.0' });
    const { result } = renderHook(() => useWhatsNew(true));
    await waitFor(() => expect(result.current.show).toBe(true));
  });

  it('stays hidden once seen', async () => {
    stored({ [WHATS_NEW_PENDING_KEY]: '3.0.0', [WHATS_NEW_SEEN_KEY]: '3.0.0' });
    const { result } = renderHook(() => useWhatsNew(true));
    await waitFor(() => expect(local.get).toHaveBeenCalled());
    expect(result.current.show).toBe(false);
  });

  it('does not read or show while locked or without wallets', async () => {
    stored({ [WHATS_NEW_PENDING_KEY]: '3.0.0' });
    const { result } = renderHook(() => useWhatsNew(false));
    await Promise.resolve();
    expect(local.get).not.toHaveBeenCalled();
    expect(result.current.show).toBe(false);
  });

  it('dismiss hides it and marks it seen', async () => {
    stored({ [WHATS_NEW_PENDING_KEY]: '3.0.0' });
    const { result } = renderHook(() => useWhatsNew(true));
    await waitFor(() => expect(result.current.show).toBe(true));
    act(() => result.current.dismiss());
    expect(result.current.show).toBe(false);
    await waitFor(() => expect(local.set).toHaveBeenCalledWith({ [WHATS_NEW_SEEN_KEY]: '3.0.0' }));
    await waitFor(() => expect(local.remove).toHaveBeenCalledWith(WHATS_NEW_PENDING_KEY));
  });
});
