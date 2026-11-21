export interface ServiceResult<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
  status?: number;
  text?: string;
  json?: T;
}

export interface BalanceResult {
  success: boolean;
  balance: number | null;
  nonce: number | null;
  /** octra_balance pending_nonce: absent when the node left it out, null when it was malformed. */
  pendingNonce?: number | null;
  error?: string;
  cached?: boolean;
}

export interface EncryptedBalanceResult {
  success: boolean;
  public: number;
  publicRaw: number;
  encrypted: number;
  encryptedRaw: number;
  total: number;
  cipher?: string;
  cipherCorrupted?: boolean;
  /** Cipher written by an older (pre-canonical-parity) build: readable via the legacy fallback
   *  keys, but private ops must not touch it until it can be re-encrypted. */
  cipherLegacy?: boolean;
  decryptSkipped?: boolean;
  error?: string;
  readAt?: number;
}

export type TransactionFinality = 'pending' | 'confirmed' | 'rejected';

export type TransactionErrorType =
  | 'malformed_transaction'
  | 'invalid_address'
  | 'self_transfer'
  | 'sender_not_found'
  | 'invalid_signature'
  | 'duplicate_transaction'
  | 'nonce_too_far'
  | 'insufficient_balance'
  | 'internal_error'
  | 'nonce_used'
  | 'not_accepted'
  | 'rejected'
  | 'too_large';

export interface TransactionBroadcastResult {
  success: boolean;
  txHash?: string;
  finality?: TransactionFinality;
  message?: string;
  error?: string;
  errorType?: TransactionErrorType;
  /** Signed and handed off, but no verdict came back: it may still land. */
  outcomeUnknown?: boolean;
}

export interface TransactionStatusResult {
  status: string;
  confirmed: boolean;
  finality?: TransactionFinality;
  epoch?: number;
  txHash?: string;
  from?: string;
  to?: string;
  amount?: number;
  timestamp?: number;
  errorType?: string;
  errorReason?: string;
}

export interface BatchTransactionResultItem {
  status: 'accepted' | 'rejected';
  hash?: string;
  tx_hash?: string;
  finality?: TransactionFinality;
  nonce?: number;
  error?: {
    type: TransactionErrorType;
    reason: string;
  };
}

export interface BatchTransactionResult {
  success: boolean;
  total: number;
  accepted: number;
  rejected: number;
  results: BatchTransactionResultItem[];
  error?: string;
  /** The batch left for the node and no verdict came back: any of it may still land. */
  outcomeUnknown?: boolean;
}

export interface NetworkConfig {
  name: string;
  rpc_url: string;
  explorer_url: string;
  explorer_address_url: string;
  color: string;
  default: boolean;
  editable: boolean;
}
