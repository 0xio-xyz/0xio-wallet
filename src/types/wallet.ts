export interface WalletMetadata {
  source: 'generated' | 'watch' | 'imported';
  createdAt: number;
  isPadded: boolean;
  /** The 0x address from the same phrase. Only the address is kept; the key is derived when used. */
  evm?: { enabled: boolean; address: string; index: number; sourceWalletId?: string };
}

export interface Wallet {
  id: string;
  name: string;
  address: string;
  type: 'standard' | 'watch';
  privateKey: string | null;
  mnemonic: string[] | null;
  publicKey: string | null;
  isActive: boolean;
  metadata: WalletMetadata;
}

export interface GeneratedKeyPair {
  mnemonic: string[];
  seed_hex: string;
  master_chain_hex: string;
  private_key_hex: string;
  public_key_hex: string;
  private_key_b64: string;
  public_key_b64: string;
  address: string;
}

export interface RecoveryCandidate {
  label: string;
  address: string;
  canonicalAddress: string;
  privateKey: string;
  publicKey: string;
  mnemonic: string[];
  isPadded: boolean;
  addressWarning: string | null;
}

export interface ImportedWallet {
  private_key_b64: string;
  public_key_b64: string;
  address: string;
  canonicalAddress: string;
  isPadded: boolean;
  addressWarning: string | null;
}
