import { describe, expect, it } from 'vitest';
import { pvacMasterSeed } from '../services/pvac/pvacMasterSeed';

const hex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');

describe('pvacMasterSeed', () => {
  it('matches the pvac-rs master_seed vector', async () => {
    const master = await pvacMasterSeed(new Uint8Array(32).fill(42));
    expect(hex(master)).toBe('af297eff7d3e8969a28450deeef6bb197ab31df220fcdcbde2fd4446e605c1dd');
  });

  it('leaves the wallet seed untouched', async () => {
    const seed = new Uint8Array(32).fill(7);
    await pvacMasterSeed(seed);
    expect(seed.every((b) => b === 7)).toBe(true);
  });
});
