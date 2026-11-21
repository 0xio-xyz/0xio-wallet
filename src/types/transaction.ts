export type TransactionDirection = 'incoming' | 'outgoing';

export type TransactionOpType =
  | 'transfer'
  | 'encrypt'
  | 'decrypt'
  | 'private_transfer'
  | 'claim'
  | 'stealth'
  | 'key_switch'
  | 'call'
  | 'deploy';

export type TransactionStatus = 'processing' | 'failed' | 'success' | 'retrying' | 'pending';

export type NetworkId = 'mainnet' | 'devnet' | (string & {});

export interface PendingTransaction {
  from: string;
  to: string;
  amount: number;
  nonce: number;
  message: string;
  timestamp: number;
  type: TransactionDirection;
  opType: TransactionOpType;
  confirmed: boolean;
  pending: boolean;
  txId: string;
  storageKey: string;
  hash?: string;
  serverHash?: string;
  status?: TransactionStatus;
  error?: string;
  failedAt?: number;
  network?: NetworkId;
}

export interface SignedTransaction {
  from: string;
  to_: string;
  amount: string;
  nonce: number;
  ou: string;
  timestamp: number;
  message?: string;
  op_type?: string;
  encrypted_data?: string;
  signature: string;
  public_key: string;
}

export interface TokenTransferInfo {
  recipient: string;
  raw_amount: string;
  contract_address: string;
  kind?: 'token' | 'nft';
  name?: string;
  symbol?: string;
  decimals?: number;
}

export interface TransactionHistoryItem {
  hash: string;
  timestamp: number;
  type: TransactionDirection;
  amount: number;
  from: string;
  to: string;
  address: string;
  nonce: number;
  epoch?: number;
  priority?: string;
  confirmed: boolean;
  status: string;
  source?: 'indexer' | 'rpc';
  message?: string | null;
  opType?: TransactionOpType;
  finality?: string;
  txId?: string;
  pending?: boolean;
  queued?: boolean;
  error?: string;
  failedAt?: number;
  network?: NetworkId;
  token_transfer?: TokenTransferInfo;
  insideCall?: boolean;
  amountUnknown?: boolean;
  callLabel?: string;
  ou?: string;
}

export interface PrivateOutput {
  id: number;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
  claim_pub: string;
  claimed: number;
  epoch_id: number;
}

export interface PrivateTransferData {
  version: number;
  delta_cipher: string;
  commitment: string;
  range_proof_delta: string;
  range_proof_balance: string;
  eph_pub: string;
  stealth_tag: string;
  enc_amount: string;
  claim_pub: string;
  amount_commitment: string;
}

export interface ClaimData {
  version: number;
  output_id: number;
  claim_cipher: string;
  commitment: string;
  claim_secret: string;
  zero_proof: string;
}

export interface QueuedTransaction {
  id: string;
  type: 'broadcast_only';
  opType: TransactionOpType;
  signedTransaction: SignedTransaction;
  from: string;
  to: string;
  amount: number;
  nonce: number;
  message?: string;
  timestamp: number;
  hash?: string;
  txHash?: string;
  status: string;
  addedAt: number;
  attempts: number;
  maxAttempts: number;
  error?: string;
  failedAt?: number;
  completedAt?: number;
  nextRetryAt?: number;
}
