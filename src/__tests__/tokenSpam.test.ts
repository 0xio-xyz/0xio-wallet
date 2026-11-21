import { describe, expect, it } from 'vitest';
import {
  collectionSpamReason,
  evmSpamReason,
  foldConfusables,
  hasBait,
  hasLink,
  impersonatesEvm,
  octraSpamReason,
  tokenShown,
} from 'src/services/tokens/tokenSpam';

const USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
const OTHER = '0x1111111111111111111111111111111111111111';
const OCT_ETHEREUM = '0x4647e1fe715c9e23959022c2416c71867f5a6e80';
const WOCT_DEVNET = 'octCcgs68MFeeG8kpcwpHjdfD1M7tvjLKMvxkKMRkbNPmVs';
const OCT_OTHER = 'octTokenTokenTokenTokenTokenTokenTokenTokenToke';

const unpriced = (name: string, symbol = 'TKN') =>
  evmSpamReason(1, OTHER, { symbol, name, priced: false });

describe('link rule', () => {
  it('finds web addresses in names and symbols', () => {
    for (const name of [
      'Visit https://x',
      'go to www.example',
      't.me/claimbot',
      'USDCgift.xyz',
      'uniswap.io pool',
      'pepe.com',
      'SITE.ORG',
    ]) {
      expect(unpriced(name), name).toBe('link');
    }
    expect(evmSpamReason(1, OTHER, { symbol: 'abc.network', name: 'Token', priced: false })).toBe(
      'link'
    );
  });

  it('leaves dots that are not domains alone', () => {
    for (const name of [
      'USDC.e',
      'U.S. Dollar',
      'SPX2.0',
      'Wait...yes',
      'Token v1.2',
      'Inc. Holdings',
    ]) {
      expect(hasLink(name), name).toBe(false);
    }
  });

  it('reads a look-alike dot as a dot', () => {
    expect(hasLink(`Claim at site${String.fromCharCode(0x2024)}com`)).toBe(true);
  });

  it('reports a link before bait', () => {
    expect(unpriced('Claim at claim.xyz')).toBe('link');
  });
});

describe('bait rule', () => {
  it('finds bait words, glued or spaced, any case', () => {
    for (const name of [
      'Claim your tokens',
      'ClaimReward',
      'REWARDS',
      'ETH Airdrop',
      'freeairdropnow',
      'FREE money',
      'Gifts for you',
      'Redeem now',
      'You are Eligible',
      'Voucher',
      'Bonus 500',
      'Visit us',
    ]) {
      expect(unpriced(name), name).toBe('bait');
    }
  });

  it('does not flag words that only start like bait', () => {
    for (const name of ['Freedom Coin', 'Reclaim', 'Rewardable', 'Giftly', 'Visitor']) {
      expect(hasBait(name), name).toBe(false);
    }
  });

  it('folds a Cyrillic letter inside a bait word', () => {
    expect(hasBait('Clаim')).toBe(true);
  });
});

describe('priced exemption', () => {
  it('a token with a market price may carry its site or a bait word in its name', () => {
    expect(evmSpamReason(1, OTHER, { symbol: 'YFI', name: 'yearn.finance', priced: true })).toBe(
      null
    );
    expect(evmSpamReason(1, OTHER, { symbol: 'RWD', name: 'Rewards', priced: true })).toBe(null);
    expect(evmSpamReason(1, OTHER, { symbol: 'YFI', name: 'yearn.finance', priced: false })).toBe(
      'link'
    );
  });

  it('a price does not excuse an impersonation', () => {
    expect(evmSpamReason(1, OTHER, { symbol: 'USDC', name: 'USD Coin', priced: true })).toBe(
      'impersonation'
    );
  });
});

describe('impersonation with confusables', () => {
  it('folds Cyrillic, Greek and fullwidth letters to ASCII', () => {
    expect(foldConfusables('UЅDC')).toBe('USDC');
    expect(foldConfusables('ＵＳＤＴ')).toBe('USDT');
    expect(foldConfusables('ΕΤΗ')).toBe('ETH');
  });

  it('flags a well-known symbol on another contract', () => {
    expect(impersonatesEvm(1, 'USDC', USDC)).toBe(false);
    expect(impersonatesEvm(1, 'USDC', OTHER)).toBe(true);
    expect(impersonatesEvm(1, 'UЅDC', OTHER)).toBe(true);
    expect(impersonatesEvm(1, 'uѕdс', OTHER)).toBe(true);
    expect(impersonatesEvm(1, 'ＵＳＤＴ', OTHER)).toBe(true);
    expect(impersonatesEvm(4663, ' USDC', OTHER)).toBe(true);
    expect(impersonatesEvm(1, 'ΕΤΗ', OTHER)).toBe(true);
    expect(impersonatesEvm(4663, 'wETH', OTHER)).toBe(true);
    expect(impersonatesEvm(42161, 'USDC.e', OTHER)).toBe(false);
    expect(impersonatesEvm(1, 'USDCX', OTHER)).toBe(false);
  });

  it('judges OCT and WOCT on every chain, other symbols only on listed chains', () => {
    expect(impersonatesEvm(1, 'wOCT', OCT_ETHEREUM)).toBe(false);
    expect(impersonatesEvm(1, 'OCT', OTHER)).toBe(true);
    expect(impersonatesEvm(4663, 'WОCT', OTHER)).toBe(true);
    expect(impersonatesEvm(999, 'OCT', OCT_ETHEREUM)).toBe(true);
    expect(impersonatesEvm(56, 'USDC', OTHER)).toBe(false);
    expect(impersonatesEvm(1, 'constructor', OTHER)).toBe(false);
  });

  it('flags OCT and WOCT on Octra contracts other than the known WOCT', () => {
    const at = (networkId: string, contract: string, symbol: string) =>
      octraSpamReason(networkId, contract, { symbol, name: symbol, priced: false });
    expect(at('devnet', WOCT_DEVNET, 'WOCT')).toBe(null);
    expect(at('devnet', OCT_OTHER, 'WOCT')).toBe('impersonation');
    expect(at('devnet', OCT_OTHER, 'OCT')).toBe('impersonation');
    expect(at('mainnet', OCT_OTHER, 'OCT')).toBe('impersonation');
    expect(at('devnet', OCT_OTHER, 'GOOD')).toBe(null);
    expect(at('devnet', OCT_OTHER, 'visit x.com')).toBe('link');
  });
});

describe('collections and switches', () => {
  it('judges collection names by link and bait only', () => {
    expect(collectionSpamReason('Free Mint at nftdrop.xyz')).toBe('link');
    expect(collectionSpamReason('Claim your reward')).toBe('bait');
    expect(collectionSpamReason('Bored Apes')).toBe(null);
    expect(collectionSpamReason(null)).toBe(null);
  });

  it("the user's switch wins over the verdict", () => {
    expect(tokenShown(undefined, null)).toBe(true);
    expect(tokenShown(undefined, 'bait')).toBe(false);
    expect(tokenShown(true, 'bait')).toBe(true);
    expect(tokenShown(false, null)).toBe(false);
  });
});
