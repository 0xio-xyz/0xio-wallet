export type QrLevel = 'L' | 'M' | 'Q' | 'H';

export interface QrMatrix {
  version: number;
  mask: number;
  size: number;
  data: Uint8Array;
}

export interface QrImageOptions {
  level?: QrLevel;
  margin?: number;
  dark?: string;
  light?: string;
  width?: number;
}

const LEVELS: QrLevel[] = ['L', 'M', 'Q', 'H'];
const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

// prettier-ignore
const EC_PER_BLOCK: number[][] = [
  [7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
  [13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
  [17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// prettier-ignore
const EC_BLOCKS: number[][] = [
  [1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
  [1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
  [1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
  [1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
for (let i = 0, x = 1; i < 255; i++) {
  EXP[i] = x;
  EXP[i + 255] = x;
  LOG[x] = i;
  x <<= 1;
  if (x & 0x100) x ^= 0x11d;
}

const gfMul = (a: number, b: number) => (a && b ? EXP[LOG[a] + LOG[b]] : 0);

function rsDivisor(degree: number): Uint8Array {
  const poly = new Uint8Array(degree);
  poly[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < degree; j++) {
      poly[j] = gfMul(poly[j], root);
      if (j + 1 < degree) poly[j] ^= poly[j + 1];
    }
    root = gfMul(root, 2);
  }
  return poly;
}

function rsRemainder(data: Uint8Array, divisor: Uint8Array): Uint8Array {
  const out = new Uint8Array(divisor.length);
  for (const byte of data) {
    const factor = byte ^ out[0];
    out.copyWithin(0, 1);
    out[out.length - 1] = 0;
    for (let i = 0; i < out.length; i++) out[i] ^= gfMul(divisor[i], factor);
  }
  return out;
}

const alignCount = (version: number) => (version === 1 ? 0 : Math.floor(version / 7) + 2);

function totalCodewords(version: number): number {
  let modules = (16 * version + 128) * version + 64;
  if (version >= 2) {
    const n = alignCount(version);
    modules -= (25 * n - 10) * n - 55;
    if (version >= 7) modules -= 36;
  }
  return Math.floor(modules / 8);
}

function dataCodewords(version: number, level: number): number {
  return totalCodewords(version) - EC_PER_BLOCK[level][version - 1] * EC_BLOCKS[level][version - 1];
}

function alignPositions(version: number): number[] {
  const n = alignCount(version);
  if (!n) return [];
  const size = version * 4 + 17;
  const step = version === 32 ? 26 : Math.ceil((size - 13) / (n * 2 - 2)) * 2;
  const out = [6];
  for (let pos = size - 7; out.length < n; pos -= step) out.splice(1, 0, pos);
  return out;
}

const NUMERIC = 0;
const ALPHA = 1;
const BYTE = 2;
const MODE_BITS = [1, 2, 4];
const LENGTH_BITS = [
  [10, 9, 8],
  [12, 11, 16],
  [14, 13, 16],
];
const CHAR_COST = [20, 33, 48];
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';
const ALPHA_VALUE = new Int8Array(128).fill(-1);
for (let i = 0; i < ALPHABET.length; i++) ALPHA_VALUE[ALPHABET.charCodeAt(i)] = i;

const fits = (byte: number, mode: number) =>
  mode === BYTE ||
  (mode === NUMERIC ? byte >= 48 && byte <= 57 : byte < 128 && ALPHA_VALUE[byte] >= 0);

interface Segment {
  mode: number;
  bytes: Uint8Array;
}

function segment(payload: Uint8Array, size: number): Segment[] {
  const n = payload.length;
  if (!n) return [];
  const head = LENGTH_BITS[size].map((bits) => (4 + bits) * 6);
  const from = new Uint8Array(n * 3);
  let cost = [Infinity, Infinity, Infinity];
  for (let i = 0; i < n; i++) {
    const next = [Infinity, Infinity, Infinity];
    for (let mode = 0; mode < 3; mode++) {
      if (!fits(payload[i], mode)) continue;
      if (!i) {
        next[mode] = head[mode] + CHAR_COST[mode];
        continue;
      }
      for (let prev = 0; prev < 3; prev++) {
        const total =
          (prev === mode ? cost[prev] : Math.ceil(cost[prev] / 6) * 6 + head[mode]) +
          CHAR_COST[mode];
        if (total < next[mode]) {
          next[mode] = total;
          from[i * 3 + mode] = prev;
        }
      }
    }
    cost = next;
  }
  let mode = 0;
  for (let m = 1; m < 3; m++) if (Math.ceil(cost[m] / 6) < Math.ceil(cost[mode] / 6)) mode = m;
  const out: Segment[] = [];
  let end = n;
  for (let i = n - 1; i >= 0; i--) {
    const prev = i ? from[i * 3 + mode] : -1;
    if (prev === mode) continue;
    out.unshift({ mode, bytes: payload.subarray(i, end) });
    end = i;
    mode = prev;
  }
  return out;
}

function segmentBits(segments: Segment[], size: number): number {
  let bits = 0;
  for (const { mode, bytes } of segments) {
    const n = bytes.length;
    bits += 4 + LENGTH_BITS[size][mode];
    if (mode === NUMERIC) bits += Math.floor(n / 3) * 10 + [0, 4, 7][n % 3];
    else if (mode === ALPHA) bits += Math.floor(n / 2) * 11 + (n % 2) * 6;
    else bits += n * 8;
  }
  return bits;
}

const sizeClass = (version: number) => (version < 10 ? 0 : version < 27 ? 1 : 2);

function plan(payload: Uint8Array, level: number): { version: number; segments: Segment[] } {
  for (let size = 0, version = 1; size < 3; size++) {
    const segments = segment(payload, size);
    const bits = segmentBits(segments, size);
    for (; version <= 40 && sizeClass(version) === size; version++)
      if (bits <= dataCodewords(version, level) * 8) return { version, segments };
  }
  throw new Error('QR data too long');
}

function codewords(segments: Segment[], version: number, level: number): Uint8Array {
  const capacity = dataCodewords(version, level);
  const data = new Uint8Array(capacity);
  let bit = 0;
  const put = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--, bit++)
      if ((value >>> i) & 1) data[bit >>> 3] |= 0x80 >>> (bit & 7);
  };
  for (const { mode, bytes } of segments) {
    const n = bytes.length;
    put(MODE_BITS[mode], 4);
    put(n, LENGTH_BITS[sizeClass(version)][mode]);
    if (mode === NUMERIC) {
      for (let i = 0; i < n; i += 3) {
        const digits = Math.min(3, n - i);
        let value = 0;
        for (let j = 0; j < digits; j++) value = value * 10 + bytes[i + j] - 48;
        put(value, digits * 3 + 1);
      }
    } else if (mode === ALPHA) {
      for (let i = 0; i + 1 < n; i += 2)
        put(ALPHA_VALUE[bytes[i]] * 45 + ALPHA_VALUE[bytes[i + 1]], 11);
      if (n % 2) put(ALPHA_VALUE[bytes[n - 1]], 6);
    } else {
      for (const byte of bytes) put(byte, 8);
    }
  }
  bit = Math.min(bit + 4, capacity * 8);
  for (let i = Math.ceil(bit / 8), pad = 0xec; i < capacity; i++, pad ^= 0xfd) data[i] = pad;

  const blocks = EC_BLOCKS[level][version - 1];
  const ecLength = EC_PER_BLOCK[level][version - 1];
  const total = totalCodewords(version);
  const shortBlocks = blocks - (total % blocks);
  const shortData = Math.floor(total / blocks) - ecLength;
  const divisor = rsDivisor(ecLength);
  const dataBlocks: Uint8Array[] = [];
  const ecBlocks: Uint8Array[] = [];
  for (let i = 0, at = 0; i < blocks; i++) {
    const length = shortData + (i < shortBlocks ? 0 : 1);
    const block = data.subarray(at, at + length);
    at += length;
    dataBlocks.push(block);
    ecBlocks.push(rsRemainder(block, divisor));
  }

  const out = new Uint8Array(total);
  let at = 0;
  for (let i = 0; i <= shortData; i++)
    for (const block of dataBlocks) if (i < block.length) out[at++] = block[i];
  for (let i = 0; i < ecLength; i++) for (const block of ecBlocks) out[at++] = block[i];
  return out;
}

const MASKS: ((row: number, col: number) => boolean)[] = [
  (r, c) => (r + c) % 2 === 0,
  (r) => r % 2 === 0,
  (_, c) => c % 3 === 0,
  (r, c) => (r + c) % 3 === 0,
  (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
  (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
  (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
  (r, c) => (((r * c) % 3) + ((r + c) % 2)) % 2 === 0,
];

function penalty(m: Uint8Array, size: number): number {
  let points = 0;
  let dark = 0;
  for (let a = 0; a < size; a++) {
    let runRow = 0;
    let runCol = 0;
    let lastRow = -1;
    let lastCol = -1;
    let bitsRow = 0;
    let bitsCol = 0;
    for (let b = 0; b < size; b++) {
      const inRow = m[a * size + b];
      const inCol = m[b * size + a];
      dark += inRow;
      if (inRow === lastRow) runRow++;
      else {
        if (runRow >= 5) points += runRow - 2;
        lastRow = inRow;
        runRow = 1;
      }
      if (inCol === lastCol) runCol++;
      else {
        if (runCol >= 5) points += runCol - 2;
        lastCol = inCol;
        runCol = 1;
      }
      bitsRow = ((bitsRow << 1) & 0x7ff) | inRow;
      bitsCol = ((bitsCol << 1) & 0x7ff) | inCol;
      if (b >= 10) {
        if (bitsRow === 0x5d0 || bitsRow === 0x05d) points += 40;
        if (bitsCol === 0x5d0 || bitsCol === 0x05d) points += 40;
      }
      if (a < size - 1 && b < size - 1) {
        const sum = inRow + m[a * size + b + 1] + m[(a + 1) * size + b] + m[(a + 1) * size + b + 1];
        if (sum === 0 || sum === 4) points += 3;
      }
    }
    if (runRow >= 5) points += runRow - 2;
    if (runCol >= 5) points += runCol - 2;
  }
  return points + Math.abs(Math.ceil((dark * 100) / (size * size) / 5) - 10) * 10;
}

export function qrMatrix(input: string | Uint8Array, level: QrLevel = 'M'): QrMatrix {
  const payload = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  const lv = LEVELS.indexOf(level);
  if (lv < 0) throw new Error('Unknown QR level');
  const { version, segments } = plan(payload, lv);
  const size = version * 4 + 17;
  const m = new Uint8Array(size * size);
  const fixed = new Uint8Array(size * size);
  const set = (row: number, col: number, dark: boolean | number) => {
    m[row * size + col] = dark ? 1 : 0;
    fixed[row * size + col] = 1;
  };

  for (const [row, col] of [
    [0, 0],
    [0, size - 7],
    [size - 7, 0],
  ]) {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue;
        const ring = Math.max(Math.abs(r - 3), Math.abs(c - 3));
        set(row + r, col + c, ring !== 2 && ring !== 4);
      }
    }
  }
  for (let i = 8; i < size - 8; i++) {
    set(6, i, i % 2 === 0);
    set(i, 6, i % 2 === 0);
  }
  const align = alignPositions(version);
  const last = align.length - 1;
  align.forEach((row, i) =>
    align.forEach((col, j) => {
      if ((i === 0 && j === 0) || (i === 0 && j === last) || (i === last && j === 0)) return;
      for (let r = -2; r <= 2; r++)
        for (let c = -2; c <= 2; c++)
          set(row + r, col + c, Math.max(Math.abs(r), Math.abs(c)) !== 1);
    })
  );
  if (version >= 7) {
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem;
    for (let i = 0; i < 18; i++) {
      const dark = (bits >>> i) & 1;
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      set(a, b, dark);
      set(b, a, dark);
    }
  }
  const format = (mask: number) => {
    const head = (FORMAT_BITS[level] << 3) | mask;
    let rem = head;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((head << 10) | rem) ^ 0x5412;
    for (let i = 0; i < 15; i++) {
      const dark = (bits >>> i) & 1;
      if (i < 6) set(i, 8, dark);
      else if (i < 8) set(i + 1, 8, dark);
      else set(size - 15 + i, 8, dark);
      if (i < 8) set(8, size - 1 - i, dark);
      else if (i < 9) set(8, 7, dark);
      else set(8, 14 - i, dark);
    }
    set(size - 8, 8, 1);
  };
  format(0);

  const bytes = codewords(segments, version, lv);
  let bit = 0;
  let up = true;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (let step = 0; step < size; step++) {
      const row = up ? size - 1 - step : step;
      for (let c = col; c > col - 2; c--) {
        if (fixed[row * size + c]) continue;
        if (bit < bytes.length * 8) m[row * size + c] = (bytes[bit >>> 3] >>> (7 - (bit & 7))) & 1;
        bit++;
      }
    }
    up = !up;
  }

  const flip = (mask: number) => {
    const on = MASKS[mask];
    for (let row = 0; row < size; row++)
      for (let col = 0; col < size; col++)
        if (!fixed[row * size + col] && on(row, col)) m[row * size + col] ^= 1;
  };
  let mask = 0;
  let lowest = Infinity;
  for (let i = 0; i < 8; i++) {
    format(i);
    flip(i);
    const score = penalty(m, size);
    flip(i);
    if (score < lowest) {
      lowest = score;
      mask = i;
    }
  }
  flip(mask);
  format(mask);
  return { version, mask, size, data: m };
}

const attr = (value: string) =>
  value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

export function qrSvg(input: string | Uint8Array, options: QrImageOptions = {}): string {
  const { level = 'M', margin = 4, dark = '#000000', light = '#ffffff', width } = options;
  const { size, data } = qrMatrix(input, level);
  const box = size + margin * 2;
  let path = '';
  for (let row = 0; row < size; row++) {
    for (let col = 0; col < size; col++) {
      if (!data[row * size + col]) continue;
      let run = 1;
      while (col + run < size && data[row * size + col + run]) run++;
      path += `M${col + margin} ${row + margin}h${run}v1h-${run}z`;
      col += run;
    }
  }
  const dims = width ? ` width="${width}" height="${width}"` : '';
  return (
    `<svg xmlns="http://www.w3.org/2000/svg"${dims} viewBox="0 0 ${box} ${box}" shape-rendering="crispEdges">` +
    `<path fill="${attr(light)}" d="M0 0h${box}v${box}H0z"/>` +
    `<path fill="${attr(dark)}" d="${path}"/></svg>`
  );
}

export function qrDataUrl(input: string | Uint8Array, options: QrImageOptions = {}): string {
  return 'data:image/svg+xml;utf8,' + encodeURIComponent(qrSvg(input, options));
}
