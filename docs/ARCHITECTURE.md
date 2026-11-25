# Architecture

A public overview of how 0xio Wallet holds keys, runs the PVAC privacy engine, signs transactions and talks to websites. For build steps see the [README](../README.md). Guides by area: [background](background.md), [UI](ui.md), [transactions](transactions.md), [privacy](privacy.md), [translation](translation.md), [sites on 0xio Desktop](DESKTOP_RELAY.md).

## Code map

| Path | Holds |
|------|-------|
| `src/background/` | Service worker: `handlers/` (site requests by kind) and `services/` (queue, approvals, connections, relay) |
| `src/content/` | `index.ts` (isolated world) and `injected.ts` (page provider, MAIN world) |
| `src/features/` | Screens by area: `wallet`, `transactions`, `privacy`, `bridge`, `dapp`, `settings`, `security` |
| `src/services/` | Domain logic by area: `bridge`, `contracts`, `crypto`, `desktop`, `evm`, `names`, `network`, `privacy`, `pvac`, `tokens`, `wallet` |
| `src/lib/` | Self-contained code with no wallet knowledge: router, QR, encoding, sanitizer, wallet art |
| `src/utils/` | Shared helpers that know the wallet (config, amounts, Octra transaction formats in `utils/octra/`) |
| `src/hooks/`, `src/contexts/`, `src/shared/ui/` | React hooks, contexts and shared components |
| `src/i18n/` | Translations |
| `src/renderer/`, `renderer.html` | Sandboxed living NFT renderer |
| `public/` | PVAC WASM, offscreen document and workers, icons |

## Keys

| Component | Spec |
|-----------|------|
| Mnemonic | BIP39, 12 words (128-bit entropy) |
| Mnemonic to seed | PBKDF2-SHA512, 2048 rounds (BIP39) |
| Octra key | `HMAC-SHA512("Octra seed", seed)`: the first 32 bytes are the Ed25519 private key seed; no path derivation |
| Signing | Ed25519 (tweetnacl) |
| Octra address | `oct` + Base58(SHA-256(public key)) |
| EVM key | secp256k1 at `m/44'/60'/0'/0/i` from the same phrase, EIP-55 address |
| PVAC seed | `sha256("OCTRA_PVAC_MASTER_V1" \|\| wallet seed)` |

Only the EVM address is stored. The EVM private key is derived for a single signature, checked against that address and wiped (`src/services/evm/signer.ts`). A wallet imported from an Octra private key has no EVM key.

## Vault

- Wallets at rest are sealed with AES-256-GCM under a random vault key. The vault key is wrapped by a key derived from the password with PBKDF2-SHA256, 900,000 iterations (`src/services/crypto/vaultKey.ts`). Vaults sealed with 100,000 iterations are upgraded on the next unlock.
- While unlocked, `chrome.storage.session` (memory only, cleared when the browser closes) holds the vault key, never the password.
- After 5 failed unlocks the password is locked out for 30 seconds, doubling with each further failure.
- The wallet locks itself after 5 minutes without activity by default; the worker checks this on an alarm.

## PVAC privacy engine

PVAC-HFHE keeps an account's private balance on chain as a ciphertext (`hfhe_v1|<base64>`). The network adds and subtracts ciphertexts without reading them; only the key holder decrypts. Each private operation carries proofs:

- **Commitment**: a Pedersen commitment (Ristretto255) to the amount with a random 32-byte blinding.
- **Zero proof** (`zkzp_v2|...`): binds the ciphertext to the commitment.
- **Range proof** (`rp_v1|...`): 64 bit circuits plus one linear combination, proving a value is not negative.

The engine is a Rust port of the PVAC engine in Octra Labs' [webcli](https://github.com/octra-labs/webcli), compiled to WebAssembly and shipped in `public/` and `src/wasm/`. `PvacManager` (`src/services/pvac/PvacManager.ts`) runs it on a paired 0xio Desktop when one is running, else in WASM workers inside the offscreen document (Chrome), else in web workers the extension starts (Firefox). The WASM is loaded same origin through `chrome.runtime.getURL()`. Each request to the offscreen workers carries a fingerprint of the wallet seed and is refused when it names another seed. See [privacy.md](privacy.md).

### Pairing with 0xio Desktop

The extension sends the PVAC seed, never the signing key, only to a desktop that proved it is the one the user paired with. Protocol `0xio-pair-v1` (`src/services/desktop/desktopPairing.ts`, `desktopLink.ts`), over `ws://127.0.0.1:19345`:

- **Pairing, once:** an ephemeral X25519 exchange (`auth_pair`). Both sides compute `T = sha256("0xio-pair-v1" || 0 || desktop_id || 0 || client_id || 0 || epk_e || epk_d)`, show the code `HMAC(shared, "0xio-pair-code" || T)` (first 4 bytes, mod 1,000,000) and, once the user approves on the desktop, keep `secret = HMAC(shared, "0xio-pair-secret" || T)`. A program in the middle runs two exchanges, so the two screens show different codes.
- **Every connection:** `auth_hello` with a fresh extension nonce; the desktop answers with its own nonce and `HMAC(secret, "0xio-auth-v1" || 0 || "desktop" || 0 || client_id || 0 || desktop_id || 0 || nonce_e || nonce_d)`. The extension checks it, then proves itself the same way with role `extension` (`auth_prove`). Only then does it send the PVAC seed (`init`). The role keeps one proof from being reflected as the other; the nonces stop replays.
- **Storage:** `client_id` and the pairing secret sit in `chrome.storage.local`, outside the vault: the link must outlive a password change, and the secret opens no wallet.
- **Failure:** a desktop that does not prove the secret, holds no pairing or predates pairing gets nothing, and proofs run in the browser. The extension never sends `init` to an unpaired desktop.

## Private operations

**Encrypt (public to private)**

1. Encrypt the amount with PVAC; make a random blinding, the Pedersen commitment and the zero proof.
2. Sign a transaction with `op_type: encrypt` and `encrypted_data` = `{ cipher, amount_commitment, zero_proof, blinding }`.
3. The network adds the ciphertext to the encrypted balance; the public balance drops by the amount.

**Decrypt (private to public)**

1. Encrypt the amount, commit to it and make the zero proof as above.
2. Read the current encrypted balance, subtract the amount homomorphically and prove the remainder is not negative (`range_proof_balance`).
3. Sign with `op_type: decrypt`; the network checks the proofs and moves the amount to the public balance.

**View the encrypted balance**

1. Sign `octra_encryptedBalance|<address>` with the Ed25519 key.
2. Call `octra_encryptedBalance([address, signature, publicKey])` and decrypt the returned ciphertext locally.

**Private send (stealth)**

1. Read the recipient's view key (`octra_viewPubkey`) and make an ephemeral x25519 key pair; `shared = SHA-256(x25519(eph_sk, view_pub))`.
2. Derive `stealth_tag = SHA-256(shared || "OCTRA_STEALTH_TAG_V1")[:16]`, `claim_secret = SHA-256(shared || "OCTRA_CLAIM_SECRET_V1")` and `claim_pub = SHA-256(claim_secret || recipient || "OCTRA_CLAIM_BIND_V1")`.
3. Encrypt `amount || blinding` for the recipient with AES-256-GCM under `shared`, and the amount with PVAC.
4. Prove the amount and the sender's new balance are in range, commit to the amount, and sign with `op_type: stealth` (`stealth_data` version 5).

**Scan and claim**

1. Read stealth outputs (paged where the node supports it, else in one pass) from a stored point per network and wallet.
2. For each output, derive the view key from the Ed25519 key, recompute the shared secret and tag, and open the AES-GCM amount when the tag matches.
3. To claim, re-read the output, encrypt the amount with PVAC, commit to it, make the zero proof and sign with `op_type: claim` including `claim_secret`.
4. A claim is sent only for an output the node reads as unspent. Claims are recorded per network and address before they leave (`src/services/privacy/claimLedger.ts`), and an open claim is resent only as its saved signed bytes.

Every private operation computes its proofs first, then takes its nonce, then signs and sends.

## Transaction signing

Every Octra transaction is signed with Ed25519 over the exact text the node rebuilds (`txSigningJson` in `src/utils/octra/txHash.ts`):

```
{from, to_, amount, nonce, ou, timestamp, op_type[, encrypted_data][, message]}
```

- `amount` and `ou` are plain decimal digits in micro OCT and OU with leading zeros stripped; anything else is refused before signing.
- `timestamp` is seconds in the shortest 16 or 17 digit form, with `.0` on a whole number.
- Strings escape `"`, `\`, `\b \f \n \r \t` and every other control character and DEL as `\u00xx`.
- The signed transaction adds `signature` (base64 Ed25519) and `public_key` (base64).

**Hash.** `tx_hash` is sha256 of `{from, to_, amount, nonce, ou, timestamp, signature, op_type, public_key, message, encrypted_data}` with empty optional fields as `null` (`computeTxHash`). The wallet computes it for every submit and tracks the node's hash.

**Nonce.** The next nonce builds on `octra_balance` `pending_nonce` when the node gives it, else on the confirmed nonce raised to the highest nonce this address holds in the staging pool; an unreadable staging pool blocks the send. Reservations are kept per network and address, and a nonce is released only on a definite rejection, never on a lost reply. A nonce the node called used (code 112) is held back for two minutes.

**Submit errors.** Codes 107, 110, 117 and -32005 mean not accepted: the same signed bytes are sent again, three tries in all. 112 means the nonce was used: the user reviews again and nothing is re-signed. Every other rejection is final.

The review, fee and scope rules are in [transactions.md](transactions.md).

## Websites

### Injected providers

`src/content/injected.ts` runs in the page and defines:

- `window.octra`: `request({ method, params })` with `octra_requestAccounts`, `octra_accounts`, `octra_networkInfo`, `octra_permissions`, `octra_switchNetwork`, `octra_signMessage`, `octra_sendTransaction`, `octra_signTransaction`, `octra_callContract`, `octra_callContractView`, `octra_deployContract`, the private methods (`octra_getPrivateBalance`, `octra_encryptBalance`, `octra_decryptBalance`, `octra_sendPrivateTransfer`, `octra_scanStealth`, `octra_claimPrivateTransfer`, `octra_registerPrivateViewKey` and others), plus `on` and `removeListener`. It is also pushed to `window.octraProviders`.
- `window.wallet0xio` (also `window.ZeroXIOWallet`, and `window.wallet` when the page has none): one method per call, such as `connect`, `getBalance`, `sendTransaction`, `signMessage`, `callContract`, `encryptBalance`, `sendPrivateTransfer` and `claimPrivateTransfer`.
- `window.ethereum` when the page has none, announced through EIP-6963 as rdns `xyz.0xio.wallet`.
- Presence: `0xio:announceWallet` with `{ protocol: 2, kind: 'extension', version, name }` at document start and on every `0xio:requestWallet`. It never carries the lock state, address, network or connection.

Requests travel over a private `MessageChannel` port to the content script and on to the worker, which enforces the permission each method needs: `accounts`, `public_transactions`, `contract_calls`, `contract_views`, `private_balance_read`, `private_proofs`, `private_transfers`, `private_claims`. See [background.md](background.md).

### Watch-only wallets

A watch-only wallet connects and reads but never signs. Connection answers carry `canSign`; every signing method answers `WATCH_ONLY` (4100 through `window.octra`).

### Events

`transactionConfirmed` and `transactionFailed` go only to the site whose request queued the transaction, while it is connected and on the signing wallet. `balanceChanged` goes to the sites on that wallet, `accountChanged` to the site that moved, and `networkChanged`, `extensionLocked` and `extensionUnlocked` to every connected site. No event goes to every tab.

### Approvals

Signing requests open a review window showing the site's origin and the signing wallet. Closing the window rejects. An unanswered review closes after 5 minutes (`USER_REJECTED`, `details.status: 'expired'`) or when the requesting page goes away. One review is open at a time.

### Request lifecycle (wallet protocol 2)

Sites on SDK 2.13.0 and later follow each review request by an id (`src/background/services/requestLifecycle.ts`); older sites keep protocol 1.

- `wallet_hello` answers `{ protocol: 2, kind: 'extension', version, capabilities }` for any page.
- A review method sent with `v: 2` and `rid` (32 lowercase hex characters) gets a record keyed by the sender's origin and the id, kept in `chrome.storage.session` for 24 hours. Per site at most 64 records and 8 open ones.
- States: `pending`, `locked`, `review_open`, `signing`, `submitted`, `confirmed`, `failed`, `completed`, `rejected`, `expired`. A final state never changes.
- The same id with the same method, params and network joins the request in flight or returns its stored answer; a different request under that id gets `REQUEST_ID_REUSED`. Nothing runs twice.
- `request_status { rid }` reads the record; `cancel_request { rid }` closes the site's own open review. `requestUpdate` events go only to the tab and frame that sent the request.
- After `submitted` the worker watches `octra_transaction` on the transaction's own network for up to 10 minutes.

### Sites on 0xio Desktop

A site can choose to sign with the 0xio Desktop menu bar wallet. The worker then relays its Octra requests over the paired session and never signs for it locally. See [DESKTOP_RELAY.md](DESKTOP_RELAY.md).

## EVM

One 0x address per account, on Ethereum and Robinhood Chain (Sepolia and Robinhood Chain Testnet beside devnet) plus networks the user adds after their RPC answers the expected chain id. Sends are EIP-1559 type 2 transactions with a review showing the maximum fee; the review is bound to the wallet, address, chain and RPC, and the nonce is read again before signing.

Websites get an EIP-1193 provider, announced through EIP-6963. Requests go to `src/background/handlers/evmRequest.ts`.

| Kind | Methods |
|------|---------|
| Review first | `eth_requestAccounts`, `wallet_requestPermissions`, `eth_sendTransaction`, `personal_sign`, `eth_signTypedData_v4`, `wallet_switchEthereumChain`, `wallet_addEthereumChain`, `wallet_watchAsset` |
| Answered locally | `eth_chainId`, `net_version`, `eth_accounts`, `wallet_getPermissions`, `wallet_getCapabilities`, `web3_sha3`, `net_listening` |
| Forwarded to the site's chain | `eth_call`, `eth_getBalance`, `eth_estimateGas`, receipts, logs, blocks, filters and the other read methods |
| Refused (4200) | `eth_sign`, `eth_signTransaction`, `eth_sendRawTransaction`, older typed data versions, `wallet_sendCalls` and any unknown method |

`eth_accounts` answers only the wallet the site uses, so a site never learns which other wallets are connected to it, and answers `[]` while locked.

## Networks

| Network | RPC | Explorer |
|---------|-----|----------|
| Mainnet | `https://octra.network` | `https://octrascan.io` |
| Devnet | `https://devnet.octrascan.io` | `https://devnet.octrascan.io` |
| Custom | User configured | User configured |

Every node call goes through `src/services/network/rpcExchange.ts`. Reads retry on capacity and network faults with backoff (0.25 to 4 seconds, up to 25 seconds in all); writes retry only while every try is provably unsent. At most 4 calls are in flight per extension context. The RPC proxy is opt-in and never a fallback.

| Method | Purpose |
|--------|---------|
| `octra_balance` | Public balance and nonce |
| `octra_account` | Recent transaction hashes |
| `octra_transaction` | Transaction by hash |
| `octra_submit`, `octra_submitBatch` | Broadcast signed transactions |
| `octra_recommendedFee` | Live fee quote per operation |
| `octra_publicKey` | Ed25519 public key of an address |
| `octra_viewPubkey` | Curve25519 view key (stealth) |
| `octra_pvacPubkey` | Registered PVAC public key |
| `octra_registerPvacPubkey` | Register a PVAC public key |
| `octra_pvacMigrationStatus` | Private balance state for an address |
| `octra_encryptedBalance` | Encrypted balance ciphertext |
| `octra_stealthOutputs` | All stealth outputs (one pass) |
| `octra_stealthOutputsPage` | Stealth outputs page by page, where the node has it |
| `octra_stealthOutputsById` | One stealth output and its claimed state |
| `octra_tokensByAddress` | Token holdings, paged |

## Operation types

| `op_type` | Direction | Description |
|-----------|-----------|-------------|
| `standard` | Public to public | OCT transfer |
| `encrypt` | Public to private | Move balance into the encrypted balance |
| `decrypt` | Private to public | Move balance out of the encrypted balance |
| `stealth` | Private to stealth output | Send an encrypted amount to a hidden recipient |
| `claim` | Stealth output to private | Claim a stealth output into the encrypted balance |
| `call` | Public to contract | State-changing contract call |
| `deploy` | Public to network | Deploy a contract |
| `key_switch` | Account | Register or refresh the account's PVAC key |
