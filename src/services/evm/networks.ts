export interface EvmNetwork {
  chainId: number;
  name: string;
  rpcUrl: string;
  testnet: boolean;
  nativeSymbol: string;
  nativeName: string;
  logoChainId: number;
}

const MAINNETS: readonly EvmNetwork[] = [
  {
    chainId: 1,
    name: 'Ethereum',
    rpcUrl: 'https://ethereum-rpc.publicnode.com',
    testnet: false,
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    logoChainId: 1,
  },
  {
    chainId: 4663,
    name: 'Robinhood Chain',
    rpcUrl: 'https://robinhood-rpc.publicnode.com',
    testnet: false,
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    logoChainId: 4663,
  },
];

const TESTNETS: readonly EvmNetwork[] = [
  {
    chainId: 11155111,
    name: 'Sepolia',
    rpcUrl: 'https://ethereum-sepolia-rpc.publicnode.com',
    testnet: true,
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    logoChainId: 1,
  },
  {
    chainId: 46630,
    name: 'Robinhood Chain Testnet',
    rpcUrl: 'https://robinhood-sepolia-rpc.publicnode.com',
    testnet: true,
    nativeSymbol: 'ETH',
    nativeName: 'Ether',
    logoChainId: 4663,
  },
];

export function evmNetworksFor(octraNetworkId: string | null | undefined): EvmNetwork[] {
  return (octraNetworkId === 'devnet' ? TESTNETS : MAINNETS).map((n) => ({ ...n }));
}
