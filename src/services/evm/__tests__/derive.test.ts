// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HDKey } from '@scure/bip32';
import { deriveEvmPrivateKey } from '../tx';
import { deriveEvmAddress, evmAddressFromPublicKey } from '../accounts';
import { secp256k1 } from '@noble/curves/secp256k1.js';

const ABANDON = [...Array(11).fill('abandon'), 'about'];

afterEach(() => {
  vi.restoreAllMocks();
});

describe('deriveEvmPrivateKey', () => {
  it('wipes the master key and every intermediate node', async () => {
    const wipe = vi.spyOn(HDKey.prototype, 'wipePrivateData');
    const key = await deriveEvmPrivateKey(ABANDON, 3);
    expect(wipe).toHaveBeenCalledTimes(6);
    expect(key.some((b) => b !== 0)).toBe(true);
    expect(evmAddressFromPublicKey(secp256k1.getPublicKey(key, true))).toBe(
      await deriveEvmAddress(ABANDON, 3)
    );
  });
});
