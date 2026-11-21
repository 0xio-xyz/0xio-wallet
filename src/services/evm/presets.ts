export interface EvmNetworkPreset {
  chainId: number;
  name: string;
  rpcUrl: string;
  nativeSymbol: string;
  nativeName: string;
  explorerUrl: string;
  testnet: boolean;
  logoChainId: number;
}

const main = (
  chainId: number,
  name: string,
  rpcUrl: string,
  explorerUrl: string,
  nativeSymbol = 'ETH',
  nativeName = 'Ether'
): EvmNetworkPreset => ({
  chainId,
  name,
  rpcUrl,
  nativeSymbol,
  nativeName,
  explorerUrl,
  testnet: false,
  logoChainId: chainId,
});

const test = (
  chainId: number,
  name: string,
  rpcUrl: string,
  explorerUrl: string,
  logoChainId: number,
  nativeSymbol = 'ETH',
  nativeName = 'Ether'
): EvmNetworkPreset => ({
  chainId,
  name,
  rpcUrl,
  nativeSymbol,
  nativeName,
  explorerUrl,
  testnet: true,
  logoChainId,
});

export const EVM_NETWORK_PRESETS: readonly EvmNetworkPreset[] = [
  main(8453, 'Base', 'https://base-rpc.publicnode.com', 'https://base.blockscout.com'),
  main(
    42161,
    'Arbitrum One',
    'https://arbitrum-one-rpc.publicnode.com',
    'https://arbitrum.blockscout.com'
  ),
  main(10, 'OP Mainnet', 'https://optimism-rpc.publicnode.com', 'https://optimism.blockscout.com'),
  main(
    137,
    'Polygon PoS',
    'https://polygon-bor-rpc.publicnode.com',
    'https://polygon.blockscout.com',
    'POL',
    'POL'
  ),
  main(
    56,
    'BNB Smart Chain',
    'https://bsc-rpc.publicnode.com',
    'https://bscscan.com',
    'BNB',
    'BNB'
  ),
  main(
    43114,
    'Avalanche C-Chain',
    'https://avalanche-c-chain-rpc.publicnode.com',
    'https://snowtrace.io',
    'AVAX',
    'Avalanche'
  ),
  main(59144, 'Linea', 'https://linea-rpc.publicnode.com', 'https://explorer.linea.build'),
  main(534352, 'Scroll', 'https://scroll-rpc.publicnode.com', 'https://scroll.blockscout.com'),
  main(324, 'zkSync Era', 'https://mainnet.era.zksync.io', 'https://zksync.blockscout.com'),
  main(
    100,
    'Gnosis',
    'https://gnosis-rpc.publicnode.com',
    'https://gnosis.blockscout.com',
    'XDAI',
    'xDai'
  ),
  main(
    42220,
    'Celo',
    'https://celo-rpc.publicnode.com',
    'https://celo.blockscout.com',
    'CELO',
    'Celo'
  ),
  main(
    5000,
    'Mantle',
    'https://mantle-rpc.publicnode.com',
    'https://explorer.mantle.xyz',
    'MNT',
    'Mantle'
  ),
  main(81457, 'Blast', 'https://blast-rpc.publicnode.com', 'https://blastscan.io'),
  main(130, 'Unichain', 'https://unichain-rpc.publicnode.com', 'https://unichain.blockscout.com'),
  main(146, 'Sonic', 'https://sonic-rpc.publicnode.com', 'https://sonicscan.org', 'S', 'Sonic'),
  main(57073, 'Ink', 'https://ink-rpc.publicnode.com', 'https://explorer.inkonchain.com'),
  main(7777777, 'Zora', 'https://rpc.zora.energy', 'https://explorer.zora.energy'),

  test(
    84532,
    'Base Sepolia',
    'https://base-sepolia-rpc.publicnode.com',
    'https://base-sepolia.blockscout.com',
    8453
  ),
  test(
    421614,
    'Arbitrum Sepolia',
    'https://arbitrum-sepolia-rpc.publicnode.com',
    'https://arbitrum-sepolia.blockscout.com',
    42161
  ),
  test(
    11155420,
    'OP Sepolia',
    'https://optimism-sepolia-rpc.publicnode.com',
    'https://optimism-sepolia.blockscout.com',
    10
  ),
  test(
    80002,
    'Polygon Amoy',
    'https://polygon-amoy-bor-rpc.publicnode.com',
    'https://amoy.polygonscan.com',
    137,
    'POL',
    'POL'
  ),
  test(
    97,
    'BNB Smart Chain Testnet',
    'https://bsc-testnet-rpc.publicnode.com',
    'https://testnet.bscscan.com',
    56,
    'tBNB',
    'BNB'
  ),
  test(
    43113,
    'Avalanche Fuji',
    'https://avalanche-fuji-c-chain-rpc.publicnode.com',
    'https://testnet.snowtrace.io',
    43114,
    'AVAX',
    'Avalanche'
  ),
  test(
    59141,
    'Linea Sepolia',
    'https://linea-sepolia-rpc.publicnode.com',
    'https://sepolia.lineascan.build',
    59144
  ),
  test(
    300,
    'zkSync Sepolia',
    'https://sepolia.era.zksync.dev',
    'https://zksync-sepolia.blockscout.com',
    324
  ),
  test(
    10200,
    'Gnosis Chiado',
    'https://gnosis-chiado-rpc.publicnode.com',
    'https://gnosis-chiado.blockscout.com',
    100,
    'XDAI',
    'xDai'
  ),
  test(
    11142220,
    'Celo Sepolia',
    'https://forno.celo-sepolia.celo-testnet.org',
    'https://celo-sepolia.blockscout.com',
    42220,
    'CELO',
    'Celo'
  ),
  test(
    5003,
    'Mantle Sepolia',
    'https://mantle-sepolia.drpc.org',
    'https://explorer.sepolia.mantle.xyz',
    5000,
    'MNT',
    'Mantle'
  ),
  test(
    168587773,
    'Blast Sepolia',
    'https://sepolia.blast.io',
    'https://sepolia.blastscan.io',
    81457
  ),
  test(
    1301,
    'Unichain Sepolia',
    'https://unichain-sepolia-rpc.publicnode.com',
    'https://unichain-sepolia.blockscout.com',
    130
  ),
];

export const presetFor = (chainId: number): EvmNetworkPreset | null =>
  EVM_NETWORK_PRESETS.find((p) => p.chainId === chainId) ?? null;
