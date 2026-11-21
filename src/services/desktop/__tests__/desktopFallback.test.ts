import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  status: 'unverified' as string,
  closed: 0,
  master: vi.fn(),
}));

vi.mock('src/services/desktop/desktopPairing', () => ({
  getClientId: vi.fn(async () => 'fedcba9876543210fedcba9876543210'),
  loadPairing: vi.fn(async () => null),
  savePairing: vi.fn(),
  forgetPairing: vi.fn(async () => {}),
}));
vi.mock('src/services/desktop/desktopLink', () => ({
  CONNECT_TIMEOUT_MS: 10_000,
  DESKTOP_URL: 'ws://127.0.0.1:19345',
  probeDesktop: vi.fn(async () => true),
  openDesktopSocket: vi.fn(async () => ({
    close: () => {
      h.closed++;
    },
  })),
  SocketLink: class {},
  runPairing: vi.fn(),
  connectAndInit: vi.fn(async (_link: unknown, opts: { master: () => Promise<Uint8Array> }) => {
    if (h.status === 'verified') {
      await opts.master();
      return { status: 'verified', init: { ready: true } };
    }
    return { status: h.status, desktopId: '0123456789abcdef0123456789abcdef' };
  }),
}));
vi.mock('src/services/pvac/pvacMasterSeed', () => ({ pvacMasterSeed: h.master }));

import { pvacManager } from 'src/services/pvac/PvacManager';

const KEY = btoa(String.fromCharCode(...new Uint8Array(64).fill(3)));

const pairingFor = (desktopId: string) => ({
  v: 1 as const,
  clientId: 'fedcba9876543210fedcba9876543210',
  desktopId,
  secret: '05'.repeat(32),
  pairedAt: 1,
});

beforeEach(async () => {
  const { forgetPairing } = await import('src/services/desktop/desktopPairing');
  vi.mocked(forgetPairing).mockClear();
  pvacManager.destroy();
  h.closed = 0;
  h.master.mockReset();
  h.master.mockResolvedValue(new Uint8Array(32));
});

describe('a desktop that is not verified', () => {
  it.each(['unverified', 'not_paired', 'outdated'])(
    'leaves proofs local when it is %s, closes the socket and derives no master seed',
    async (status) => {
      h.status = status;
      const changes = vi.fn();
      const off = pvacManager.onDesktopChange(changes);
      expect(await pvacManager.reconnectDesktop(KEY)).toBe(false);
      off();
      expect(pvacManager.hasDesktopApp).toBe(false);
      expect(pvacManager.desktopStatus).toBe(status);
      expect(h.master).not.toHaveBeenCalled();
      expect(h.closed).toBe(1);
      expect(changes).toHaveBeenCalled();
    }
  );

  it('unpairing forgets the pairing and drops the link', async () => {
    h.status = 'verified';
    expect(await pvacManager.reconnectDesktop(KEY)).toBe(true);
    expect(pvacManager.desktopStatus).toBe('verified');
    await pvacManager.unpairDesktop();
    const { forgetPairing } = await import('src/services/desktop/desktopPairing');
    expect(forgetPairing).toHaveBeenCalled();
    expect(pvacManager.hasDesktopApp).toBe(false);
    expect(pvacManager.desktopStatus).toBe('not_paired');
  });

  it('keeps the stored secret on an unproven not_paired answer from the same desktop id', async () => {
    const { forgetPairing, loadPairing } = await import('src/services/desktop/desktopPairing');
    h.status = 'not_paired';
    vi.mocked(loadPairing).mockResolvedValueOnce(pairingFor('0123456789abcdef0123456789abcdef'));
    expect(await pvacManager.reconnectDesktop(KEY)).toBe(false);
    expect(forgetPairing).not.toHaveBeenCalled();
    expect(pvacManager.desktopStatus).toBe('not_paired');
  });

  it('keeps a pairing made with another desktop', async () => {
    const { forgetPairing, loadPairing } = await import('src/services/desktop/desktopPairing');
    h.status = 'not_paired';
    vi.mocked(loadPairing).mockResolvedValueOnce(pairingFor('ffffffffffffffffffffffffffffffff'));
    expect(await pvacManager.reconnectDesktop(KEY)).toBe(false);
    expect(forgetPairing).not.toHaveBeenCalled();
  });

  it('keeps the pairing when an old desktop cannot pair', async () => {
    const { forgetPairing, loadPairing } = await import('src/services/desktop/desktopPairing');
    h.status = 'outdated';
    vi.mocked(loadPairing).mockResolvedValueOnce(pairingFor('0123456789abcdef0123456789abcdef'));
    expect(await pvacManager.reconnectDesktop(KEY)).toBe(false);
    expect(forgetPairing).not.toHaveBeenCalled();
    expect(h.master).not.toHaveBeenCalled();
    expect(pvacManager.desktopStatus).toBe('outdated');
  });
});
