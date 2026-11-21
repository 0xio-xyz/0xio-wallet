import { beforeEach, describe, expect, it, vi } from 'vitest';
import { x25519 } from '@noble/curves/ed25519.js';
import {
  CLIENT_ID_KEY,
  PAIRING_KEY,
  authProof,
  forgetPairing,
  getClientId,
  loadPairing,
  pairCode,
  pairCodeChoices,
  pairSecret,
  readPairing,
  savePairing,
  sharedSecret,
  toHex,
  transcript,
  uniformBelow,
  verifyProof,
} from 'src/services/desktop/desktopPairing';

const DESKTOP_ID = '0123456789abcdef0123456789abcdef';
const CLIENT_ID = 'fedcba9876543210fedcba9876543210';
const fill = (b: number) => new Uint8Array(32).fill(b);
const pk = (sk: Uint8Array) => x25519.getPublicKey(sk);

describe('pairing crypto', () => {
  it('matches the desktop byte for byte (vectors from ws_auth.rs)', () => {
    const [skE, skD] = [fill(7), fill(9)];
    const [pkE, pkD] = [pk(skE), pk(skD)];
    expect(toHex(pkE)).toBe('13be4feaeaf204c7fd3358fc9c00721881d174278128227ec674f37f7fe97b6d');
    expect(toHex(pkD)).toBe('57db4b359f23ae5e146e4e2512056704722506348c150c14753d0c933d04d421');
    const shared = sharedSecret(skE, toHex(pkD))!;
    expect(toHex(shared)).toBe('2ffe325b2a26611bf1911325d4a62b33749b8f350d0e88ba91e316acaae66554');
    const t = transcript(DESKTOP_ID, CLIENT_ID, pkE, pkD);
    expect(toHex(t)).toBe('b24af20d8c79d4e62222c00ba1806992f32289aef3ef51cea65f4700ade34725');
    expect(pairCode(shared, t)).toBe('821 949');
    const secret = pairSecret(shared, t);
    expect(toHex(secret)).toBe('bfbe67bee02915a813cc18ab4c1f2b8cf6c837b30e3ff86f8165b447c4afd1c7');
    const [ne, nd] = [fill(1), fill(2)];
    expect(toHex(authProof(secret, 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd))).toBe(
      '25a0554cb9d737431d119e312a8895713eb7d15b5fecb99bf4e425e798436937'
    );
    expect(toHex(authProof(secret, 'extension', CLIENT_ID, DESKTOP_ID, ne, nd))).toBe(
      '33499666c02c8e0238fb778a54d6ef377b23af9020e1aeddcd33aa762385a70f'
    );
  });

  it('gives both sides the same code and secret', () => {
    const [skE, skD] = [x25519.utils.randomSecretKey(), x25519.utils.randomSecretKey()];
    const t = transcript(DESKTOP_ID, CLIENT_ID, pk(skE), pk(skD));
    const a = sharedSecret(skE, toHex(pk(skD)))!;
    const b = sharedSecret(skD, toHex(pk(skE)))!;
    expect(pairCode(a, t)).toBe(pairCode(b, t));
    expect(toHex(pairSecret(a, t))).toBe(toHex(pairSecret(b, t)));
  });

  it('shows a different code on each side of a man in the middle', () => {
    const [skE, skD, skM1, skM2] = [fill(7), fill(9), fill(11), fill(13)];
    const t1 = transcript(DESKTOP_ID, CLIENT_ID, pk(skE), pk(skM1));
    const t2 = transcript(DESKTOP_ID, CLIENT_ID, pk(skM2), pk(skD));
    const codeExt = pairCode(sharedSecret(skE, toHex(pk(skM1)))!, t1);
    const codeDesk = pairCode(sharedSecret(skD, toHex(pk(skM2)))!, t2);
    expect(codeExt).not.toBe(codeDesk);
  });

  it('refuses a low-order or malformed public key', () => {
    expect(sharedSecret(fill(7), toHex(new Uint8Array(32)))).toBeNull();
    expect(sharedSecret(fill(7), 'zz')).toBeNull();
  });

  it('verifies a proof only for its secret, role and nonces', () => {
    const secret = fill(5);
    const [ne, nd] = [fill(1), fill(2)];
    const p = toHex(authProof(secret, 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd));
    expect(verifyProof(secret, 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd, p)).toBe(true);
    expect(verifyProof(secret, 'extension', CLIENT_ID, DESKTOP_ID, ne, nd, p)).toBe(false);
    expect(verifyProof(fill(6), 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd, p)).toBe(false);
    expect(verifyProof(secret, 'desktop', CLIENT_ID, DESKTOP_ID, fill(3), nd, p)).toBe(false);
    expect(verifyProof(secret, 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd, 'x')).toBe(false);
    expect(verifyProof(secret, 'desktop', CLIENT_ID, DESKTOP_ID, ne, nd, undefined)).toBe(false);
  });
});

describe('pairing storage', () => {
  const store: Record<string, unknown> = {};
  beforeEach(() => {
    for (const k of Object.keys(store)) delete store[k];
    vi.mocked(chrome.storage.local.get).mockImplementation((async (k: string) => ({
      [k]: store[k],
    })) as never);
    vi.mocked(chrome.storage.local.set).mockImplementation((async (o: Record<string, unknown>) => {
      Object.assign(store, o);
    }) as never);
    vi.mocked(chrome.storage.local.remove).mockImplementation((async (k: string) => {
      delete store[k];
    }) as never);
  });

  it('makes the install id once', async () => {
    const id = await getClientId();
    expect(id).toMatch(/^[0-9a-f]{32}$/);
    expect(await getClientId()).toBe(id);
    expect(store[CLIENT_ID_KEY]).toBe(id);
  });

  it('keeps a pairing and forgets it on unpair', async () => {
    const pairing = {
      v: 1 as const,
      clientId: CLIENT_ID,
      desktopId: DESKTOP_ID,
      secret: toHex(fill(5)),
      pairedAt: 1,
    };
    await savePairing(pairing);
    expect(await loadPairing()).toEqual(pairing);
    await forgetPairing();
    expect(store[PAIRING_KEY]).toBeUndefined();
    expect(await loadPairing()).toBeNull();
  });

  it('ignores a damaged pairing', () => {
    expect(readPairing({ v: 1, clientId: 'x', desktopId: DESKTOP_ID, secret: 'y' })).toBeNull();
    expect(readPairing(null)).toBeNull();
  });
});

describe('the three codes to pick from', () => {
  const halves = (c: string) => c.split(' ');

  it('never shows a decoy equal to the real code or sharing a half with it', () => {
    for (let n = 0; n < 2000; n++) {
      const real = `${String(n % 1000).padStart(3, '0')} ${String((n * 7) % 1000).padStart(3, '0')}`;
      const { codes, index } = pairCodeChoices(real);
      expect(codes).toHaveLength(3);
      expect(codes[index]).toBe(real);
      const decoys = codes.filter((_, i) => i !== index);
      expect(new Set(codes).size).toBe(3);
      for (const d of decoys) {
        expect(d).toMatch(/^\d{3} \d{3}$/);
        expect(halves(d)[0]).not.toBe(halves(real)[0]);
        expect(halves(d)[1]).not.toBe(halves(real)[1]);
        for (const g of halves(d)) expect(g).not.toMatch(/^(\d)\1\1$/);
      }
    }
  });

  it('redraws until a decoy passes, from the given randomness only', () => {
    const draws = [0, 123_999, 555_456, 135_790, 135_790, 246_801, 1];
    let i = 0;
    const { codes, index } = pairCodeChoices('123 456', () => draws[i++]);
    expect(index).toBe(1);
    expect(codes).toEqual(['135 790', '123 456', '246 801']);
  });

  it('puts the real code at each place about a third of the time', () => {
    const seen = [0, 0, 0];
    for (let n = 0; n < 3000; n++) seen[pairCodeChoices('482 913').index]++;
    for (const c of seen) expect(c).toBeGreaterThan(850);
  });

  it('draws without modulo bias by redrawing the tail of the 32-bit range', () => {
    const limit = Math.floor(2 ** 32 / 1_000_000) * 1_000_000;
    const draws = [limit, 2 ** 32 - 1, 42];
    let i = 0;
    expect(uniformBelow(1_000_000, () => draws[i++])).toBe(42);
    expect(i).toBe(3);
  });
});
