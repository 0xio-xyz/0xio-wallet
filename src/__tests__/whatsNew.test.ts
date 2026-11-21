import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Wallet } from 'src/types/wallet';
import {
  WHATS_NEW_PENDING_KEY,
  WHATS_NEW_SEEN_KEY,
  WHATS_NEW_VERSION,
  compareVersions,
  evmCandidates,
  isWhatsNewDue,
  markWhatsNewSeen,
  noteWhatsNewOnInstalled,
  turnOnEvmForAll,
} from 'src/services/wallet/whatsNew';

const PHRASE = Array.from({ length: 12 }, () => 'abandon');

const wallet = (id: string, over: Partial<Wallet> = {}): Wallet => ({
  id,
  name: id,
  address: `oct${id}`,
  type: 'standard',
  privateKey: 'key',
  mnemonic: PHRASE,
  publicKey: 'pub',
  isActive: false,
  metadata: {} as Wallet['metadata'],
  ...over,
});

const local = chrome.storage.local as unknown as {
  set: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  local.set.mockClear();
  local.remove.mockClear();
});

describe('compareVersions', () => {
  it('orders numerically, not as text', () => {
    expect(compareVersions('2.5.7', '3.0.0')).toBe(-1);
    expect(compareVersions('2.10.0', '2.9.9')).toBe(1);
    expect(compareVersions('3.0', '3.0.0')).toBe(0);
    expect(compareVersions('3.0.1', '3.0.0')).toBe(1);
    expect(compareVersions('3.0.0-beta.1', '3.0.0')).toBe(0);
  });
});

describe('onInstalled', () => {
  it('queues the notice on an update from 2.5.7', async () => {
    expect(await noteWhatsNewOnInstalled({ reason: 'update', previousVersion: '2.5.7' })).toBe(
      true
    );
    expect(local.set).toHaveBeenCalledWith({ [WHATS_NEW_PENDING_KEY]: WHATS_NEW_VERSION });
  });

  it('does nothing on a fresh install', async () => {
    expect(await noteWhatsNewOnInstalled({ reason: 'install' })).toBe(false);
    expect(local.set).not.toHaveBeenCalled();
  });

  it('does nothing on an update from 3.0.0 to 3.0.1', async () => {
    expect(await noteWhatsNewOnInstalled({ reason: 'update', previousVersion: '3.0.0' })).toBe(
      false
    );
    expect(local.set).not.toHaveBeenCalled();
  });

  it('does nothing on a browser update', async () => {
    expect(
      await noteWhatsNewOnInstalled({ reason: 'chrome_update', previousVersion: '2.5.7' })
    ).toBe(false);
    expect(local.set).not.toHaveBeenCalled();
  });
});

describe('show and seen', () => {
  it('shows only while pending for this version and not seen', () => {
    expect(isWhatsNewDue('3.0.0', undefined)).toBe(true);
    expect(isWhatsNewDue('3.0.0', '3.0.0')).toBe(false);
    expect(isWhatsNewDue(undefined, undefined)).toBe(false);
    expect(isWhatsNewDue('2.0.0', undefined)).toBe(false);
  });

  it('marking seen stores the version and clears pending', async () => {
    await markWhatsNewSeen();
    expect(local.set).toHaveBeenCalledWith({ [WHATS_NEW_SEEN_KEY]: WHATS_NEW_VERSION });
    expect(local.remove).toHaveBeenCalledWith(WHATS_NEW_PENDING_KEY);
  });
});

describe('Turn on EVM', () => {
  const phrase = wallet('phrase');
  const derived = wallet('derived', {
    mnemonic: null,
    metadata: {
      source: 'derived',
      evm: { enabled: false, address: '', index: 1, sourceWalletId: 'phrase' },
    } as unknown as Wallet['metadata'],
  });
  const keyOnly = wallet('key', { mnemonic: null });
  const watch = wallet('watch', { type: 'watch', privateKey: null, mnemonic: null });
  const alreadyOn = wallet('on', {
    metadata: {
      evm: { enabled: true, address: '0xabc', index: 0 },
    } as unknown as Wallet['metadata'],
  });
  const all = [phrase, derived, keyOnly, watch, alreadyOn];

  it('picks only phrase wallets and phrase accounts that are still off', () => {
    expect(evmCandidates(all).map((w) => w.id)).toEqual(['phrase', 'derived']);
  });

  it('enables eligible wallets one at a time', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const enable = vi.fn<(id: string) => Promise<void>>(async () => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await Promise.resolve();
      inFlight--;
    });
    const result = await turnOnEvmForAll(all, enable);
    expect(enable.mock.calls.map((c) => c[0])).toEqual(['phrase', 'derived']);
    expect(maxInFlight).toBe(1);
    expect(result).toEqual({ enabled: ['phrase', 'derived'], failed: [] });
  });

  it('keeps the ones that succeeded when one fails', async () => {
    const enable = vi.fn(async (id: string) => {
      if (id === 'phrase') throw new Error('boom');
    });
    expect(await turnOnEvmForAll(all, enable)).toEqual({
      enabled: ['derived'],
      failed: ['phrase'],
    });
  });
});
