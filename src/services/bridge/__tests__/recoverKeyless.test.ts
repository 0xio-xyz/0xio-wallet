import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BRIDGE } from '../constants';

const h = vi.hoisted(() => ({
  jsonRpcCall: vi.fn(),
  rawTransactions: vi.fn(),
  lockProgress: vi.fn(),
}));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { jsonRpcCall: h.jsonRpcCall },
}));
vi.mock('../../evm/history', () => ({ rawTransactions: h.rawTransactions }));
vi.mock('../../evm/rpc', () => ({ rpcCall: vi.fn() }));
vi.mock('../bridge', async (importActual) => ({
  isVaultLock: (await importActual<typeof import('../bridge')>()).isVaultLock,
  burnMessageId: vi.fn(),
  ethereumMainnet: vi.fn(),
  lockProgress: h.lockProgress,
}));

import { recoverTransfers } from '../recover';

const TO = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';

describe('recoverTransfers without a 0x key', () => {
  beforeEach(() => {
    h.jsonRpcCall.mockReset();
    h.rawTransactions.mockReset();
    h.lockProgress.mockReset();
  });

  it('reads the Octra locks only and tracks them by the address they pay', async () => {
    h.jsonRpcCall.mockResolvedValue({
      transactions: [
        {
          hash: 'aa'.repeat(32),
          to_: BRIDGE.octraVault,
          encrypted_data: 'lock_to_eth',
          status: 'confirmed',
          timestamp: 100,
        },
        {
          hash: 'bb'.repeat(32),
          to: BRIDGE.octraVault,
          op_type: 'call',
          message: `["${TO}"]`,
          amount: '2000000',
          timestamp: 101,
        },
      ],
    });
    h.lockProgress.mockImplementation(async (hash: string) => ({
      state: 'confirmed',
      locked: { hash, epoch: 7, amountRaw: 2_000_000n, ethAddress: TO, srcNonce: 1 },
    }));

    const found = await recoverTransfers({ octAddress: 'octA', evmAddress: null, known: [] });

    expect(h.rawTransactions).not.toHaveBeenCalled();
    expect(found.map((t) => t.lockHash)).toEqual(['aa'.repeat(32), 'bb'.repeat(32)]);
    expect(found[1]).toMatchObject({
      direction: 'o2e',
      status: 'waiting',
      octAddress: 'octA',
      evmAddress: TO,
      recipient: TO,
      amountRaw: '2000000',
    });
  });
});
