// The extension's own page origin: chrome-extension://<id>/ on Chromium, moz-extension://<uuid>/ on
// Firefox. Use this to recognize our own popup/extension-page messages and tabs across browsers -
// the scheme differs and chrome.runtime.id is NOT present in Firefox page URLs (they use a random
// per-install UUID), so hardcoding 'chrome-extension://' or matching runtime.id breaks on Firefox.
export const EXT_BASE_URL = chrome.runtime.getURL('');

export const KNOWN_DAPP_PERMISSIONS = new Set<string>([
  'accounts',
  'public_transactions',
  'contract_calls',
  'contract_views',
  'private_balance_read',
  'private_proofs',
  'private_transfers',
  'private_claims',
]);

// rpc_call is unauthenticated - restrict it to read-only public methods.
export const RPC_CALL_ALLOWED_METHODS = new Set<string>([
  'octra_balance',
  'octra_account',
  'octra_transaction',
  'octra_transactionsByAddress',
  'octra_transactionsByEpoch',
  'octra_recentTransactions',
  'octra_supply',
  'octra_recommendedFee',
  'octra_tokensByAddress',
  'octra_contractAbi',
  'octra_computeContractAddress',
  'octra_stealthOutputs',
  'contract_call',
  'contract_receipt',
  'staging_view',
]);

export const DAPP_CONNECTION_EXPIRY_MS = 24 * 60 * 60 * 1000;
