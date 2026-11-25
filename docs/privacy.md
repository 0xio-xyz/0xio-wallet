# Privacy

Octra accounts have a public balance and an encrypted balance. The encrypted balance is a PVAC-HFHE ciphertext: the network adds and subtracts ciphertexts without reading them, and only the key holder can decrypt. All encryption, decryption and proofs run on the device. The byte formats and step by step flows are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Operations

| Operation | `op_type` | What happens |
|-----------|-----------|--------------|
| Encrypt | `encrypt` | Public -> private. The amount is encrypted, committed (Pedersen) and bound to the commitment with a zero proof. |
| Decrypt | `decrypt` | Private -> public. Adds a range proof that the remaining encrypted balance is not negative. |
| Private send | `stealth` | Sends an encrypted amount to a hidden recipient (x25519 shared secret, stealth tag, AES-GCM encrypted amount) with range proofs for the amount and the new balance. |
| Claim | `claim` | Moves a stealth output addressed to this wallet into its encrypted balance. |
| Key switch | `key_switch` | Registers or refreshes the account's PVAC key on chain. |

Reading the encrypted balance signs `octra_encryptedBalance|<address>` to prove ownership, fetches the ciphertext and decrypts it locally.

## Where the code lives

| Path | What it does |
|------|--------------|
| `src/services/pvac/PvacManager.ts` | Runs the PVAC engine: 0xio Desktop, the offscreen document or web workers |
| `src/services/pvac/pvacMasterSeed.ts` | PVAC seed derived from the wallet seed; 0xio Desktop gets this seed, never the signing key |
| `src/services/pvac/proofPolicy.ts`, `pvacPolicy.ts` | The network's proof policy and ciphertext layer rules |
| `src/services/pvac/keySwitchService.ts` | Key registration and refresh |
| `src/services/network/PrivacyNetworkService.ts` | Builds and signs private transactions, reads stealth outputs |
| `src/services/privacy/stealthSend.ts` | The payload of a private send |
| `src/services/privacy/stealthScan.ts` | Finds outputs addressed to this wallet |
| `src/services/privacy/claimLedger.ts` | Claims this device sent, per network and address |
| `src/features/privacy/`, `src/hooks/privacy/` | Privacy screen and its hooks |
| `public/pvac-offscreen.html`, `public/pvac-worker.js`, `public/pvac_rs_bg.wasm` | Offscreen host, worker and the WASM build |

## Where proofs run

1. **0xio Desktop**, when it is running and paired (`0xio-pair-v1`). Native engine, fastest.
2. **Offscreen document** on Chrome, with threaded WASM workers.
3. **Web workers** started by the extension, on Firefox and when the offscreen document is not available.

Every request to the offscreen workers carries a fingerprint of the wallet seed and is refused when it names another seed.

## Rules

- The privacy engine follows the PVAC implementation in Octra Labs' [webcli](https://github.com/octra-labs/webcli) exactly; proof bytes must match it.
- A private operation computes its proofs first, then takes the nonce, then signs and sends (`src/hooks/privacy/proveThenSubmit.ts`).
- Private operations read their fee live; each has a floor (`encrypt`, `decrypt`, `stealth` and `key_switch` 5,000 OU, `claim` 3,000 OU).
- A claim is sent only for an output the node reads as unspent. A claim whose outcome is unknown is resent as the same signed bytes, never rebuilt while it may still land.
- The decrypted private balance is cached in session storage only and cleared on lock.
- A network that announces no proof policy refuses every private operation.
- Sites need the `private_balance_read`, `private_proofs`, `private_transfers` or `private_claims` permission for the matching methods.
