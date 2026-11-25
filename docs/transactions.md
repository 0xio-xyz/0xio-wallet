# Transactions

How an Octra transaction goes from a form or a site request to the network, and the checks on the way. The exact byte formats and error codes are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Where the code lives

| Path | What it does |
|------|--------------|
| `src/services/network/NetworkService.ts` | Builds and signs public transactions (`buildAndSignTransaction`), broadcasts them |
| `src/services/network/PrivacyNetworkService.ts` | Builds and signs private transactions (`encrypt`, `decrypt`, `stealth`, `claim`, `key_switch`) |
| `src/utils/octra/txHash.ts` | The signed text (`txSigningJson`) and the transaction hash (`computeTxHash`) |
| `src/services/crypto/CryptoManager.ts` | Ed25519 signing |
| `src/services/network/txScope.ts` | Binds a send to one network, RPC and wallet (`captureTxScope`, `assertTxScope`) |
| `src/hooks/transactions/useReviewScope.ts` | Captures the scope when a review opens and hands it to the submit |
| `src/services/network/NonceManager.ts` | Nonce reservations per network and address |
| `src/services/network/feeQuotes.ts` | Live fee quotes per network, RPC and operation |
| `src/services/network/txOutcome.ts` | Reads submit errors (`submitRefusal`) |
| `src/services/network/rpcExchange.ts` | Every node call, with the retry policy |
| `src/background/services/txQueue.ts` | Queue of signed transactions in the worker |
| `src/hooks/privacy/proveThenSubmit.ts` | Order of a private operation: proofs, then nonce, then sign and send |
| `src/services/evm/tx.ts`, `src/services/evm/signer.ts` | EVM transactions (EIP-1559) and the per-signature EVM key |

## Lifecycle

1. **Review.** Every transaction, approvals included, shows a review with the amount, the recipient or contract, and the live fee. When the review opens, `useReviewScope` captures `{ network, rpc, address }`.
2. **Fee.** The fee on the review is the fee that gets signed. A quote is signable for 60 seconds; past that the review reads it again and blocks when the read fails. No path signs a fixed fee.
3. **Nonce.** The next nonce builds on the node's pending nonce and the staging pool. Reservations are keyed by network plus address. A private operation takes its nonce only after its proofs are done.
4. **Sign.** The transaction is signed with Ed25519 over the exact text the node rebuilds: `{from, to_, amount, nonce, ou, timestamp, op_type[, encrypted_data][, message]}`. A public transfer is `op_type: standard`.
5. **Scope check.** Before submit, `assertTxScope` refuses when the wallet, network or RPC changed since the review. Octra transactions carry no chain id, so this check is what keeps a transaction on the network it was reviewed for.
6. **Submit.** `octra_submit` goes to the scoped RPC. The hash is computed locally as well and the node's hash is the one tracked.
7. **Track.** Pending transactions are kept per network and address and settled by the worker's `checkPendingTx` alarm.

## Rules

- A review shows exactly what gets signed. If the live fee minimum rose above the reviewed fee, nothing is signed and the user reviews again.
- A send whose result is unclear (no answer, timeout) is shown as Sending and settled from history. It never offers a resend.
- A nonce is released only on a definite node rejection, never on a lost reply.
- Not accepted (codes 107, 110, 117, -32005) resends the same signed bytes, three tries in all. Nonce used (112) marks the nonce used and asks for a new review. Every other rejection is final.
- Every cache, queue, cursor and query key is scoped to network plus address; activity lists also by token contract.

## Site requests

A site's transaction is reviewed in a window the worker opens and signed by the worker with the wallet the site is connected to (`captureSiteTxScope`). Site writes read the fee live before the review and again before signing (`src/background/services/siteFee.ts`).

## EVM

EVM sends use EIP-1559 type 2 transactions. The private key is derived from the recovery phrase for a single signature, checked against the stored address and wiped. The review is bound to the wallet, address, chain and RPC, and the nonce is read again before signing. Details are in the EVM section of [ARCHITECTURE.md](ARCHITECTURE.md).
