# Background

The background context is the Manifest V3 service worker (`manifest.json` -> `src/background/index.ts`). Firefox builds run the same file as an event page (`build/firefox-manifest.mjs`). It is the only context that sees every site request, so the permission boundary lives here.

## Where the code lives

| Path | What it does |
|------|--------------|
| `src/background/index.ts` | Message switch for the popup and content script, alarms, auto-lock on startup, offscreen document lifecycle |
| `src/background/handlers/dappRequest.ts` | Every Octra site method: connect, permissions, reads, reviews, signing |
| `src/background/handlers/evmRequest.ts` | EIP-1193 methods for EVM sites |
| `src/background/handlers/desktopRoute.ts` | Sends a site's requests to 0xio Desktop when the user picked it for that site |
| `src/background/handlers/network.ts` | `NETWORK_REQUEST` fetches for extension pages |
| `src/background/services/approvals.ts` | Octra review windows; the answer is stored before the approval resolves |
| `src/background/services/evmApprovals.ts` | EVM review windows; request data stays in worker memory and the window asks for it by id |
| `src/background/services/dappConnections.ts` | Connected sites, their permissions and the events they may receive |
| `src/background/services/requestLifecycle.ts` | Wallet protocol 2: request ids, status and `requestUpdate` events |
| `src/background/services/txQueue.ts` | Queue of signed transactions, kept in `chrome.storage.local` |
| `src/background/services/pendingReconciler.ts` | Settles pending transactions against their own network |
| `src/background/services/desktopRelay.ts` | The worker's own session to a paired 0xio Desktop |
| `src/background/services/siteOrigin.ts` | Names a site from the browser sender |
| `src/background/services/siteBudget.ts` | Per-site request budget |
| `src/background/services/siteFee.ts` | Live fee for site writes, read again before signing |
| `src/background/services/signingKey.ts` | Watch-only checks (`canSign`) |
| `src/background/services/lockIcon.ts` | Locked and unlocked toolbar icons |

## How a site request travels

1. The page calls `window.octra.request(...)`, `window.wallet0xio` or `window.ethereum` (`src/content/injected.ts`).
2. The call goes over a private `MessageChannel` port to the content script (`src/content/index.ts`), which drops internal message types, rate limits the page and forwards it as `DAPP_REQUEST`.
3. The worker sends EVM methods to `evmRequest.ts` and the rest to `dappRequest.ts`. Both name the site from `sender`, never from the message body, and check its budget. An Octra request from a site that signs on 0xio Desktop goes to `desktopRoute.ts`.
4. A method that signs opens a review window in the popup app and waits for its answer. Nothing is signed before the user approves.

## Rules

- The content script blocklist is a filter. The real boundary is the worker's switch and the permission each method requires (`accounts`, `public_transactions`, `contract_calls`, `contract_views`, `private_balance_read`, `private_proofs`, `private_transfers`, `private_claims`).
- A site's origin always comes from the browser (`sender.origin`, else the origin of `sender.url`).
- Each Octra site gets a budget of 30 requests at once, refilled at 8 a second, and gets `RATE_LIMITED` beyond it. EVM reads have their own budget (200 at once, 50 a second) and get -32005.
- One review at a time. While a review is open, a second request gets `REQUEST_PENDING`, or `RATE_LIMIT_EXCEEDED` with the blocking request id on protocol 2.
- An unanswered review closes after 5 minutes, or when the requesting page goes away, and answers as rejected.
- A site routed to 0xio Desktop is never signed for locally, even when the desktop is down.
- Every cache, queue, cursor and query key is scoped to network plus address.

## Alarms

| Alarm | Period | Work |
|-------|--------|------|
| `keepAlive` | 30 s | Auto-lock check (default 5 minutes; skipped while a long private operation runs) |
| `checkPendingTx` | 30 s | Pending transaction reconciliation |
| `checkDAppExpiry` | 5 min | Expired site connections |
| `balanceSnapshot` | 2 min | Balance chart points |

The worker can stop at any time. Anything that must survive a restart is in `chrome.storage.local` (queue, connections) or `chrome.storage.session` (unlock state, request records, desktop site mirror).

The full protocol details are in [ARCHITECTURE.md](ARCHITECTURE.md) and, for 0xio Desktop, [DESKTOP_RELAY.md](DESKTOP_RELAY.md).
