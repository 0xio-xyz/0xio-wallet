// @vitest-environment node
import { describe, it, expect } from 'vitest';
import { qrMatrix, qrSvg, qrDataUrl, type QrLevel } from '../qr';

const hex = (d: Uint8Array) => {
  let out = '';
  for (let i = 0; i < d.length; i += 4)
    out += (
      (d[i] << 3) |
      ((d[i + 1] || 0) << 2) |
      ((d[i + 2] || 0) << 1) |
      (d[i + 3] || 0)
    ).toString(16);
  return out;
};

const fnv = (d: Uint8Array) => {
  let h = 0x811c9dc5;
  for (const b of d) {
    h ^= b;
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
};

const fill = (n: number, at: (i: number) => string) =>
  Array.from({ length: n }, (_, i) => at(i)).join('');

const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const HEX = '0123456789abcdef';
const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

const FULL: [string, QrLevel, number, number, string][] = [
  [
    'octra-hidden-credential',
    'M',
    2,
    4,
    'feafbfc13a106e92cbb75ef5dba93aec16c507faaafe0132008b907ce8eac69c94e18c1f1a5dae8f6fad1c405b0450319515e6f0fb0047443fb62a904e51dbae8fbdd11bbee989cd045246febe138',
  ],
  [
    'oct' + fill(44, (i) => BASE58[(i * 7 + 3) % 58]),
    'H',
    6,
    1,
    'fe3e13873fc164a3b4506ebd684d6bb752cc7715dbae2ff2d2ec153f053507faaaaaaafe00f6d3c100279d1f48df1c46f244dbc7eca945587d1c060c4aa47ac47c0e5e8be49926a3cceb0cdb8270544a434b72dfaf7cbd822b613f4996cda93c563f24c089a68c709bc75fbf6df17fe7d6a91f5cc45a4b110e41fb8b2280d1367ea47dd978d1bde766e46f8ac2662588f9634b900ac2033340a38ecd23bd1a5137abf45afe55b4cdfc804b57ddc4bfa65287aa305f4a1c51bba568bc7fadd1448ed6e6ebf45e52f70441fac480fe33e4028e8',
  ],
  [
    '0x' + fill(40, (i) => HEX[(i * 11 + 5) % 16]),
    'H',
    5,
    4,
    'fe1b7a53fc14c709506e96c1aebb740887f5dba64ad7aec156c14507faaaaaafe0118c57000f27662b12c8fd0aacafede0752d1bfdbd58fe384fbae7fcea8da8ca3e979effd384367726de68eab27841cc1aedb1f418ef5dc8b54a4ef960034ae64e5754a8c18829cf64948a2a60e7eaac4f633d034777e68abeb27d0c285d7a7cfde4650afe805185ac53fadb542b9058dc731fbaaa4a8fedd3c621102e942f828504b9b1636fe5ca933b8',
  ],
  [
    '0123456789012345678901234567890123456789',
    'Q',
    2,
    3,
    'fe3d3fc152506ea42bb74b45dba73aec102507faaafe004200761d831eef7015eb0893a827227abdfba414e98daba72b53750731fb0048453f9d6a305851bba76fadd75896eb8d4d050be2fe1e2e8',
  ],
  [
    'HTTPS://0XIO.XYZ/OPEN?A=1 $%*+-./:',
    'L',
    2,
    0,
    'fe23bfc122506ea5cbb74895dba4caec119507faaafe012200ef92e22cefa8e5acb1fc8f853af373a12d420ea84f20e019f88626fc806cc57fbceb905d117baedfe5d289eaeab96b0519cbfef5888',
  ],
];

const HASHED: [string, QrLevel, number, number, string][] = [
  [PHRASE, 'M', 6, 2, '89fedee0'],
  [PHRASE + ' ' + PHRASE, 'M', 10, 2, '581e4675'],
  [fill(64, (i) => HEX[(i * 5 + 1) % 16]), 'M', 5, 4, 'b10a39b9'],
  [fill(700, (i) => String.fromCharCode(33 + ((i * 37 + 11) % 90))), 'Q', 25, 1, '545e0290'],
  [fill(2953, (i) => String.fromCharCode(97 + ((i * 7) % 26))), 'L', 40, 2, '34f58791'],
  ['Ünïcödé 中文 한국어 🙂', 'M', 3, 2, '4a734c3a'],
];

describe('qrMatrix', () => {
  it.each(FULL)('matches the recorded symbol for %s', (text, level, version, mask, modules) => {
    const qr = qrMatrix(text, level);
    expect([qr.version, qr.mask, qr.size]).toEqual([version, mask, version * 4 + 17]);
    expect(hex(qr.data)).toBe(modules);
  });

  it.each(HASHED)('matches the recorded symbol at %#', (text, level, version, mask, sum) => {
    const qr = qrMatrix(text, level);
    expect([qr.version, qr.mask]).toEqual([version, mask]);
    expect(fnv(qr.data)).toBe(sum);
  });

  it('gives bytes and their text the same symbol', () => {
    const text = 'oct' + fill(44, (i) => BASE58[(i * 7 + 3) % 58]);
    expect(hex(qrMatrix(new TextEncoder().encode(text), 'H').data)).toBe(
      hex(qrMatrix(text, 'H').data)
    );
  });

  it('refuses data past the largest symbol', () => {
    expect(() => qrMatrix('a'.repeat(2954), 'L')).toThrow('QR data too long');
    expect(() => qrMatrix('a'.repeat(1274), 'H')).toThrow('QR data too long');
    expect(qrMatrix('a'.repeat(1273), 'H').version).toBe(40);
  });
});

describe('qrSvg', () => {
  it('draws every dark module once inside the quiet zone', () => {
    const qr = qrMatrix('octra-hidden-credential', 'M');
    const svg = qrSvg('octra-hidden-credential', { level: 'M', margin: 1 });
    const box = qr.size + 2;
    expect(svg).toContain(`viewBox="0 0 ${box} ${box}"`);
    const seen = new Uint8Array(qr.size * qr.size);
    const dark = svg.split('<path')[2];
    for (const [, x, y, w] of dark.matchAll(/M(\d+) (\d+)h(\d+)v1/g))
      for (let i = 0; i < +w; i++) seen[(+y - 1) * qr.size + (+x - 1) + i]++;
    expect(hex(seen)).toBe(hex(qr.data));
  });

  it('carries the colours and size it was given', () => {
    const svg = qrSvg('0xio', { dark: '#111111', light: '#fefefe', width: 300 });
    expect(svg).toContain('width="300" height="300"');
    expect(svg).toContain('fill="#fefefe"');
    expect(svg).toContain('fill="#111111"');
    expect(qrSvg('0xio', { dark: '"><script>' })).not.toContain('<script>');
  });

  it('makes an image source', () => {
    const url = qrDataUrl('0xio', { margin: 2 });
    expect(url.startsWith('data:image/svg+xml;utf8,%3Csvg')).toBe(true);
    expect(decodeURIComponent(url.slice(url.indexOf(',') + 1))).toBe(qrSvg('0xio', { margin: 2 }));
  });
});
