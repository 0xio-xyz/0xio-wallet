// @vitest-environment node
import { describe, it, expect } from 'vitest';
import nacl from 'tweetnacl';
import { walletArt, WALLET_ART_GRID } from '../walletArt';

const WALLETS = [
  'octDpvujku1YTWeEWKbqADu9nuWVQznW5GJy3e9Keru97ic',
  'oct2qyupyPfAof4kJ8LcTdN7fyQkLxiKhfemLCz94NNoxio',
  'oct6rDvi2ppQkcN7mZt4LxWb2EyHs9Ra3Uf5Jd8KpVgGHRyrpQ',
];

const toHex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

const fingerprint = (address: string) => {
  const art = walletArt(address);
  const flat = `${art.ground}|${art.cells.map((c) => `${c.r},${c.c},${c.fill}`).join(';')}`;
  return toHex(nacl.hash(new TextEncoder().encode(flat))).slice(0, 16);
};

describe('walletArt', () => {
  it('draws exactly the pinned picture for each address', () => {
    expect(fingerprint(WALLETS[0])).toBe('918bae89e9b68b11');
    expect(fingerprint(WALLETS[1])).toBe('dac3efec5335f798');
    expect(fingerprint(WALLETS[2])).toBe('30fabb818626c346');
  });

  it('is the same picture every time, surrounding spaces ignored', () => {
    expect(walletArt(` ${WALLETS[0]} `)).toEqual(walletArt(WALLETS[0]));
  });

  it('gives different wallets different pictures', () => {
    const prints = new Set(WALLETS.map(fingerprint));
    expect(prints.size).toBe(WALLETS.length);
  });

  it('always carries the braces, mirrored, inside the grid', () => {
    for (const address of WALLETS) {
      const lit = new Set(walletArt(address).cells.map((c) => `${c.r},${c.c}`));
      expect(lit.has('7,1')).toBe(true);
      expect(lit.has('7,13')).toBe(true);
      for (let r = 3; r <= 11; r++) {
        if (r === 7) continue;
        expect(lit.has(`${r},2`)).toBe(true);
        expect(lit.has(`${r},12`)).toBe(true);
      }
      for (const cell of walletArt(address).cells) {
        expect(cell.r).toBeGreaterThanOrEqual(0);
        expect(cell.c).toBeLessThan(WALLET_ART_GRID);
        expect(cell.fill).toMatch(/^#[0-9a-f]{6}$/);
      }
    }
  });

  it('keeps the ground dark so the mark reads on it', () => {
    for (const address of WALLETS) {
      const g = walletArt(address).ground;
      const channels = [1, 3, 5].map((i) => parseInt(g.slice(i, i + 2), 16));
      expect(Math.max(...channels)).toBeLessThan(48);
    }
  });
});
