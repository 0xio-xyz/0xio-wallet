import nacl from 'tweetnacl';

// Keep this file identical in the app and the extension: a wallet draws the same picture in both.

export const WALLET_ART_GRID = 15;

export interface WalletArtCell {
  r: number;
  c: number;
  fill: string;
}

export interface WalletArt {
  ground: string;
  cells: WalletArtCell[];
}

const N = WALLET_ART_GRID;

const BRACES: Array<[number, number]> = (() => {
  const left: Array<[number, number]> = [];
  for (let r = 2; r <= 12; r++) left.push([r, r === 7 ? 1 : 2]);
  left.push([2, 3], [12, 3]);
  return [...left, ...left.map(([r, c]): [number, number] => [r, N - 1 - c])];
})();

const SLASH_LEFT: Record<number, number> = { 2: 8, 3: 8, 4: 8, 5: 7, 6: 7, 7: 7, 8: 6, 9: 6, 10: 6, 11: 5, 12: 5 };

const INSIDE: Array<[number, number]> = [];
for (let r = 2; r <= 12; r++) for (let c = 4; c <= 10; c++) INSIDE.push([r, c]);

const mod = (x: number, m: number) => ((x % m) + m) % m;

function hueChannel(m1: number, m2: number, hue: number): number {
  const h = mod(hue, 1);
  if (h < 1 / 6) return m1 + (m2 - m1) * h * 6;
  if (h < 0.5) return m2;
  if (h < 2 / 3) return m1 + (m2 - m1) * (2 / 3 - h) * 6;
  return m1;
}

function hsl(hue: number, sat: number, light: number): string {
  const s = Math.max(0, Math.min(1, sat));
  const l = Math.max(0, Math.min(1, light));
  const h = mod(hue, 360) / 360;
  let rgb: [number, number, number];
  if (s === 0) {
    rgb = [l, l, l];
  } else {
    const m2 = l <= 0.5 ? l * (1 + s) : l + s - l * s;
    const m1 = 2 * l - m2;
    rgb = [hueChannel(m1, m2, h + 1 / 3), hueChannel(m1, m2, h), hueChannel(m1, m2, h - 1 / 3)];
  }
  return '#' + rgb.map((v) => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
}

function circle(cx: number, cy: number, rad: number, ring: boolean): Array<[number, number]> {
  return INSIDE.filter(([r, c]) => {
    const d = Math.hypot(c - cx, r - cy);
    return ring ? Math.abs(d - rad) < 0.62 : d <= rad + 0.25;
  });
}

function compose(address: string): WalletArt {
  const b = nacl.hash(new TextEncoder().encode(address));
  const hue = ((b[0] << 8) | b[1]) % 360;
  const hue2 = (hue + 140 + (b[2] % 60)) % 360;

  const ground = hsl(hue, 0.28, 0.095);
  const braceInk = hsl(hue, 0.18, 0.6);
  const mainInk = hsl(hue, 0.55, 0.5);
  const innerInk = hsl(hue2, 0.5, 0.46);
  const dotInk = hsl(hue2, 0.62, 0.56);

  const kind = b[3] % 4;
  const cx = 7 + ((b[4] % 3) - 1) * 0.5;
  const cy = 7 + ((b[5] % 5) - 2) * 0.6;
  const mainR = 2.2 + (b[6] % 3) * 0.45;

  let main: Array<[number, number]> = [];
  let inner: Array<[number, number]> = [];
  if (kind === 0) {
    main = circle(cx, cy, mainR, true);
  } else if (kind === 1) {
    main = circle(cx, cy, mainR - 0.4, false);
  } else if (kind === 2) {
    main = circle(cx, cy, mainR + 0.3, true);
    inner = circle(cx, cy, 0.9, false);
  } else {
    const dx = 1.1 + (b[7] % 2) * 0.3;
    main = circle(cx - dx, cy, 1.9, true);
    inner = circle(cx + dx, cy, 1.9, true);
  }

  const angle = (b[8] / 255) * 2 * Math.PI;
  const ox = cx + (mainR + 1.6) * Math.cos(angle);
  const oy = cy + (mainR + 1.6) * Math.sin(angle);
  const dot = INSIDE.filter(([r, c]) => Math.hypot(c - ox, r - oy) <= 0.75);

  const slash: Array<[number, number]> = [];
  if (b[9] % 3 === 0) {
    for (const [row, col] of Object.entries(SLASH_LEFT)) {
      slash.push([Number(row), col]);
      if (b[10] % 2 === 0) slash.push([Number(row), col + 1]);
    }
  }

  // Later layers paint over earlier ones, so the key is the cell and the last fill wins.
  const fills = new Map<number, WalletArtCell>();
  const paint = (cells: Array<[number, number]>, fill: string) => {
    for (const [r, c] of cells) fills.set(r * N + c, { r, c, fill });
  };
  paint(BRACES, braceInk);
  paint(main, mainInk);
  paint(inner, innerInk);
  paint(dot, dotInk);
  paint(slash, braceInk);

  return { ground, cells: [...fills.values()].sort((x, y) => x.r * N + x.c - (y.r * N + y.c)) };
}

const cache = new Map<string, WalletArt>();

/** The wallet's picture, drawn from its address alone. */
export function walletArt(address: string): WalletArt {
  const key = address.trim();
  let art = cache.get(key);
  if (!art) {
    art = compose(key);
    if (cache.size > 200) cache.clear();
    cache.set(key, art);
  }
  return art;
}
