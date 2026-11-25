# Sites on 0xio Desktop: the relay protocol

Websites never reach 0xio Desktop by themselves. A page talks to the 0xio extension; the extension
names the site from what the browser says about the sender and, when the user picked 0xio Desktop
for that site, carries the request over the paired session. 0xio Desktop reviews every request in
the menu bar and signs with its own wallet. The extension only routes; it never signs for a site
routed to the desktop and never falls back to signing locally.

Protocol name: `0xio-site-relay-v1`. It runs only on top of `0xio-pair-v1` (see
[ARCHITECTURE.md](ARCHITECTURE.md), "Pairing with 0xio Desktop").

Extension side: `src/background/services/desktopRelay.ts` (session, requests, events),
`siteOrigin.ts` (who the site is), `siteSigner.ts` (the per-site choice),
`handlers/desktopRoute.ts` (routing). Desktop side: the local socket server and the menu bar review
in [0xio Desktop](https://github.com/0xio-xyz/0xio-desktop-app).

## 1. Session

- The extension service worker opens its own socket to `ws://127.0.0.1:19345`, separate from the
  popup's proof socket, and runs `auth_hello` + `auth_prove` exactly as `0xio-pair-v1` defines.
  It never sends `init` on this socket: no key material moves for the relay.
- Every method below is accepted only on a connection whose `session.trusted` is true and whose
  client is a verified paired extension (`Client::Extension` with `ext_client` set). A legacy
  (unpaired, 3.0.3 and older) connection and a native program are refused with
  `{"code": "AUTH_REQUIRED"}`, even when legacy proof calls are allowed. A paired native program
  never carries a site.
- After the proof the extension sends `sites_subscribe`. The desktop then pushes `sites_snapshot`
  at once and again on every change, and `site_event` for the sites this extension relayed.
- Keepalive: the extension sends `ping` every 60 seconds while the socket is open (the desktop
  closes idle sockets after 300 seconds). When the socket closes, the extension answers every
  request in flight with `NETWORK_ERROR` and opens a new session on the next request.

Framing is the existing one: one JSON text frame per message. A request carries `_id` (number,
per connection) and `method`; its reply carries the same `_id`. A message the desktop sends on its
own carries `event` and no `_id`. Every new message carries `"v": 1`.

## 2. Who the site is (extension, trusted for the site name)

The service worker binds the site from the browser's `MessageSender` only, never from the message
body (`siteOrigin.ts`, the same rule as `originOf` in `handlers/evmRequest.ts`):

- `origin` = `sender.origin`, else `new URL(sender.url).origin`; the sender must be this
  extension's own content script in a tab (`sender.id === chrome.runtime.id`, `sender.tab` set).
- Refused: `null`/opaque origins, `file:`, every scheme but `https:`, and plain `http:` except
  `localhost`, `127.0.0.1` and `[::1]` in development builds. A refused site never sees Sign with
  and is never relayed.
- `framed` = `sender.frameId !== 0`; `top_origin` = the origin of `sender.tab.url` when the browser
  shows it, else omitted.
- `tab_ref` = 32 hex characters, random per relay session, mapped in memory to `tabId:frameId`.
  The raw tab and frame ids never leave the extension.
- `browser` = `"chrome"` or `"firefox"`. The desktop does not read it: it names the browser from the
  extension origin its pairing proved (`moz-extension://` is Firefox, anything else Chrome).

## 3. Extension to desktop

### `site_request`

```json
{
  "_id": 7,
  "method": "site_request",
  "v": 1,
  "id": "9f2c...e1",
  "site": {
    "origin": "https://vaulta.euints.com",
    "top_origin": "https://vaulta.euints.com",
    "framed": false,
    "tab_ref": "4be0...7a",
    "browser": "chrome"
  },
  "network": "mainnet",
  "request": { "method": "send_transaction", "params": { "to": "oct...", "amount": "12.5" } }
}
```

- `id` is 32 hex characters, unique per request; `site_cancel` names it.
- `network` is the network the site is routed on (`mainnet` or `devnet`; anything else is
  `INVALID_PARAMS`): the extension's network when the site's choice there is 0xio Desktop, else the
  site's own desktop network (section 6). Which network the request really runs on is decided by the desktop, see
  "Network per request" in section 5.
- `request.method` and `request.params` are the page's call as the dApp provider received it.

Reply, sent when the user answers in the menu bar (or the request ends another way):

```json
{ "_id": 7, "v": 1, "id": "9f2c...e1", "result": { "...": "..." } }
{ "_id": 7, "v": 1, "id": "9f2c...e1", "error": { "code": "USER_REJECTED", "message": "..." } }
```

`result` has the same shape as the `data` the extension returns for that method itself, so the
SDK sees one wallet. `error.code` is mostly an SDK `ErrorCode` value (`0xio-sdk/src/types.ts`); the desktop-only codes
below are not in that enum yet. The extension passes a code made of `A-Z` and `_` through
unchanged, so the site receives it as an error answer, never a crash. It maps the desktop's own
`RATE_LIMITED` to `RATE_LIMIT_EXCEEDED` and `AUTH_REQUIRED`, `PAIRING_REQUIRED` and `AUTH_FAILED`
to `NETWORK_ERROR`, and anything else to `UNKNOWN_ERROR`. The codes the relay itself uses:

| Code | When |
| --- | --- |
| `USER_REJECTED` | Reject in the menu bar, Cancel in the extension, the tab closed, the request timed out |
| `RATE_LIMIT_EXCEEDED` | 3 requests from this site are already waiting (either side) or more than 60 in a minute |
| `NOT_CONNECTED` | A request from a site the desktop has no connection for, other than the methods listed in section 5 |
| `NETWORK_ERROR` | The desktop is not reachable, or the socket closed while the request waited |
| `WALLET_LOCKED` | The desktop stayed locked (it asks to unlock first, then reviews) |
| `METHOD_NOT_ALLOWED` | A method the relay does not carry |
| `INVALID_PARAMS` | Malformed request, an origin the relay refuses, or a network switch to anything but Mainnet or Devnet |
| `UNSUPPORTED_METHOD` | The desktop's handler has no answer: `get_pending_private_transfers` (use `get_private_balance` with `include_claimable`, or `claim_private_transfer`) |
| `NOT_AVAILABLE` | A private method while the desktop is on another network than the site's |
| `NETWORK_CHANGED` | The site's network or wallet moved while the request waited for review |
| `WALLET_CHANGED` | A private method for a site that uses another wallet than the one open in the desktop |

The desktop must handle `site_request` concurrently: it must not block its read loop the way
`wallet_rpc` does today, so `site_cancel`, `site_closed` and requests from other sites keep
flowing while one review is open.

### `site_cancel`

`{"method": "site_cancel", "v": 1, "id": "9f2c...e1"}` -> `{"ok": true}`. The user pressed Cancel
on "Waiting for 0xio Desktop". The desktop drops the request from its queue (closing its review if
it is open) and answers the original `site_request` with `USER_REJECTED`. The extension has
already answered the site.

### `site_closed`

`{"method": "site_closed", "v": 1, "tab_ref": "4be0...7a"}` -> `{"ok": true}`. The tab closed,
reloaded or left the page (content script `pagehide`, `chrome.tabs.onRemoved`). The desktop drops
every waiting request from that `tab_ref` and closes the review in front if it was one of them.

### `site_disconnect`

`{"method": "site_disconnect", "v": 1, "origin": "https://...", "network": "mainnet"}` ->
`{"ok": true}`. Disconnect, or Move to this browser, in the extension. The desktop cannot tell
the two apart. When it had a connection for that origin and network it forgets it and always sends,
in this order, a fresh `sites_snapshot`, then a `site_event` `accountsChanged` with no accounts, and
only then the `{"ok": true}` reply. With no such connection it sends no event. A malformed `origin`
or `network` is answered `INVALID_PARAMS`. The extension sends nothing else to edit desktop sites.

For a Move the extension sets the choice to This browser before it sends `site_disconnect`, so by
the time the event arrives the origin is no longer routed to the desktop and the extension drops
the event: the site hears one change, from the extension's connect review. The event is delivered
(the site hears `disconnect`) only when the origin is still routed to the desktop on another
network, or still listed in the snapshot. A plain Disconnect keeps the choice, so the event reaches
the site as `disconnect`.

### `sites_subscribe`

`{"method": "sites_subscribe", "v": 1}` -> `{"ok": true}`, then `sites_snapshot`.

## 4. Desktop to extension (events)

### `sites_snapshot`

```json
{
  "event": "sites_snapshot",
  "v": 1,
  "sites": [
    {
      "origin": "https://vaulta.euints.com",
      "network": "mainnet",
      "address": "octBs4zPq8...1bN4hTQ9",
      "wallet": { "name": "Spending", "seed": "octBs4zPq8...1bN4hTQ9" },
      "relayed_by": "<client_id of the extension>",
      "connected_at": 1760880000000
    }
  ]
}
```

0xio Desktop is the single source of truth for desktop sites. The extension keeps the list in
`chrome.storage.session` (`desktop_sites`, only entries whose `relayed_by` is its own `client_id`)
to show the 0xio Desktop group and the site chip; it never edits that list itself. `wallet.seed`
is the value the wallet art is drawn from; the desktop always sends the address. `wallet.name` is
the wallet's name when the site connected, not a live name: a rename in the desktop shows after the
site connects again.

When a snapshot lists a site of this extension whose choice here is This browser (moved while the
desktop was closed), the extension sends `site_disconnect` for it. A listed site with no choice
here is taken as 0xio Desktop (for example after a network switch made in the menu bar).

### `site_event`

```json
{ "event": "site_event", "v": 1, "origin": "https://...", "kind": "accountsChanged", "data": { "accounts": ["oct..."], "publicKey": "...", "canSign": true } }
```

| `kind` | `data` | Delivered to the page as |
| --- | --- | --- |
| `accountsChanged` | `{accounts, publicKey?, canSign?}` | `accountChanged`, or `disconnect` when `accounts` is empty |
| `networkChanged` | the `networkInfo` object of `connect` | `networkChanged` |
| `tx` | `{hash, status, ...}` | `transactionConfirmed` |
| `lock` | `{}` | `extensionLocked` |

The desktop sends a `site_event` only to the extension that relayed that site. The extension
delivers it only to that origin's tabs and frames (the 3.0.3 scoping: `sendEventToOrigins`, full
origin match, the content script drops an event that names another origin) and only while the
origin is routed to 0xio Desktop here. Removing the extension in the desktop's Paired apps empties
its group and sends `accountsChanged` with no accounts to those sites first.

## 5. What is relayed

The Octra dApp provider methods: `connect`, `disconnect`, `getAddress`, `getBalance`,
`get_balance`, `getWalletInfo`, `getPublicKey`, `getNetworkInfo`, `get_network_info`,
`getConnectionStatus`, `switch_network`, `send_transaction`, `sendTransaction`,
`call_contract`, `callContract`, `contract_call_view`, `contractCallView`,
`get_contract_storage`, `getContractStorage`, `deploy_contract`, `deployContract`, `signMessage`,
`sign_transaction`, `signTransaction`, `broadcast_only`, `send_contract_transaction_sequence`,
`getTransactionHistory`, `get_transaction_history`, `rpc_call`, and the private layer
(`get_private_balance_info`, `get_private_capabilities`, `get_private_balance`, `encrypt_value`,
`decrypt_value`, `make_zero_proof`, `make_range_proof`, `register_private_view_key`,
`send_private_transfer`, `get_pending_private_transfers`, `claim_private_transfer`).

`ping` and `register_dapp` are answered by the extension: `register_dapp` is the SDK's
acknowledgement during init, it stores nothing, so a page loads without the desktop open and
without asking it to unlock. Anything else from a desktop site is refused with
`METHOD_NOT_ALLOWED` and never runs locally; the desktop refuses it the same way.

The pre-connect reads `getConnectionStatus`, `getNetworkInfo` and `get_network_info` go to the
desktop only while the relay session is up (an attempt to open it respects the 5 second retry
pause). While the desktop is not reachable, or the socket closes before it answers, the extension
answers them itself: `getConnectionStatus` as not connected (`connected: false`, no address, even
when this browser has a stale connection for the origin) with the extension's network, and the
network reads with the extension's network. The desktop answers them without an unlock.

### Methods answered for a site with no connection

`connect`, `disconnect`, `getNetworkInfo`, `get_network_info`, `getConnectionStatus` and
`get_private_capabilities` (and `register_dapp`, which the extension now answers itself) are
answered for a site the desktop has no connection for (`connect` opens the review). Every other method gets `NOT_CONNECTED` at once,
without a review.

### Network per request

- `connect` runs on exactly the network it asks for (`site_request.network`).
- Every other request runs on the site's connection on the asked network, else on the site's
  latest connection (for example after the user switched that site's network in the menu bar).
  The reply and the review use that network, which may differ from `site_request.network`.
- `switch_network` accepts only `mainnet` or `devnet` (`networkId` or `network` param), else
  `INVALID_PARAMS`. It moves only that site, never the network the desktop shows, and the site
  hears `networkChanged`.

### Result shapes

`result` comes from the desktop's own dApp handler, run on the site's record and network, so it
has the extension's shape for `getAddress`, `getBalance`, `getWalletInfo`, `getPublicKey`,
`getNetworkInfo`, `getConnectionStatus`, `callContract`, `contractCallView`, `getContractStorage`,
`signTransaction` and `getTransactionHistory`, and the SDK shapes for the rest. Known differences
from the extension:

- `getBalance` returns the OCT balance and the nonce, with `privateBalance` always `"0"` (not the
  extension's cached private balance).
- The `connect` payload reports `wallet: "0xio-desktop"`.
- `get_pending_private_transfers` answers `UNSUPPORTED_METHOD`.
- `get_private_balance_info` returns `encrypted: null` with a message.
- The desktop-only codes `NETWORK_CHANGED`, `WALLET_CHANGED` and `NOT_AVAILABLE` pass through.

### Private methods

`get_private_balance`, `encrypt_value`, `decrypt_value`, `make_zero_proof`, `make_range_proof`,
`register_private_view_key`, `send_private_transfer` and `claim_private_transfer` run only for the
wallet open in the desktop and only while the site's network is the network the desktop is on.
Otherwise they answer `WALLET_CHANGED` or `NOT_AVAILABLE`, with a message that says what to switch.

EVM requests (`eth_*`, `wallet_*`, `personal_*`, `net_*`, `web3_*`) are not relayed: they stay in
the extension, and Sign with appears only on the Octra connect review.

## 6. Routing in the extension

- The choice is kept per site and network (`chrome.storage.local`, `0xio_site_signer`,
  `"<network>|<origin>"` -> `"desktop"` or `"browser"`). A new site starts on This browser.
- The choice on the extension's network wins. With no choice there (the user switched the
  extension to another network, or to a custom one), a site whose choice is 0xio Desktop on Mainnet
  or Devnet and that has no connection in this browser stays on the desktop, on its own network:
  the latest one `sites_snapshot` lists for it, else Mainnet before Devnet. Switching the
  extension's network never hands a desktop site to this browser; Move to this browser does.
- The connect review shows Sign with only while 0xio Desktop is paired and the relay session is
  proven, on `mainnet` or `devnet`, for an origin `siteOrigin.ts` accepts. Picking 0xio Desktop
  turns Connect into Continue: Continue only routes; the menu bar review is the confirmation.
  The review then shows "Waiting for 0xio Desktop" with Cancel. When the desktop cannot be
  reached it shows Try again and Use this browser.
- A site whose choice is 0xio Desktop: `connect` goes straight to the desktop when the session is
  live, else (or when the desktop leaves before it answers) to the review on its not reachable
  state with Try again and Use this browser. A local connection this browser still holds for the
  origin is never returned to it. `register_dapp` and, while the desktop is down, the pre-connect
  reads are answered here (section 5). Every other method goes to the desktop; the local vault
  never signs or answers for it. If the desktop is not reachable, or the socket closes
  mid-request, the site gets `NETWORK_ERROR`.
- In flight: at most 3 requests per origin to the desktop; a fourth is answered
  `RATE_LIMIT_EXCEEDED` at once. The desktop keeps its own cap, see "Limits" in section 7.
- Move to this browser sends `site_disconnect` first, sets the choice to This browser and opens the
  extension's connect review for the site; the site hears `accountChanged` (approved) or
  `disconnect` (rejected) once.

## 7. What 0xio Desktop implements

1. `site_request`, `site_cancel`, `site_closed`, `site_disconnect`, `sites_subscribe` in
   `ws_server.rs`, allowed only for `Client::Extension` with `session.trusted` and `ext_client`
   set; everything else gets `AUTH_REQUIRED`. Handle `site_request` off the read loop.
2. Check the site again: `origin` must be `https://` (or `http://localhost`, `127.0.0.1`, `[::1]`)
   with no path; refuse others with `INVALID_PARAMS`. The site name comes only from `site.origin`
   of a verified extension, never from `request.params`.
3. One record of connected sites keyed by network + address + site, plus the `client_id` that
   relayed it; push `sites_snapshot` to that extension's subscribed connections on every change.
4. Queue and limits: repeat connects from one origin, extension and network merge into one review.
   Per origin (the site), across every paired browser and network: at most 3 waiting requests
   (every waiter counts, merged connects included) and 60 requests per minute. Beyond either, the
   request answers `RATE_LIMIT_EXCEEDED` with no notification. `site_closed` drops a tab's
   requests; `site_cancel` drops one, and only the connection that sent it may.
5. Review every request in the menu bar (Reject and the verb, no slide, no auto approve), with the
   full origin, the page it sits in when framed, and "Via 0xio extension (Chrome)". Locked: unlock
   first, then the review. Before signing, check network and address against what was reviewed.
6. Answer with the result shapes and error codes above (section 5); `site_event` only to the
   relaying extension.
7. Removing a paired extension: send `accountsChanged` with no accounts for its sites, forget them,
   then close its connections.

## 8. Verified

The extension's relay code was run against the real desktop server over a socket: pairing proof and
subscribe, `NOT_CONNECTED`, a held connect not blocking other requests, merged connects, a signed
request, the fourth waiting request refused, Cancel and a closed tab, and removing the paired
extension. The `site_disconnect` ordering is covered by the desktop's own tests, not by this run.

- Server, in 0xio Desktop (writes `RELAY_E2E_FILE` with port, desktop id, client id and
  secret, answers like the menu bar, and stops when `RELAY_E2E_FILE.done` exists or after 90
  seconds): `RELAY_E2E_FILE=<path> cargo test --lib relay_e2e_server -- --ignored`
- Client: the extension's `DesktopRelay`, `SocketLink` and `authenticate`, driven against that server
  after it has written the file. The client harness is not kept in this repo.
