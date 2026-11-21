// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Wallet } from '../../../types/wallet';

const vault: { wallets: Wallet[] } = { wallets: [] };

vi.mock('src/services/crypto/PasswordManager', () => ({
  passwordManager: { getSessionKey: vi.fn(async () => 'session') },
}));
vi.mock('src/services/wallet/WalletStorage', () => ({
  walletStorage: {
    loadVault: vi.fn(async () => vault.wallets),
    loadWallet: vi.fn(async (id: string) => vault.wallets.find((w) => w.id === id)),
  },
}));

const { signAndBroadcast, signAndSubmit } = await import('../signer');
const { evmNetworksFor } = await import('../networks');
const { deriveEvmPrivateKey, signEip1559 } = await import('../tx');

const ABANDON = [...Array(11).fill('abandon'), 'about'];
const EVM_0 = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const [ethereum] = evmNetworksFor('mainnet');

const wallet: Wallet = {
  id: 'w',
  name: 'w',
  address: 'octw',
  type: 'standard',
  privateKey: 'k',
  mnemonic: ABANDON,
  publicKey: null,
  isActive: true,
  metadata: {
    source: 'imported',
    createdAt: 0,
    isPadded: false,
    evm: { enabled: true, address: EVM_0, index: 0 },
  },
};

const tx = {
  chainId: 1,
  nonce: 4,
  maxPriorityFeePerGas: 1n,
  maxFeePerGas: 2n,
  gasLimit: 21000n,
  to: '0x3535353535353535353535353535353535353535',
  value: 1n,
  data: '0x',
};
const who = { id: 'w', evmIndex: 0, evmAddress: EVM_0 };

function answer(out: unknown | Error | { http: number }) {
  let sends = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const c = JSON.parse(String(init.body)) as { id: number };
      sends++;
      if (out && typeof out === 'object' && 'http' in out) {
        return new Response('', { status: (out as { http: number }).http });
      }
      return new Response(
        JSON.stringify(
          out instanceof Error
            ? { jsonrpc: '2.0', id: c.id, error: { code: -32000, message: out.message } }
            : { jsonrpc: '2.0', id: c.id, result: out }
        )
      );
    })
  );
  return () => sends;
}

let localHash = '';

beforeEach(async () => {
  vault.wallets = [wallet];
  localHash = signEip1559(tx, await deriveEvmPrivateKey(ABANDON, 0)).hash;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('signAndSubmit', () => {
  it('returns the local hash when the node agrees', async () => {
    answer(localHash);
    expect(await signAndSubmit(ethereum, tx, who)).toMatchObject({
      hash: localHash,
      nonce: 4,
      acknowledged: true,
    });
  });

  it('keeps the local hash when the node returns another one', async () => {
    answer('0x' + 'ee'.repeat(32));
    expect((await signAndSubmit(ethereum, tx, who)).hash).toBe(localHash);
    answer('0x' + 'ee'.repeat(32));
    expect(await signAndBroadcast(ethereum, tx, who)).toBe(localHash);
  });

  it('never throws once the tx was handed over and the reply was lost', async () => {
    for (const out of [{ http: 504 }, { http: 500 }, new Error('upstream timeout')]) {
      answer(out);
      const sent = await signAndSubmit(ethereum, tx, who);
      expect(sent).toMatchObject({ hash: localHash, acknowledged: false });
      expect(sent.raw.startsWith('0x02')).toBe(true);
    }
  });

  it('throws when the node refused the tx', async () => {
    answer(new Error('nonce too low'));
    await expect(signAndSubmit(ethereum, tx, who)).rejects.toThrow('nonce too low');
    answer(new Error('insufficient funds for gas * price + value'));
    await expect(signAndBroadcast(ethereum, tx, who)).rejects.toThrow('insufficient funds');
  });

  it('sends nothing for another network', async () => {
    const sends = answer(localHash);
    await expect(signAndSubmit(ethereum, { ...tx, chainId: 5 }, who)).rejects.toThrow(
      'another network'
    );
    expect(sends()).toBe(0);
  });
});
