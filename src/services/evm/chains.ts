import chainLogos from 'src/data/evm/chainLogos.json';

export interface EvmChain {
  chainId: number;
  name: string;
}

export const BUILTIN_EVM_CHAINS: readonly EvmChain[] = [
  { chainId: 1, name: 'Ethereum' },
  { chainId: 4663, name: 'Robinhood Chain' },
];

const slugs = chainLogos.chains as Record<string, string>;

export const chainLogoUrl = (chainId: number): string | null => {
  const slug = slugs[String(chainId)];
  return slug ? `/${chainLogos.meta.path.replace('{slug}', slug)}` : null;
};
