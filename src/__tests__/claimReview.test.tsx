import { act, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ captureTxScope: vi.fn(), initialize: vi.fn() }));

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { getNextNonce: vi.fn() },
  privacyNetworkService: {},
}));
vi.mock('src/services/crypto/PrivateCrypto', () => ({ bytesToBase64: vi.fn() }));
vi.mock('src/services/privacy/stealthWaiting', () => ({
  freshStealthOutput: vi.fn(),
  scanWaiting: vi.fn(),
}));
vi.mock('src/services/network/txScope', () => ({
  assertTxScope: vi.fn(),
  captureTxScope: h.captureTxScope,
  resolveNetworkPin: vi.fn(async (networkId: string) => ({ networkId, rpcUrl: 'http://node' })),
}));
vi.mock('src/services/pvac/PvacManager', () => ({
  pvacManager: { lastDecryptLegacy: false, initialize: h.initialize },
}));
vi.mock('src/services/privacy/claimBudget', () => ({
  seedClaimBudget: vi.fn(),
  seedClaimBudgetEmpty: vi.fn(),
  remainingClaims: vi.fn(),
  consumeClaimSlot: vi.fn(),
  refundClaimSlot: vi.fn(),
  plausibleLayers: vi.fn(),
}));
vi.mock('src/shared/ui/Mascot', () => ({ Mascot: (): null => null }));
vi.mock('src/i18n/react', () => ({
  useTranslation: () => ({
    t: (key: string, opts?: { defaultValue?: string }) => opts?.defaultValue ?? key,
  }),
}));

import ClaimSection from 'src/features/privacy/components/ClaimSection';
import { useClaim } from 'src/hooks/privacy/useClaim';
import { networkService } from 'src/services/network/NetworkService';

const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const output = {
  id: 9,
  amount: 5_000_000,
  tag: 'ab'.repeat(16),
  epoch: 1,
  claimSecret: 's',
  blinding: new Uint8Array(32),
} as never;

describe('claim review', () => {
  it('opens the review from a row instead of signing', () => {
    const onReviewSingle = vi.fn();
    render(
      <ClaimSection
        claimStatus="eligible"
        rewardAmount="5"
        claimProgress=""
        claimingOutputId={null}
        privateOutputs={[output]}
        handleClaim={vi.fn()}
        onReviewSingle={onReviewSingle}
        setClaimStatus={vi.fn()}
      />
    );
    fireEvent.click(screen.getByText('Claim'));
    expect(onReviewSingle).toHaveBeenCalledWith(output);
  });
});

describe('claim fee', () => {
  const props = (feeRaw: string | null, publicBalance: string | null) => ({
    activeWallet: { address: A, privateKey: 'pk', publicKey: 'pub' } as never,
    networkId: 'devnet' as const,
    isDevnet: true,
    showMessage: vi.fn(),
    refreshBalance: vi.fn(),
    adjustBalanceOptimistic: vi.fn(),
    feeRaw,
    publicBalance,
  });

  it('blocks a claim whose fee could not be read, before any work', async () => {
    const p = props(null, '10');
    const { result } = renderHook(() => useClaim(p));
    await act(async () => {
      await result.current.handleClaimSingle(output);
    });
    expect(p.showMessage).toHaveBeenCalledWith('Network fee unavailable. Try again.', 'error');
    expect(h.captureTxScope).not.toHaveBeenCalled();
    expect(networkService.getNextNonce).not.toHaveBeenCalled();
  });

  it('blocks a claim the public balance cannot pay for', async () => {
    const p = props('1000000', '0.5');
    const { result } = renderHook(() => useClaim(p));
    await act(async () => {
      await result.current.handleClaimSingle(output);
    });
    expect(p.showMessage).toHaveBeenCalledWith(
      'Insufficient public balance for network fee',
      'error'
    );
    expect(h.initialize).not.toHaveBeenCalled();
  });
});
