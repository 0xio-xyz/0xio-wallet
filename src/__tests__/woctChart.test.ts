import { describe, expect, it } from 'vitest';
import { chartUrl, chartsAsOct, llamaKey } from 'src/services/evm/prices';
import { BRIDGE } from 'src/services/bridge/constants';

describe('wOCT chart', () => {
  it('charts wOCT on Ethereum as OCT, in any address case', () => {
    expect(chartsAsOct(1, { address: BRIDGE.wOCT })).toBe(true);
    expect(chartsAsOct(1, { address: BRIDGE.wOCT.toLowerCase() })).toBe(true);
    expect(chartsAsOct(8453, { address: BRIDGE.wOCT })).toBe(false);
    expect(chartsAsOct(1, { address: null })).toBe(false);
    expect(chartsAsOct(1, { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' })).toBe(false);
  });

  it('asks DefiLlama with a search width matched to the period', () => {
    const key = llamaKey(1, { address: '0xdAC17F958D2ee523a2206206994597C13D831ec7' })!;
    const now = 1_800_000_000;
    expect(chartUrl(key, '1D', now)).toBe(
      `https://coins.llama.fi/chart/${key}?start=${now - 86_400}&span=48&period=30m&searchWidth=30m`
    );
    expect(chartUrl(key, '7D', now)).toContain('&period=2h&searchWidth=2h');
    expect(chartUrl(key, '1M', now)).toContain('&period=12h&searchWidth=12h');
  });
});
