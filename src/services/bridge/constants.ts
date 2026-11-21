export const BRIDGE = {
  wOCT: '0x4647e1fE715c9e23959022C2416C71867F5a6E80',
  ethBridge: '0xE7eD69b852fd2a1406080B26A37e8E04e7dA4caE',
  lightClient: '0xC01cA57dc7f7C4B6f1B6b87B85D79e5ddf0dF55d',
  octraVault: 'oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq',
  ethChainId: 1,
  decimals: 6,
  minLockRaw: 1_000_000n,
  claimGas: 0x60000n,
  signerUrl: 'https://rpc-proxy.0xio.xyz/bridge/signer',
} as const;

export const BRIDGE_MSG = {
  version: 1,
  direction: 0,
  srcChainId: 7777n,
  dstChainId: 1n,
  srcBridgeId: '0x381ab73c25fb8d4ec4c03e15dd630fab75b410afd90a9276ab81df81c38d2a8b',
  dstBridgeId: '0xab33480ea300316d03f76278f05f08f011d41d60f5d49c6ff6d8489fbd60c794',
  tokenId: '0x412ec1126381d672a9f42b8612e4bc9ee64f5b6467b991e61110203549cdd6de',
} as const;

export const SELECTOR = {
  verifyAndMint: '0x5d5158ed',
  burnToOctra: '0xe3e3aed0',
  approve: '0x095ea7b3',
  allowance: '0xdd62ed3e',
  latestEpoch: '0x9cb118bf',
  paused: '0x5c975abb',
  mintCapDaily: '0x7c215818',
  mintCapPerTx: '0x77ca7344',
  mintedToday: '0xb7c140dd',
} as const;

export const TOPIC = {
  burnToOctra: '0xfaa9b3e2244d80066df764926dce8b97fa7077d982b97f52195a39950fc100b4',
} as const;

export const CLAIM_REVERT: Record<string, 'claimed' | 'waiting' | 'cap' | 'proof'> = {
  '0xb5a78004': 'claimed',
  '0xa2ad39b9': 'waiting',
  '0xa4875a49': 'cap',
  '0x09bde339': 'proof',
};
