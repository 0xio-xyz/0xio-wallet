import { describe, expect, it } from 'vitest';
import { evmNetworksFor } from 'src/services/evm/networks';
import { evmTokensFor } from 'src/services/evm/tokens';
import {
  endStageOf,
  nonceChanged,
  recipientIssue,
  scopeChanged,
  type EvmReviewBinding,
  type EvmSendScope,
} from '../evmSendGuards';

const [ethereum] = evmNetworksFor('mainnet');
const [eth, usdc] = evmTokensFor(1);
const FROM = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const TO = '0x3535353535353535353535353535353535353535';

const bound: EvmReviewBinding = {
  walletId: 'w1',
  evmIndex: 0,
  from: FROM,
  chainId: 1,
  rpcUrl: ethereum.rpcUrl,
  to: TO,
  amount: 5n,
  amountText: '0.000000000000000005',
  tokenKey: '1:native',
  token: eth,
  network: ethereum,
  prepared: {
    tx: {
      chainId: 1,
      nonce: 7,
      maxPriorityFeePerGas: 1n,
      maxFeePerGas: 2n,
      gasLimit: 21000n,
      to: TO,
      value: 5n,
      data: '0x',
    },
    feeWei: 42000n,
    totalNative: 42005n,
  },
  usd: null,
};

const live: EvmSendScope = {
  walletId: 'w1',
  evmIndex: 0,
  from: FROM.toLowerCase(),
  chainId: 1,
  rpcUrl: ethereum.rpcUrl,
  to: ` ${TO} `,
  amount: 5n,
  tokenKey: '1:native',
};

describe('scopeChanged', () => {
  it('passes when nothing the review showed changed', () => {
    expect(scopeChanged(bound, live)).toBe(false);
  });

  it('refuses any change of wallet, account, address, network, RPC, recipient, amount or asset', () => {
    const changes: Partial<EvmSendScope>[] = [
      { walletId: 'w2' },
      { walletId: null },
      { evmIndex: 1 },
      { from: '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0' },
      { from: null },
      { chainId: 4663 },
      { chainId: null },
      { rpcUrl: 'https://evil.test' },
      { to: '0x' + '36'.repeat(20) },
      { amount: 6n },
      { tokenKey: '1:' + usdc.address!.toLowerCase() },
      { tokenKey: null },
    ];
    for (const c of changes) expect(scopeChanged(bound, { ...live, ...c })).toBe(true);
  });

  it('refuses a prepared tx for another chain than the one bound', () => {
    const odd = {
      ...bound,
      prepared: { ...bound.prepared, tx: { ...bound.prepared.tx, chainId: 5 } },
    };
    expect(scopeChanged(odd, live)).toBe(true);
  });
});

describe('nonceChanged', () => {
  it('compares the pending nonce read before signing with the reviewed one', () => {
    expect(nonceChanged(bound, 7)).toBe(false);
    expect(nonceChanged(bound, 8)).toBe(true);
    expect(nonceChanged(bound, 6)).toBe(true);
  });
});

describe('recipientIssue', () => {
  it('refuses the zero address and the token contract', () => {
    expect(recipientIssue('0x' + '0'.repeat(40), null)).toBe('zero');
    expect(recipientIssue(usdc.address!.toLowerCase(), usdc.address)).toBe('contract');
    expect(recipientIssue(` ${usdc.address!} `, usdc.address)).toBe('contract');
    expect(recipientIssue(TO, usdc.address)).toBeNull();
    expect(recipientIssue(TO, null)).toBeNull();
  });
});

describe('endStageOf', () => {
  it('maps every watch result to an end screen', () => {
    expect(endStageOf('success')).toBe('done');
    expect(endStageOf('failed')).toBe('failed');
    expect(endStageOf('replaced')).toBe('replaced');
    expect(endStageOf('pending')).toBe('stuck');
  });
});
