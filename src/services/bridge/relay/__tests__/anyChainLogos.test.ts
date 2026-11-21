import { describe, expect, it } from 'vitest';
import { chainLogos, NATIVE_TOKEN, tokenLogos, type AnyChain, type AnyToken } from '../anyChain';

const PROXY = 'https://rpc-proxy.0xio.xyz/bridge/any/logo?u=';

const token = (address: string, logo: string | null): AnyToken => ({
  address,
  symbol: 'T',
  name: 'Token',
  decimals: 18,
  logo,
});

const chain = (id: number, icon: string | null): AnyChain => ({
  id,
  name: 'Chain',
  icon,
  explorer: null,
  rpc: 'https://rpc.example',
  tokens: [],
});

describe('any chain logos', () => {
  it('prefers the bundled chain logo, then the proxied icon', () => {
    const icon = 'https://assets.relay.link/icons/8453/light.png';
    expect(chainLogos(chain(8453, icon))).toEqual([
      '/chains/evm/base.webp',
      PROXY + encodeURIComponent(icon),
    ]);
    expect(chainLogos(chain(999_999_999, icon))).toEqual([PROXY + encodeURIComponent(icon)]);
    expect(chainLogos(chain(999_999_999, null))).toEqual([]);
    expect(chainLogos(chain(999_999_999, 'http://insecure.example/a.png'))).toEqual([]);
  });

  it('uses the bundled token logo, the chain logo for the native coin, else the proxied logo', () => {
    const base = chain(8453, null);
    expect(tokenLogos(base, token(NATIVE_TOKEN, null))).toEqual(['/chains/evm/base.webp']);
    expect(
      tokenLogos(
        chain(1, null),
        token('0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', 'https://x.example/u.png')
      )
    ).toEqual(['/tokens/evm/1-0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48.webp']);
    const logo = 'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694';
    expect(tokenLogos(base, token('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', logo))).toEqual([
      PROXY + encodeURIComponent(logo),
    ]);
    expect(tokenLogos(base, token('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', null))).toEqual([]);
  });
});
