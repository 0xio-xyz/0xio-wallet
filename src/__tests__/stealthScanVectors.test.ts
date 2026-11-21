import { describe, expect, it } from 'vitest';
import { createHash } from 'crypto';
import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  bytesToBase64,
  base64ToBytes,
  deriveViewKeypair,
  ecdhSharedSecret,
  generateEphemeralKeypair,
  scanPrivateOutputs,
} from '../services/crypto/PrivateCrypto';

const VECTORS_SHA256 = '0ea5e933f5b2b5078def5c128e4eafd305d2ec9c859dfa50aa391f1fdbc55703';

interface Vector {
  case: string;
  id: number;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
  expect: { amount: string; blinding: string; claim_secret: string } | null;
}
interface Wallet {
  seed_hex: string;
  view_pub: string;
  outputs: Vector[];
}

const copy = resolve(__dirname, 'fixtures/stealth-scan-vectors.json');
const wallets: Wallet[] = JSON.parse(readFileSync(copy, 'utf8')).wallets;
const keyOf = (w: Wallet) => Buffer.from(w.seed_hex, 'hex').toString('base64');
const scanOne = (w: Wallet, v: Vector) => scanPrivateOutputs([{ ...v, claimed: 0 }], keyOf(w));
const lowOrder = wallets
  .flatMap((w) => w.outputs)
  .filter((v) => /low-order ephemeral point( \(|$)/.test(v.case));

describe('stealth scan vectors', () => {
  it('is the shared file', () => {
    expect(createHash('sha256').update(readFileSync(copy)).digest('hex')).toBe(VECTORS_SHA256);
  });

  it('derives the view key the vectors name', () => {
    for (const w of wallets)
      expect(bytesToBase64(deriveViewKeypair(keyOf(w)).viewPub)).toBe(w.view_pub);
  });

  it('matches no wallet on a low-order ephemeral point', async () => {
    expect(lowOrder).toHaveLength(9);
    for (const v of lowOrder) {
      for (const w of wallets) {
        expect(await scanOne(w, v), v.case).toEqual([]);
        await expect(
          ecdhSharedSecret(deriveViewKeypair(keyOf(w)).viewSk, base64ToBytes(v.eph_pub))
        ).rejects.toThrow('x25519 low-order public key rejected');
      }
    }
  });

  it('refuses a low-order key on the sending side', async () => {
    for (const v of lowOrder) {
      await expect(
        ecdhSharedSecret(generateEphemeralKeypair().ephSk, base64ToBytes(v.eph_pub))
      ).rejects.toThrow('x25519 low-order public key rejected');
    }
  });

  it('opens every match of the vectors', async () => {
    let matched = 0;
    for (const w of wallets) {
      for (const v of w.outputs) {
        if (!v.expect) continue;
        const [found] = await scanOne(w, v);
        expect(found.id, v.case).toBe(v.id);
        expect(found.claimSecret, v.case).toBe(v.expect.claim_secret);
        expect(bytesToBase64(found.blinding), v.case).toBe(v.expect.blinding);
        if (BigInt(v.expect.amount) < 2n ** 53n) expect(String(found.amount)).toBe(v.expect.amount);
        matched++;
      }
    }
    expect(matched).toBe(21);
  });

  it('matches nothing the vectors refuse', async () => {
    for (const w of wallets) {
      for (const v of w.outputs) {
        if (v.expect || v.case === 'zero amount') continue;
        expect(await scanOne(w, v), v.case).toEqual([]);
      }
    }
  });
});
