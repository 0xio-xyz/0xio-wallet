import { describe, expect, it } from 'vitest';
import {
  BoundedCache,
  callAction,
  callTitle,
  isUnlimited,
  knownOctraContract,
  methodRow,
  methodWords,
  readableMethod,
  safeContractName,
} from '../callReading';

const t = (key: string, o?: Record<string, unknown>) =>
  String(o?.defaultValue ?? key).replace(/\{\{(\w+)\}\}/g, (_, k) => String(o?.[k] ?? ''));

describe('method labels', () => {
  it('maps Octra and EVM method names to one action', () => {
    const cases: [string, string][] = [
      ['approve', 'approve'],
      ['increaseAllowance', 'approve'],
      ['setApprovalForAll', 'approve'],
      ['transfer', 'transfer'],
      ['safe_transfer_from', 'transfer'],
      ['swapExactTokensForETH', 'swap'],
      ['exactInputSingle', 'swap'],
      ['multicall', 'multicall'],
      ['aggregate3', 'multicall'],
      ['depositTransaction', 'bridge'],
      ['lock_to_eth', 'bridge'],
      ['burnToOctra', 'bridge'],
      ['verifyAndMint', 'claim'],
      ['claim_rewards', 'claim'],
      ['mint_nft', 'mint'],
      ['deposit_bond', 'deposit'],
      ['emergency_withdraw_bond', 'withdraw'],
      ['list_nft', 'list'],
      ['buy_nft', 'buy'],
      ['unstake', 'unstake'],
      ['refund_stale_fill', 'refund'],
      ['burn', 'burn'],
    ];
    for (const [method, action] of cases)
      expect([method, callAction(method)]).toEqual([method, action]);
  });

  it('reads a zero approval and a cleared operator as a revoke', () => {
    expect(callAction('approve', { args: ['0xabc', '0'] })).toBe('revoke');
    expect(callAction('approve', { args: ['0xabc', '5'] })).toBe('approve');
    expect(callAction('setApprovalForAll', { args: ['0xabc', 'false'] })).toBe('revoke');
    expect(callAction('setApprovalForAll', { args: ['0xabc', 'true'] })).toBe('approve');
    expect(callAction('approve')).toBe('approve');
  });

  it('reads a swap vault lock as a swap and any other lock as its words', () => {
    expect(callTitle('lock', t, { swapVault: true })).toBe('Swap');
    expect(callTitle('lock', t)).toBe('Lock');
  });

  it('falls back to the method in plain words, then to Contract call', () => {
    expect(callTitle('settle', t)).toBe('Settle');
    expect(callTitle('cancel_listing', t)).toBe('Cancel Listing');
    expect(callTitle('set_nft_price', t)).toBe('Set NFT Price');
    expect(callTitle('setTreasuryAddress', t)).toBe('Set Treasury Address');
    expect(callTitle('0x64efe352', t)).toBe('Contract call');
    expect(callTitle(null, t)).toBe('Contract call');
    expect(callTitle(undefined, t)).toBe('Contract call');
  });

  it('keeps acronyms and drops signatures', () => {
    expect(methodWords('swapExactTokensForETH')).toBe('Swap Exact Tokens For ETH');
    expect(methodWords('transfer(address to, uint256 value)')).toBe('Transfer');
    expect(readableMethod('0x095ea7b3')).toBeNull();
    expect(readableMethod('approve(address,uint256)')).toBe('approve');
  });

  it('shows a method row only when it says more than the title', () => {
    expect(methodRow('approve', 'Approve')).toBeNull();
    expect(methodRow('lock', 'Swap')).toBe('Lock');
    expect(methodRow('0x12345678', 'Contract call')).toBeNull();
  });
});

describe('amounts and names', () => {
  it('calls max uint256 and the site default unlimited', () => {
    expect(isUnlimited(((1n << 256n) - 1n).toString())).toBe(true);
    expect(isUnlimited((1n << 255n).toString())).toBe(true);
    expect(isUnlimited('1000000')).toBe(false);
    expect(isUnlimited('abc')).toBe(false);
  });

  it('drops contract names that read like a lure', () => {
    expect(safeContractName('UniversalRouter')).toBe('UniversalRouter');
    expect(safeContractName('Visit usdc-claim.com')).toBeNull();
    expect(safeContractName('Airdrop Distributor')).toBeNull();
    expect(safeContractName('')).toBeNull();
  });

  it('names known Octra contracts only on their own network', () => {
    const vault = 'octHqBuw3TGsgeGpu6GiumRTjQwc8VCRAo1ANhy5zL4ZVPc';
    expect(knownOctraContract('devnet', vault)).toMatchObject({ swapVault: true });
    expect(knownOctraContract('mainnet', vault)).toBeNull();
  });

  it('keeps a metadata cache bounded, dropping the oldest', () => {
    const cache = new BoundedCache<string>(2);
    cache.set('mainnet:a', '1');
    cache.set('devnet:a', '2');
    cache.set('mainnet:a', '3');
    cache.set('mainnet:b', '4');
    expect(cache.size).toBe(2);
    expect(cache.get('devnet:a')).toBeUndefined();
    expect(cache.get('mainnet:a')).toBe('3');
  });
});
