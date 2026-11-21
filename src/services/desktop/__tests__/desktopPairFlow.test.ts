import { beforeEach, describe, expect, it, vi } from 'vitest';

const REAL = '482 913';

const h = vi.hoisted(() => ({ closed: 0 }));

vi.mock('src/services/desktop/desktopPairing', async (actual) => ({
  ...(await actual<typeof import('src/services/desktop/desktopPairing')>()),
  getClientId: vi.fn(async () => 'fedcba9876543210fedcba9876543210'),
  loadPairing: vi.fn(async () => null),
  savePairing: vi.fn(async () => {}),
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
  connectAndInit: vi.fn(),
  runPairing: vi.fn(
    async (
      _link: unknown,
      clientId: string,
      opts: { onCode: (c: string) => void; picked: Promise<boolean> }
    ) => {
      opts.onCode(REAL);
      const ok = await opts.picked;
      return ok
        ? {
            status: 'paired',
            pairing: {
              v: 1,
              clientId,
              desktopId: 'd'.repeat(32),
              secret: '0'.repeat(64),
              pairedAt: 1,
            },
          }
        : { status: 'wrong' };
    }
  ),
}));

import { pvacManager } from 'src/services/pvac/PvacManager';
import { savePairing } from 'src/services/desktop/desktopPairing';

const until = async (cond: () => boolean) => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 5));
  expect(cond()).toBe(true);
};

beforeEach(() => {
  vi.mocked(savePairing).mockClear();
  pvacManager.closeDesktopPairSheet();
});

describe('pairing from the sheet', () => {
  it('saves nothing while the codes are open, then saves after the right pick', async () => {
    const result = pvacManager.pairDesktop();
    await until(() => pvacManager.desktopPairSheet?.phase === 'choosing');
    const sheet = pvacManager.desktopPairSheet!;
    expect(sheet.codes).toHaveLength(3);
    expect(sheet.codes).toContain(REAL);
    expect(savePairing).not.toHaveBeenCalled();

    const wrong = sheet.codes!.findIndex((c) => c !== REAL);
    pvacManager.pickDesktopPairCode(wrong);
    pvacManager.pickDesktopPairCode(sheet.codes!.indexOf(REAL));
    expect(savePairing).not.toHaveBeenCalled();
    pvacManager.submitDesktopPairPick();
    expect(await result).toBe('paired');
    expect(savePairing).toHaveBeenCalledTimes(1);
    expect(pvacManager.desktopPairSheet?.phase).toBe('paired');
    pvacManager.closeDesktopPairSheet();
    expect(pvacManager.desktopPairSheet?.phase).toBe('paired');
  });

  it('stops on a wrong pick and saves nothing', async () => {
    const result = pvacManager.pairDesktop();
    await until(() => pvacManager.desktopPairSheet?.phase === 'choosing');
    const codes = pvacManager.desktopPairSheet!.codes!;
    pvacManager.pickDesktopPairCode(codes.findIndex((c) => c !== REAL));
    pvacManager.submitDesktopPairPick();
    expect(await result).toBe('wrong');
    expect(savePairing).not.toHaveBeenCalled();
    expect(pvacManager.desktopPairSheet?.phase).toBe('wrong');
    expect(pvacManager.desktopPairingActive).toBe(false);
    pvacManager.closeDesktopPairSheet();
    expect(pvacManager.desktopPairSheet).toBeNull();
  });

  it('keeps the same order for the whole exchange', async () => {
    const result = pvacManager.pairDesktop();
    await until(() => pvacManager.desktopPairSheet?.phase === 'choosing');
    const codes = pvacManager.desktopPairSheet!.codes;
    pvacManager.pickDesktopPairCode(0);
    pvacManager.pickDesktopPairCode(2);
    expect(pvacManager.desktopPairSheet!.codes).toBe(codes);
    pvacManager.pickDesktopPairCode(codes!.findIndex((c) => c !== REAL));
    pvacManager.submitDesktopPairPick();
    await result;
    expect(pvacManager.desktopPairSheet!.codes).toBe(codes);
  });
});
