import { describe, expect, it } from 'vitest';
import { contractAddressFor, deriveEvmPrivateKey, signEip1559 } from '../tx';

const PHRASE =
  'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';
const SENDER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const INIT =
  '0x6080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea164736f6c6343000814000a';

// Expected values were produced by viem (signTransaction with no `to`, getContractAddress).
const VIEM_RAW =
  '0x02f88e83aa36a7048459682f008506fc23ac008301d4c08080b36080604052348015600f57600080fd5b50603f80601d6000396000f3fe6080604052600080fdfea164736f6c6343000814000ac001a004c12cdfcf6bd0c581f7d187606332858240bb4e09f45bfc63e999d9012731e2a041b2da65db45d41f23759a29b824dd4bb42c508797ac5e6b14f8fde9075b054c';

describe('contract creation', () => {
  it('signs a deployment exactly like viem', async () => {
    const key = await deriveEvmPrivateKey(PHRASE, 0);
    const signed = signEip1559(
      {
        chainId: 11155111,
        nonce: 4,
        maxPriorityFeePerGas: 1_500_000_000n,
        maxFeePerGas: 30_000_000_000n,
        gasLimit: 120_000n,
        to: null,
        value: 0n,
        data: INIT,
      },
      key
    );
    expect(signed.raw).toBe(VIEM_RAW);
  });

  it('predicts the created address like viem', () => {
    expect(contractAddressFor(SENDER, 4)).toBe('0xb3eFA799Fc9A17f2978f1e176F96880F285003b9');
    expect(contractAddressFor(SENDER, 0)).toBe('0xC5273AbFb36550090095B1EDec019216AD21BE6c');
    expect(contractAddressFor(SENDER, 300)).toBe('0x3D5c6660D3F576Dc975c251a6ddf1ce71e01e8c0');
  });

  it('refuses a creation without code', async () => {
    const key = await deriveEvmPrivateKey(PHRASE, 0);
    expect(() =>
      signEip1559(
        {
          chainId: 1,
          nonce: 0,
          maxPriorityFeePerGas: 1n,
          maxFeePerGas: 2n,
          gasLimit: 60_000n,
          to: null,
          value: 0n,
          data: '0x',
        },
        key
      )
    ).toThrow('A contract creation needs code');
  });
});
