import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

let resolveScan: (outputs: unknown[]) => void = () => {};

vi.mock('src/services/network/NetworkService', () => ({
  networkService: {},
  privacyNetworkService: {},
}));
vi.mock('src/services/crypto/PrivateCrypto', () => ({ bytesToBase64: vi.fn() }));
vi.mock('src/services/privacy/stealthWaiting', () => ({
  freshStealthOutput: vi.fn(),
  scanWaiting: vi.fn(
    () =>
      new Promise((resolve) => {
        resolveScan = resolve;
      })
  ),
}));
vi.mock('src/services/network/txScope', () => ({
  assertTxScope: vi.fn(),
  captureTxScope: vi.fn(),
  resolveNetworkPin: vi.fn(async (networkId: string) => ({ networkId, rpcUrl: 'http://node' })),
}));
vi.mock('src/services/pvac/PvacManager', () => ({ pvacManager: {} }));
vi.mock('src/services/privacy/claimBudget', () => ({
  seedClaimBudget: vi.fn(),
  seedClaimBudgetEmpty: vi.fn(),
  remainingClaims: vi.fn(),
  consumeClaimSlot: vi.fn(),
  refundClaimSlot: vi.fn(),
  plausibleLayers: vi.fn(),
}));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import { useClaim } from 'src/hooks/privacy/useClaim';
import { scanWaiting } from 'src/services/privacy/stealthWaiting';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const B = 'octBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';
const output = { id: 9, amount: 5_000_000, tag: 'ab'.repeat(16), epoch: 1, claimSecret: 's' };

const props = (address: string, networkId: 'mainnet' | 'devnet') => ({
  activeWallet: { address, privateKey: 'pk', publicKey: 'pub' } as any,
  networkId,
  isDevnet: networkId === 'devnet',
  showMessage: vi.fn(),
  refreshBalance: vi.fn(),
  adjustBalanceOptimistic: vi.fn(),
});

async function startScan(initial: ReturnType<typeof props>) {
  const hook = renderHook((p: ReturnType<typeof props>) => useClaim(p), { initialProps: initial });
  let scan: Promise<void> = Promise.resolve();
  act(() => {
    scan = hook.result.current.checkClaimEligibility();
  });
  await vi.waitFor(() => expect(scanWaiting).toHaveBeenCalled());
  return { ...hook, scan: () => scan };
}

beforeEach(() => {
  vi.mocked(scanWaiting).mockClear();
});

describe('claim scan scope', () => {
  it('shows the outputs found for the wallet and network it scanned', async () => {
    const { result, scan } = await startScan(props(A, 'mainnet'));
    await act(async () => {
      resolveScan([output]);
      await scan();
    });
    expect(result.current.privateOutputs).toEqual([output]);
    expect(result.current.claimStatus).toBe('eligible');
  });

  it('drops a scan that finishes after a network switch', async () => {
    const { result, rerender, scan } = await startScan(props(A, 'mainnet'));
    rerender(props(A, 'devnet'));
    await act(async () => {
      resolveScan([output]);
      await scan();
    });
    expect(result.current.privateOutputs).toEqual([]);
    expect(result.current.claimStatus).toBe('idle');
    expect(result.current.rewardAmount).toBe('0');
  });

  it('drops a scan that finishes after a wallet switch', async () => {
    const { result, rerender, scan } = await startScan(props(A, 'mainnet'));
    rerender(props(B, 'mainnet'));
    await act(async () => {
      resolveScan([output]);
      await scan();
    });
    expect(result.current.privateOutputs).toEqual([]);
    expect(result.current.claimStatus).toBe('idle');
  });
});
