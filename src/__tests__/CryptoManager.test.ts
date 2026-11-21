// @vitest-environment node
import { describe, it, expect, beforeEach } from 'vitest';
import { CryptoManager } from 'src/services/crypto/CryptoManager';

describe('CryptoManager', () => {
  let crypto: CryptoManager;

  beforeEach(() => {
    crypto = new CryptoManager();
  });

  describe('Key Management', () => {
    it('should generate a valid wallet with mnemonic', async () => {
      const wallet = await crypto.generateKeyPair();

      expect(wallet).toBeDefined();
      expect(wallet!.address).toMatch(/^oct[1-9A-HJ-NP-Za-km-z]{44}$/);
      expect(wallet!.mnemonic).toHaveLength(12);
      expect(wallet!.private_key_b64).toBeTruthy();
      expect(wallet!.public_key_b64).toBeTruthy();
    });

    it('should generate unique wallets each time', async () => {
      const wallet1 = await crypto.generateKeyPair();
      const wallet2 = await crypto.generateKeyPair();

      expect(wallet1!.address).not.toBe(wallet2!.address);
      expect(wallet1!.private_key_b64).not.toBe(wallet2!.private_key_b64);
    });

    it('should set private key and derive public key', () => {
      const keyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(keyBytes);
      const keyB64 = btoa(String.fromCharCode(...keyBytes));

      const result = crypto.setPrivateKey(keyB64);

      expect(result).toBe(true);
      expect(crypto.getPublicKey()).toBeTruthy();
    });

    it('should reject invalid private keys', () => {
      expect(crypto.setPrivateKey('')).toBe(false);
      expect(crypto.setPrivateKey('not-base64!!')).toBe(false);
      expect(crypto.setPrivateKey('dG9vc2hvcnQ=')).toBe(false);
    });
  });

  describe('Address Verification', () => {
    it('should accept valid Octra addresses', () => {
      const valid = 'oct' + '1'.repeat(44);
      expect(crypto.verifyAddressFormat(valid)).toBe(true);
    });

    it('should reject addresses without oct prefix', () => {
      const noPrefix = '1'.repeat(47);
      expect(crypto.verifyAddressFormat(noPrefix)).toBe(false);
    });

    it('should reject addresses with wrong length', () => {
      expect(crypto.verifyAddressFormat('oct' + '1'.repeat(43))).toBe(false);
      expect(crypto.verifyAddressFormat('oct' + '1'.repeat(45))).toBe(false);
    });

    it('should reject addresses with invalid base58 characters', () => {
      const invalid = 'oct' + '0'.repeat(44);
      expect(crypto.verifyAddressFormat(invalid)).toBe(false);
    });

    it('should reject null/undefined/empty', () => {
      expect(crypto.verifyAddressFormat('')).toBe(false);
      expect(crypto.verifyAddressFormat(null as unknown as string)).toBe(false);
      expect(crypto.verifyAddressFormat(undefined as unknown as string)).toBe(false);
    });
  });

  describe('Transaction Signing', () => {
    it('should sign and produce a valid 64-byte signature', async () => {
      const wallet = await crypto.generateKeyPair();
      const message = JSON.stringify({ to: 'octTest', amount: 100 });

      const signature = crypto.signTransaction(message, wallet!.private_key_b64);

      const sigBytes = Uint8Array.from(atob(signature), (c) => c.charCodeAt(0));
      expect(sigBytes.length).toBe(64);
    });

    it('should produce different signatures for different messages', async () => {
      const wallet = await crypto.generateKeyPair();

      const sig1 = crypto.signTransaction('message1', wallet!.private_key_b64);
      const sig2 = crypto.signTransaction('message2', wallet!.private_key_b64);

      expect(sig1).not.toBe(sig2);
    });

    it('should throw for invalid private key length', () => {
      const shortKey = btoa('tooshort');
      expect(() => crypto.signTransaction('test', shortKey)).toThrow('Invalid private key length');
    });
  });

  describe('Encoding Utilities', () => {
    it('should roundtrip base64 encoding', () => {
      const original = new Uint8Array([1, 2, 3, 255, 0, 128]);
      const encoded = crypto.bytesToBase64(original);
      const decoded = crypto.base64ToBytes(encoded);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it('should roundtrip hex encoding', () => {
      const original = new Uint8Array([0, 15, 255, 128]);
      const hex = crypto.bytesToHex(original);
      expect(hex).toBe('000fff80');
      const decoded = crypto.hexToBytes(hex);
      expect(Array.from(decoded)).toEqual(Array.from(original));
    });

    it('should produce valid base58 output', () => {
      const bytes = new Uint8Array([1, 2, 3]);
      const b58 = crypto.bytesToBase58(bytes);
      const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
      for (const char of b58) {
        expect(BASE58.includes(char)).toBe(true);
      }
    });
  });

  describe('Import Wallet', () => {
    it('should import a wallet from a valid private key', async () => {
      const generated = await crypto.generateKeyPair();

      const crypto2 = new CryptoManager();
      const imported = await crypto2.importWallet(generated!.private_key_b64);

      expect(imported).toBeDefined();
      expect(imported.address).toBe(generated!.address);
      expect(imported.public_key_b64).toBe(generated!.public_key_b64);
    });

    it('should reject empty private key', async () => {
      await expect(crypto.importWallet('')).rejects.toThrow();
    });
  });

  describe('Balance Encryption', () => {
    it('should encrypt and decrypt an integer balance', async () => {
      const keyBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(keyBytes);
      const keyB64 = btoa(String.fromCharCode(...keyBytes));

      const balance = 12345;
      const encrypted = await crypto.encryptClientBalance(balance, keyB64);

      expect(encrypted).toMatch(/^v2\|/);

      const decrypted = await crypto.decryptClientBalance(encrypted, keyB64);
      expect(decrypted).toBe(balance);
    });

    it('should return 0 for invalid encrypted data', async () => {
      const keyB64 = btoa(String.fromCharCode(...new Uint8Array(32)));
      const result = await crypto.decryptClientBalance('invalid-data', keyB64);
      expect(result).toBe(0);
    });
  });
});

describe('BIP39 wordlist', () => {
  const crypto = new CryptoManager();

  it('generates the standard phrase for the standard vectors', async () => {
    // Vectors from the BIP39 reference; an off-by-one or a foreign word in the list breaks these.
    expect(await crypto.entropyToMnemonic('00000000000000000000000000000000')).toBe(
      'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about'
    );
    expect(await crypto.entropyToMnemonic('7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f7f')).toBe(
      'legal winner thank year wave sausage worth useful legal winner thank yellow'
    );
  });

  it('recognises BIP39 words, the legacy words older builds emitted, and nothing else', () => {
    expect(crypto.isMnemonicWord('castle')).toBe(true);
    expect(crypto.isMnemonicWord(' Robot ')).toBe(true);
    expect(crypto.isMnemonicWord('against')).toBe(true);
    expect(crypto.isMnemonicWord('xyzzy')).toBe(false);
    expect(crypto.isMnemonicWord('')).toBe(false);
  });
});
