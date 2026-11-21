# Changelog

## v3.0.7 - unreleased

### Security

- A swap lock is refused when the current epoch cannot be read, instead of signing with a built-in fallback epoch.

### Fixed

- Transaction detail shows a token amount with the token's own decimals and symbol, and no amount when the contract is not a token.
- Collection and token JSON from a circle is read again each session instead of being kept on disk, so changed metadata shows without a manual refresh.
- Circle files are cached per network; the old cache is emptied once.
- A private balance up to the protocol limit reads as valid (the check stopped at 100 million OCT).
- The network dot on a site review follows the network id, not the RPC address.

### Changed

- Service files grouped by domain, comments and dead code trimmed; no behaviour change.

## v3.0.6 - 2026-11-20

### Security

- Runtime packages cut from 69 to 10: signing, hashing and key derivation libraries plus the UI framework. The rest is written in this repository.
- Site and wallet names shown from a site drop invisible direction and control characters.
- A claim is sent only when the node reads its output as unspent; spent or unreadable sends nothing.
- Claims are kept per network and address: an earlier pending or confirmed claim of the same output stands, and a confirmed claim the node lost blocks for 600 s, then is marked missing.
- A claim with no clear result holds its output until its nonce is spent or 600 s pass without the node staging it.
- A dropped or released claim resends its saved bytes only while the output reads unspent, its nonce is still the next one and its fee equals the reviewed fee; otherwise a fresh claim is built.
- A write is repeated only when it provably never left; a dropped connection counts as possibly sent.

### Fixed

- A never-used address reads as 0 OCT through the RPC proxy instead of failing to read the balance.
- A claim output with no readable claimed flag reads as unknown, not as already claimed.
- The PVAC public key cache is keyed by network, RPC and address and is cleared on a wallet switch and on lock.

### Added

- Site claim codes: `CLAIM_OUTPUT_SPENT`, `CLAIM_OUTPUT_UNREADABLE`, `CLAIM_CONFLICT`, and `RATE_LIMIT_EXCEEDED` or `NETWORK_ERROR` after the retry window.

### Changed

- QR codes, translations, in-app navigation, icons, text cleaning, wallet ids and base64 encoding use our own code in place of packages.
- Icons are our own drawings in the shape language of the 0xio mark, shared with the other wallets from one source.
- A name containing `&` shows `&`, not `&amp;`.
- Runtime and build package versions are pinned exactly.
- Receive on the EVM tab no longer shows the row of network logos.
- A site claim of an output already pending or confirmed here returns the earlier hash without a review.
- Every node call shares one retry policy: busy, gateway and state changed (-32012) answers retry with paced pauses and Retry-After inside 25 s.
- At most 4 node calls run at once per context; background polls take at most 2 and wait for user calls.
- Private proofs about 1.3x faster (pvac-rs 0.3); Firefox WASM rebuilt from the same version.

## v3.0.5 - 2026-11-14

### Security

- A copied recovery phrase or private key is cleared from the clipboard after 60 seconds, only when the wallet can tell it is still there (read back where the browser allows it, otherwise only if the page kept focus and nothing else was copied). A closed popup cannot clear it.
- First backup drops the words from the page on Hide, when the page is hidden or closed and when the wallet locks; only placeholders stay.
- A wallet with no password asks to create one before the recovery phrase, the private key or the EVM key is read: first backup, Back up again and Settings. Cancel shows nothing.
- Secrets for display are read in one place, which needs the password and refuses in no-password mode.
- An incoming private transfer whose one-time key is a low-order point (all-zero X25519 result) is ignored, and a private send to such a view key is refused, as the reference client does.
- Site call arguments are signed as sent; integers above 2^53 no longer change.
- A used nonce (112) asks for a new review; nothing is re-signed.
- Site writes are reviewed and signed from one normalized request; conflicting to, to_, contract, method, encrypted_data or params and message are refused.
- Contract sequences show each step's exact arguments and attached amount.
- Pairing with 0xio Desktop: pick the desktop's code among three; nothing is saved until the right pick and the desktop's approval.
- An unproven not_paired answer no longer deletes the pairing.
- Signing stops when the node reports more than 32 pending nonces.
- Site request ids are scoped to the sender's origin; a repeated id never opens a second review or signs twice.
- Request status shows locked, network and signer only to a connected site.
- A site that is not connected learns nothing about the wallet or its lock: every request but connect and the public reads is refused NOT_CONNECTED at once, with no unlock prompt (getWalletInfo and get_balance gave such a site the open wallet's address and balance). On window.ethereum a signing request from such a site no longer opens the unlock, and wallet_getProviderState reports it unlocked.
- A not connected site's getConnectionStatus carries no address, public key, balance or signing flag, and get_private_capabilities needs a connection. A contract view or chain read from such a site never runs as the open wallet (no default caller or from).
- A not connected site's request is never marked locked: it reads review_open from the start, so nothing about it changes when the wallet unlocks.
- An unclear site submit (no reply, timeout, node error that is no verdict) is never an error: the site gets status submitted with the local exact hash and the chain watch settles it; only a node verdict refuses. Covers send, contract call, broadcast, deploy, sequences (stop at the unclear step), private transfer, claim and key registration.
- Site view key registration: own address only (INVALID_PARAMS otherwise, before any review); another on-chain private key is refused with PVAC_KEY_MISMATCH and an unconfirmed registration with REGISTRATION_PENDING, both before any review.

### Fixed

- First backup: Show keeps the recovery phrase on screen until Hide (it showed only while held), with Copy phrase beside it.
- A finished backup ends with Backed up, from Home and from Back up again in Settings.
- Settings no longer asks to confirm writing down a phrase that was already backed up again.
- Home and OCT price charts draw at most 96 averaged points (a day was 2,880), so the line no longer looks cramped.
- NFTs: a collection storage read the node did not answer no longer starts the id by id owner scan; the ids already shown stay.
- NFTs: with the owned count unchanged, up to 10 known ids are asked for by id instead of scanning the whole collection again.
- NFTs: one owned id scan per collection at a time on a page; a second screen that needs the same ids joins the scan already running instead of starting it again.
- NFTs: the 60 second collection refresh and new id scans stop while the page is hidden; coming back after more than 60 seconds refreshes once.
- Home balance chart: returning to Home shows the last line in its final shape; no flat grey line, 0.0% or jump while EVM charts load.
- A created wallet is marked for backup in the same write that stores it; closing the popup can no longer skip the backup prompt.
- First run stores the password, the vault and the first wallet in one write; a setup cut off before its first wallet opens onboarding again instead of an empty wallet.
- Every vault change holds the cross-context lock from read to write; a wallet added in the popup is no longer dropped when a site switches the active wallet.
- Signing text escapes DEL and strips leading zeros in amount and fee, as the node does.
- The dApp review shows large integers exactly.
- A page over 20 requests a second gets RATE_LIMITED instead of no answer.
- wallet_hello reaches the Octra handler; its wallet_ prefix sent it to the EVM handler, so sites read protocol 1.
- A site request sent while a transaction or message review was open could get an empty answer: the review's message listener answered it.
- An unanswered review closes with its page; an approved one finishes.
- A site broadcast runs from arrival: page close, cancel_request or expiry never drop it, and it keeps its submitted and confirmed outcome.
- A site key registration's pending record clears in the background once the chain confirms or rejects it.
- Local tx hash keeps an optional field sent as "" (only a missing or null one hashes as null), as the node does.
- Records the wallet builds drop empty message, public_key and encrypted_data before signing; the node signs "" as present.

### Added

- Send to an ONS name (devnet): a recipient ending in .oct shows as a row in the picker with its full address and has to be picked; a name that cannot be paid says why.
- Send review of a name shows the name over the full address and reads the name again before signing; a changed address or a failed read stops the send.
- Primary ONS name beside the address on Home, in contacts and in history.
- ONS names in NFTs with name, status and expiry read from the contract; an active name offers Transfer, a name that is not active has no actions.
- Refresh metadata in an NFT's menu reads that piece again past every cache; the art stays, dimmed, while it runs and is replaced only when the read succeeds.
- Wallet protocol 2: presence announce, wallet_hello, request ids, request_status, cancel_request and requestUpdate events.
- Submitted site transactions are watched on chain until confirmed or failed, with the contract receipt.
- Sites on 0xio Desktop: wallet_hello, request_status, cancel_request and requestUpdate events go through the pairing once the desktop speaks protocol 2.
- Shared protocol 2 vectors test, and npm run test:conformance runs the SDK conformance suite.
- Site view key registration reads octra_viewPubkey and the confirmed private key first: both present completes with no review; otherwise one review with the live key_switch fee, then the empty key_switch, submitted and confirmed. A balance below the fee is refused before the review.

### Changed

- A name is Active or Expired (in grace or lapsed): Expired shows as the tag on its artwork and in the Status row, and Not active is gone; a failed re-read keeps the artwork already shown.
- ONS names in NFTs show their own artwork from token_uri like any NFT, with Refresh metadata; an expired name carries an Expired tag; the wallet-drawn plate shows only when the artwork cannot be loaded.
- Send: a typed .oct name becomes the recipient as soon as it resolves, with no pick from the list, and its address stays on one line (cut in the middle). The review still shows the full address and reads the name again before signing.
- Send: a typed name is taken only after the text stayed unchanged for one second; Enter or a pick takes it at once.
- NFTs say Transfer where they said Send: piece page, EVM NFT page, the transfer sheet, its review and result (Transferring, Transferred), its errors and Transferred NFT in history. Tokens keep Send.
- ONS names follow the name contract's interface 6: a name is resolved with one `resolve` call, held names come from `names_of`, expiry from the eight-field `get_name_info`; years are 1 to 5.
- The name contract is no longer built in: it is read from the token-lists name list (`octra.namelist.json`, one `.oct` entry per network, every 30 minutes), checked on chain with `get_contract_info` (Octra Name System, ONS, interface 6) once per session and per address, and the last address that passed is kept for when the list cannot be reached; no entry or a failed check means no names on that network. A send stops at confirm when the listed contract changed since the name was typed.
- Per-op fee floors: key update, encrypt, decrypt and private send 5000 OU, claim 3000.
- Fee quotes checked like the webcli; a quote without fast hides only Fast.
- Next nonce from pending_nonce, else the staging pool.
- Local exact tx hash is tracked; a different node hash is only logged.
- PVAC proof policy read from octra_pvacMigrationStatus (else the devnet runtime) and checked again before submit; private ops are refused without it.
- key_switch carries owner_cipher and owner_proof when the network binds proofs to the key.
- Historical-key balances migrate by cipher proof when the node opens that route.
- Circle files split into chunks are assembled and checked.
- Submit and batch read node error codes: safe resends retried 3 times, rejected and too large refused.
- Mainnet explorer links open octrascan.io; lite.octrascan.io dropped from host permissions.
- Review window 5 minutes (was 120 s); an expired review answers USER_REJECTED with details.status expired.
- A request id to 0xio Desktop waits past its 5 minute review and is never cancelled on timeout; the site gets STATUS_UNKNOWN.
- A connected site's review while the wallet is locked opens the unlock and waits (once a minute per site) instead of failing at once.
- Status reads are always answered; past 2 a second per site they skip the on demand chain read.
- Another review of the site open: protocol 2 sites get RATE_LIMIT_EXCEEDED with details.reason review_pending and the blocking request; older sites keep REQUEST_PENDING.
- Taglines, row subtitles, empty state lines and form hints removed; errors, live status and risk notes stay.
- Unused strings removed from every language.
- Add wallet: Add account is a plain row; the wallet shows on the next step under From.
- EVM settings: the wallet card on top; the switch reads EVM address.
- Privacy on a network without privacy: Edit network and Switch network buttons under the network.
- Claim, Add EVM: two ways, Import recovery phrase or Claim on bridge.0xio.xyz.
- Bridge to Ethereum: a Claim key beside Review bridge, dim until a transfer is ready.
- Backup on a watch-only wallet: Nothing to back up over the wallet chip.
- History, NFTs and the private transfer scan load as pulsing blocks in the final layout (static with reduced motion); the loading captions are gone.
- Settings rows show one status each.
- Welcome shows the tagline under the name again.

## v3.0.4 - 2026-10-22

### Security

- The extension sent the PVAC master seed to whatever answered on 127.0.0.1:19345, so a program posing as 0xio Desktop could take it. The extension now pairs with 0xio Desktop once (both show the same 6 digit code from an X25519 exchange, approved on the desktop) and on every connection both sides prove the pairing secret before any key material moves. A desktop that cannot prove it gets nothing and proofs run in this browser.
- An 0xio Desktop from before pairing gets no key material either: proofs run here and the status asks to update the desktop.
- dApps: a site private transfer signed a fixed 3000 OU fee when the live read failed. The fee is now always read live; with no fee the site is refused before any review and nothing is signed.
- No transaction signs a built-in fee any more: site calls, sends, sequences, sign-only and deploys, NFT market and send, swap lock and private ops all use the live fee or are refused.
- Routing moves to react-router 7: fixes the open redirect through a backslash in links (react-router 6 has no patch).
- Build tools patched: vite 6.4.5 and vitest 4.1.12.

### Fixed

- dApps: a site fee is kept only when it is valid and at or above the live minimum, otherwise the live recommended fee is shown and signed.
- dApps: the fee is read again before signing; when the live minimum rose above the reviewed fee nothing is signed ("The network fee changed. Review again.").
- dApps: the claim review shows the amount, the count and the live fee.
- Claim progress said "Claiming N transfers" for a single claim.
- Max no longer fills the whole balance while the fee loads; it waits for the live fee and leaves room for it.
- Fee rows show a fixed-size placeholder while loading and Unavailable with Retry on error, never "--" or "...".
- The fee picker no longer offers fixed tiers when the live fee is missing.
- Bridge: a claim stuck on "Claiming on Ethereum". A claim the node never took, dropped or replaced is sent again with the same signed bytes, then checked on Ethereum once its nonce is used or no node has known it for 10 minutes: claimed reads Completed, otherwise "Claim did not go through. Claim again." or Waiting for Octra.
- Bridge: a claiming transfer without a hash is checked on Ethereum instead of waiting forever.
- Bridge: claims and allowances are checked first on every pass and at most three transfers at a time, so a slow Octra scan no longer holds them; a reopened popup checks them at once.
- Bridge: Claim simulates the claim from the wallet first; already claimed, not yet on Ethereum and the daily mint limit are told before any gas is spent, and the claim signs the calldata that passed.
- Bridge: an allowance whose tx was dropped settles by the allowance on Ethereum.
- "Network fee unavailable" after one rate limited read. A fee read now tries a busy node (429, 502 to 504, timeout) twice more on the same node with backoff.
- Fee reads for the same network, node and op share one request; the three private op fees are read one after another.
- The bridge fee read waits up to 10 seconds per try (was 4).
- wOCT price chart showed No data on 1D and 7D. wOCT uses the OCT price history; other thin tokens ask the price API with a search width matched to the period.
- dApps: a site on 0xio Desktop said "0xio Wallet extension not found" while the desktop was closed, and popped the menu bar to unlock on page load while it was locked. The SDK's `register_dapp` is answered here, and the connection status and network reads are answered here as not connected while the desktop is down.
- dApps: connecting a site on 0xio Desktop while the desktop is closed, or quits before it answers, opens the review on 0xio Desktop is not reachable with Try again and Use this browser, never a plain error.
- dApps: switching the extension to another network no longer hands a site on 0xio Desktop to this browser; it stays on the desktop on its own network.

### Added

- Pairing with 0xio Desktop: tap the desktop status, compare the code, approve on the desktop (up to two minutes, Cancel any time). Settings, Connections shows 0xio Desktop as Paired with Unpair, or Not paired with Pair.
- dApps: Sign with on the Octra connect review (This browser or 0xio Desktop) while 0xio Desktop is paired and reachable; Continue hands the request to the menu bar review.
- dApps: Waiting for 0xio Desktop with Cancel, and Try again or Use this browser when the desktop is not reachable.
- dApps: sites on 0xio Desktop have every Octra request reviewed and signed there; this browser never signs for them and answers `NETWORK_ERROR` when the desktop is gone.
- dApps: at most 3 requests per site wait for 0xio Desktop; the next one gets `RATE_LIMIT_EXCEEDED`.
- Site chip on a desktop site: Signs with, network, Move to this browser and Disconnect.
- Connected sites splits into This browser and 0xio Desktop.
- Bridge to Octra: Step 1 of 2 Allow wOCT, then Step 2 of 2 Bridge to Octra, each its own review with Reject. Allows exactly the amount; an allowance that covers it skips step 1; step 2 unlocks once the allowance confirms and survives closing the popup (View on the form). A transfer waiting for its allowance is continued, never allowed twice.
- Bridge reviews show fees in USD with the native amount beside it, and the amount with its USD value under it. Any chain: network fee in USD on priced chains, You bridge in USD, route fees in dollars and cents. No price shows the native amount only.
- A fee read that fails keeps the last live quote for up to 5 minutes, dimmed with its age.
- Bridge and any chain reviews: tap Network fee for Slow, Normal or Fast from the live estimate (each with its USD cost) or Custom max and priority fee in gwei. Custom needs a priority fee above 0 and a max fee that covers the base fee plus the priority fee; below that a note says so and nothing can be used. The choice holds for that review only.
- Before an Ethereum or any chain bridge signs, the fee is read again; when the network minimum rose above the chosen max fee nothing is signed and the review shows the new fee.
- Bridge transfers made in 0xio (to Ethereum, to Octra, claims and any chain) count in the bridge site's stats, marked as from the extension. Mainnet only, once per transfer, no key; only what the transaction already shows is sent (type, hash, amount, its addresses). The oracle counts it only after finding it on chain.
- A custom node without `octra_recommendedFee` shows "This node does not quote fees" instead of Retry.

### Changed

- A desktop that forgot this install (removed there, or unused past its limit) drops the stored pairing here; Connections shows Not paired with Pair.
- Connections says to update 0xio Desktop when it predates pairing.
- A fee quote counts as live for 30 seconds. Fee rows read on open and again when the popup comes back after more than 30 seconds; only an open review keeps its one fee live every 30 seconds. Review and Confirm read again when the quote is older than 60 seconds; a review never signs an older quote or a fixed fee.
- Home: OCT then encrypted OCT always lead the list; EVM tokens follow by USD value, highest first, then unpriced tokens by name.
- Bridge and any chain reviews say Reject instead of Back.
- Bridge wording: You bridge and You get instead of Amount, You pay and You receive; the any chain review button says Bridge to Octra instead of Pay; Bridge from chain, Token to bridge, Review bridge and Bridge with another wallet replace the pay labels.
- Ethereum fee rows in the bridge say Network fee instead of Max fee.
- New, imported, watched and added account wallets get a numbered name (Imported Wallet 2) when the name is already taken; numbers go past the highest one in use and a long name is cut so it stays within 32 characters.

## v3.0.3

### Security

- Transaction and wallet events reach only the connected site that asked, not every open tab. A send made in the popup tells no page anything.

### Added

- dApps: connect, reconnect, getConnectionStatus, getWalletInfo and accountChanged carry `canSign` (false for a watch-only wallet); window.octra and window.wallet0xio expose it too.

### Fixed

- dApps: every watch-only refusal answers `WATCH_ONLY` ("This wallet is watch-only and cannot sign."), getPublicKey included; window.octra maps it to 4100. A wallet with a key but no public key answers `NOT_AVAILABLE`.
- dApps: SDK pages receive wallet events (accountChanged, networkChanged, balanceChanged, lock and unlock) again.

- Bridge: Find my transfers finds Bridge to Ethereum transfers again; Octra's address history no longer names the method or status, so every lock was skipped. The lost-reply lookup reads the same list.

### Changed

- Store description: "Private wallet for Octra Network with EVM support".

## v3.0.2

### Added

- Toolbar icon shows a padlock while the wallet is locked.

### Fixed

- Bridge to Ethereum signs the live Octra network fee shown in the review instead of a fixed 1000 OU, and asks again if the minimum rises.
- Bridge: a refused or rate-limited send frees its nonce, so the next try is not stuck behind a gap.
- Bridge: a send that may have reached the node is followed on Octra and says to check Claim, never that it was not sent.
- Bridge: Confirm shows progress, then a status toast and the transfer in progress on the form; send errors say why in a toast (network busy, balance, fee, pending transaction, the node's reason).
- Bridge: missing ETH or OCT for the fee, a failed fee read, a moved quote and a failed search show as a toast and the review stays closed; the form keeps only paused and limit notes, and Claim drops its standing ETH note.
- Every toast dissolves on its own: info 4 s, errors and warnings 6 s; hover pauses it and leaving, blur or hiding the popup resumes it; the NFT network note and Undo bar follow the same timing.

### Changed

- Unlock no longer opens the passkey prompt by itself, after an auto lock or a manual lock; tap Use passkey to use it.
- Bridge: Review opens faster; checks run ahead and a rate-limited Octra read no longer holds it.
- Bridge copy says Bridge to Ethereum, Bridge to Octra, Claim on Ethereum and Allow wOCT instead of lock, burn and mint.

## v3.0.1

### Security

- EVM signatures and transactions show Signing with and the wallet's row; after the review the wallet must still be connected with the same address, and when it was the open wallet, the open wallet must not have changed.

### Added

- EVM sites keep several wallets: the site follows the open wallet when it is one of them, keeps its last wallet otherwise, and never disconnects on a wallet switch. A site only ever sees the wallet in use.
- EVM connect with a private-key wallet open: the review lists the wallets with an EVM address (the last used picked first), or offers Add a wallet and comes back with it picked.
- Footer chip: Not connected opens the connect review for the open wallet; the menu lists connected wallets, Connect another wallet, Network and Disconnect; a wallet change review moves the site to another of its wallets.
- Connected sites: one row per site with its first wallet, +N and network; the site page lists its wallets with Remove, Connect another wallet, the network and Disconnect.
- A chain on the other side asks to switch all of 0xio to Mainnet or Testnet, then moves the site.

### Fixed

- EVM sites: wallet_getCapabilities, filters, eth_syncing, web3_sha3 and net_listening answer instead of failing; a burst of reads on load no longer hits Too many requests; the same connect or network request sent twice shares one review; pages get a disconnect event when the extension reloads.

### Changed

- Websites list the wallet as "0xio Wallet".
- Removing a wallet lists its connected sites first, removes it from every site and disconnects a site left with none.
- Wallet names stand as rows, never inside sentences, on site reviews and the footer.
- Call details name each argument (To network, Recipient, Minimum received, Expires, Swap ID) from the contract ABI or the known SwapVault and bridge maps; View call data opens a page in the sheet with the method, selector, contract, every argument with its type and full value, and the raw input.

## v3.0.0

### Security

- No service keys in the build: price, history and RPC proxy calls go without a key.
- Locking shuts down the private balance engine and wipes its key and seed, in the popup and the background.
- The decrypted private balance is kept only for the browser session and cleared on lock; while locked, sites get WALLET_LOCKED for balances.
- Removing a wallet removes its cached balances, balance chart, EVM balances and history, and bridge transfers.
- Wallet data held in memory is emptied on lock.
- A custom chain is never priced as ETH, and only listed stablecoins on built-in chains count as $1.
- A site request signs only with the wallet its approval shows last; the site's binding and the network are re-checked right before signing.
- A wallet picked on an approval is re-checked against the vault (present, not watch-only) before the site moves to it.
- A site request with two different memos is refused; the approval shows the exact memo text that is signed.
- Site amounts and fees are read as whole base units by both the approval and the signer ("1e6" no longer shows 0.000001 OCT and signs 1 OCT).
- Custom network URLs must be http(s); an explorer link a site receives is http(s) only.
- EVM sends and bridge transactions are signed only after a review, with a key derived for that one signature, checked against the wallet's 0x address and wiped after.
- EVM history shows only ETH, listed and imported tokens, and held tokens Home shows; it drops zero-value transfers, spam-flagged and hidden tokens, so address-poisoning sends never appear.
- A site adding a chain the wallet already has never changes its RPC, name or symbol; it only asks to switch, and an approved switch turns an off chain on.
- The balance chart keeps only the public balance on disk; the private half stays in session storage. Older chart points that held both are removed.
- A wallet switch never shows the previous wallet's balances, not even for one frame; a lock from anywhere clears the decrypted private balance from Home.
- EVM Send: once a signed transfer reaches the RPC it is never signed again; a lost or failed reply follows the transfer by its own hash instead of returning to the form.
- EVM Send: the review is bound to the wallet, 0x address, network, RPC, recipient, amount and asset it shows, and the pending nonce is read again before signing; any change asks for a new review.
- EVM fees: a fee far above the network gas price, or above the cap of a built-in chain, is refused.
- The EVM key derivation wipes the master key and every intermediate node after use.
- Key update: a failed account state read blocks it; on a node without migration status a bare key update runs only when no encrypted balance exists, never on a decrypted 0.
- Claiming one transfer from its row opens the claim review first.
- Key update, Set up private balance and Migrate show the live network fee and check the public balance; the fee shown is the fee signed.
- Encrypt never registers a key behind its own review; a failed registration check blocks it.
- Send: a signed transfer that may have reached the node stays on Sending with Done and History settles it; only a node rejection returns to the form (token, bulk and private sends included).
- Send: one fee per send (your pick, else the live fee for a transfer, token call or private send) drives the shown fee, Max, every balance check and the signature; token sends no longer sign a fixed 3000 OU.
- Send: a failed fee read shows Network fee unavailable and blocks Review instead of a made-up fee.
- Bulk send reserves its whole nonce range, so another transaction never collides with it; unused nonces are freed on failure.
- Websites can no longer load the privacy engine, its workers or the offscreen page; only the content scripts (and the NFT renderer on Firefox) stay web accessible.

### Added

- Any chain to OCT: search tokens and chains in the pickers; chains you hold value on come first.
- Any chain to OCT: type what you pay or what you receive in OCT; the other field shows the live quote.
- Switching wallets says which wallet it switched to.
- NFTs: living pieces show the collection image first, then a poster captured in the background.
- Back up later: Create skips the phrase and the quiz; Home shows a Back up pill until the 12 words are written down, and Receive asks first.
- Backup screen: password, then the words blurred until Hold to show is held. Kept per wallet address.
- One import field for a recovery phrase, a private key or an address (view only), with a one-tap fix for a mistyped word and the found wallet's balance.
- Passkey offer after the password, where the browser supports one.
- NFTs: the three newest pieces, then each collection as a row that opens its grid, then Hidden.
- NFTs: hide a piece or a whole collection from its menu, with Undo; Hidden shows them again. Kept per network and wallet.
- NFTs: change a listing's price in one review (take down, approve, list again).
- Home: a Set up private tag when the wallet can turn on its private balance; its sheet shows the live one-time fee and registers the key on Turn on.
- Home: a Private on hold tag, and On hold on the Encrypted row, when the network holds the private balance (old format, no key update or migration open); its sheet shows the node's reason.
- EVM: a Choose your networks step after Create or a phrase import. Octra stays on; EVM is on by default and uses one 0x address from the same phrase (m/44'/60'/0'/0/0).
- Your wallet is ready lists the Octra and EVM addresses. A private key wallet says why it has no EVM address.
- Phrases from older 0xio versions get a note that other EVM wallets will not accept them.
- Home: a three-glyph switch in the header shows All networks, Octra or EVM. All networks sums both in USD; EVM lists ETH and stablecoins on every EVM network with a network badge on each logo and an All EVM filter.
- Receive: Octra and EVM tabs; the EVM tab shows the 0x address with the logos of its networks (past four, the first three and a count).
- Status bar: Not connected with an unplugged icon whenever no site is connected, Octra or EVM; tap for why and a link to Connected sites.
- Status bar: corner chips for the connected site (tap to disconnect), 0xio Desktop (Octra only) and Mainnet or Testnet, which moves Octra and the EVM networks together.
- Settings > EVM: turn EVM on or off for the open wallet. Off keeps the 0x address; private key wallets show why EVM is unavailable.
- Settings > Networks: Octra, then every EVM network of the side in one searchable list with a switch each. Off keeps the network but never checks it or shows it on Home.
- Network page: on or off, RPCs (add your own after a chain ID check, tap one to use it, remove yours), explorer and symbol. Remove network for added ones, Reset to default for built-ins.
- Add a network: 30 popular chains (17 mainnets, 13 testnets) with one tap, or a custom network that starts from its RPC and fills in the chain.
- EVM Send: ETH and listed tokens on Ethereum and Robinhood Chain, with a live fee, a review, then the status until it confirms. Send on All networks asks Octra or EVM.
- Token detail: one sheet for Octra and EVM with the price, a 1D, 7D or 1M chart that shows the price and time under the pointer, the balance, actions that keep the token, and recent activity. Removing an imported token asks first.
- Import token: an oct contract adds an Octra token; a 0x contract is looked up on every known EVM network at once and fills the network it is on, lists them when it is on several, or opens a network search.
- EVM NFTs: Octra and EVM collections in one list with a chain badge on each cover, following the Home switch. Holdings come from the 0xio oracle; images load through the 0xio proxy.
- EVM NFT import by contract and token ID with the same network detection; the preview checks this wallet holds it.
- EVM NFT detail: art, network, standard, contract and token ID, the explorer link, Hide with Undo, and Send (ERC-721 or ERC-1155) through a review.
- What's new in 3.0: one notice per person after the update, with Turn on EVM for every wallet that has a recovery phrase.
- Bridge: Any chain to OCT shows chain and token logos, bundled where possible and otherwise through the 0xio proxy.
- History lists Octra and EVM together by time; EVM rows open the explorer.
- Bridge inside the wallet: lock OCT on Octra and claim wOCT on Ethereum with the wallet's 0x address, or burn wOCT and receive OCT, each step with its own review. Claimable OCT to wOCT transfers are counted in the Bridge header and listed on the Claim page.
- wOCT is listed on Ethereum. The address book and the EVM send take 0x contacts.
- Bridge: Any chain to OCT. Pay with a token on any chain Relay lists from the wallet's 0x address; Relay buys wOCT and burns it to the Octra address. The order is checked against Relay's own chain list before signing, and an approval and the payment each get a review.
- EVM for websites: sites find 0xio through EIP-6963 (and window.ethereum when no other wallet set it). Connect, send, personal_sign, typed data (EIP-712), switch or add a chain and add a token each open a review; read calls go to the site's chain. Connected sites lists EVM sites with Disconnect.
- Website transactions use the wallet's live fee; the fee the site sent is used only when the network gives none, and the review says so.
- Sites can deploy contracts. EVM: a transaction with no recipient opens a Deploy a contract review with the new address, code size and live fee; the address is checked again before signing. Octra: deploy_contract (octra_deployContract) shows the code size, the address from the node, constructor params and the live fee.
- Settings > EVM: add a network (any EVM chain with an https RPC, checked before saving) or a preset (Base, Arbitrum One, OP Mainnet, Polygon), and import ERC-20 tokens by contract with a preview; Ethereum and Sepolia can look for tokens the address holds.
- Accounts added from a phrase get their own 0x address (the same index as their Octra account, as MetaMask derives it); older added accounts are linked when the wallet list opens. The wallet list shows both addresses on one line with a copy for each.
- Bridge: transfers are read back from the chains (Octra locks, Ethereum burns) the first time Bridge opens on a wallet, with Find transfers and Add by hash.
- Settings > Tokens and NFTs: a switch for every token and collection, in Shown on Home and Hidden as likely spam. Your switch always wins.
- Settings > Tokens and NFTs: imported tokens carry an Imported tag; tap one to remove it. It replaces the old Settings > Tokens screen.
- EVM tokens the 0x address holds are found through the 0xio oracle and join Home unless they look like spam; listed, imported and sent tokens are never spam.
- Octra tokens the wallet holds join Home too, judged by the same rules: links, bait words and look-alike OCT or WOCT.
- NFT collections whose names carry a link or bait words start hidden; showing one keeps it shown.
- Hidden tokens leave Home's rows and total and are never read for balances.
- EVM History lists transfers of detected tokens shown on Home; spam and hidden ones stay out.
- History reads every EVM network that is on, added ones through their Blockscout explorer, on open and Refresh only; a network with no history source is named at the end of the list.
- Detected EVM tokens show the explorer's logo (known image hosts only, through the 0xio proxy); spam tokens keep their initials.
- Site token approvals: a pencil on the Amount row edits it in place, with an ∞ toggle for Unlimited. The amount signed is the one shown, never above what the site asked unless you pick Unlimited.
- Add a network: search also covers the public chain list from chainlist.org (fetched on the first search, kept a day). A picked chain's RPC must answer with its chain ID before the review.
- Status bar: a Chain row in the connected EVM site's menu moves the site to another of your networks; the site gets chainChanged.
- History reads contract calls on Octra and EVM: the action (Swap, Approve, Bridge or the method in words), the contract by name, every asset moved in one row, and a sheet with method, arguments, Unlimited approvals and the fee.

### Fixed

- A screen opened after an update or rebuild reloads onto the new files instead of failing to load.
- Token details: switching the chart range keeps the last chart dimmed until the new one loads; nothing moves.
- Bridge: Cancel returns from typing a receiving address to your own.
- NFTs: List for sale shows only once the collection is known to trade, never for a moment and then gone.
- NFTs: a reopened NFTs screen shows each image at once without fading in again; the empty and loading states sit in the middle.
- Every History row opens a details card, EVM included: amount, status, type, from and to, token, network, Copy hash and View in explorer. No close X, no toast, and no fee shown when it is unknown.
- History never shows the previous wallet's list or pending items after a switch.
- Switching wallets no longer flashes a full-screen spinner or an empty Home: the switch lands on the new wallet's last balance, chart, rows and tags in one frame, and the add-wallet flow reaches its ready step.
- Security: Reset wallet is a quiet row under This browser; the page scrolls instead of cutting off the password rows.
- A listed NFT is held by Xpectrum, without the extra clause.
- Import says so when an EVM private key or a 0x address is pasted, instead of waiting silently; a 0x address no longer becomes a broken view-only wallet.
- Escape closes the top sheet even after the button that had focus was replaced.
- Text fields inside sheets keep a visible background when not focused.
- An EVM chart that was still loading when Home closed no longer stays blank for 5 minutes.
- Switching wallets during a bridge recovery scan no longer saves one wallet's transfers under another.
- A failed token read keeps the last balances; an unknown balance shows --- instead of 0.
- Oracle prices are checked before use, polled once for the whole popup, and not while it is hidden; EVM balances pause while hidden too.
- EVM history drops rows whose transaction hash is malformed.
- Opening the extension while locked showed Home for a moment before the lock screen.
- The status bar could not see the open website (no tab access), so Not connected and the connected site chip never showed. The popup now reads the current tab when it opens (activeTab).
- Wallet events (account or network change, disconnect) did not reach most sites, because tab addresses are hidden without the tabs permission; they now go to the tabs and frames that used the wallet.
- Home: the day's change on Octra follows the value held, so an empty wallet shows 0.0% instead of the OCT price move.
- Approval windows no longer show the status bar.
- Backup > Private key shows the EVM key too, with its own QR code, when EVM is on.
- Home charts EVM and All networks as well: the EVM line is the holdings' value over the day from DefiLlama prices.
- "1,5" sent 15 OCT; a comma is read as the decimal point and letters, minus and "1e5" are refused.
- Amounts lost 1 micro-OCT to float rounding (1.005 sent 1004999); amounts are converted exactly.
- Recipient addresses must be oct plus 44 base58 characters; pasted spaces are stripped.
- Bulk send checks every address and amount and counts the fees in the total.
- Custom fee is whole OU from 100 to 10,000,000.
- Token sends no longer show a memo they cannot send. Memo length is counted in bytes and never splits a character.
- Token import saves the contract that was looked up, not a later edit of the field.
- Long wallet, token and network names are cut with an ellipsis. Error lines sit in reserved space.
- Home: a failed Octra token read keeps the last balances or shows --, never 0; imported tokens no longer vanish or read 0 on a failed read.
- Home: balances not read yet show -- instead of 0; while the private half decrypts, the total shows the public half and updates in place.
- Home: the total and the rows use the same prices; Octra tokens are priced by contract (only the real wOCT at the OCT price), never by symbol; unpriced tokens stay out of the total.
- Home: the total shows -- only before anything is read and shows what is known while the rest loads; a network or token read that failed notes that some balances are missing. The private half never does.
- Home: Encrypted reads 0 for a wallet with nothing encrypted (no private set up yet) instead of ---.
- Token details no longer scroll sideways.
- Settings shows every row instead of cutting off the last four.
- Home: received OCT shows in the total while the popup is open.
- Home: a token list outage no longer hides OCT, the encrypted row or EVM rows; the list is cached for 6 hours.
- Home: refresh re-reads Octra token balances too, and large token balances show exactly.
- Home: an imported ERC-20 that fails one read keeps its last balance; networks turned off never flash on open.
- Home: the All networks chart ends on the headline number.
- Home on your own node lists OCT, and its encrypted row when the node has privacy.
- A token this wallet sent stays never spam however old the send is; sends are kept per network and address.
- EVM Send: a transfer still unconfirmed after 5 minutes ends as Still pending or Replaced or dropped, with the explorer link, and balances refresh.
- EVM fees: only a node without eth_feeHistory or a chain without a base fee falls back to the gas price (type 2 capped at twice the gas price, legacy EIP-155 on chains with no base fee); a rate limit or timeout is tried once more and then fails.
- EVM Send refuses the zero address and the token's own contract as the recipient.
- EVM Send: a late Max answer never lands on another asset or a typed amount.
- Privacy fees: a failed fee read shows Network fee unavailable and blocks the op instead of a fixed fee shown as live (encrypt, decrypt, claim, key update, site claims).
- Encrypt, decrypt and claim take the nonce after the proofs and give it back when signing fails.
- Encrypt counts the fee against the public balance; decrypt and claim check the public balance covers the fee.
- A pending key update is tracked by its on-chain hash.
- A private balance this key cannot read shows as unknown instead of 0 and is not stored.
- Privacy reads stay on the network the flow started on.
- Home and Privacy agree on a held private balance: only migration routes the wallet can run count as open.
- Bulk send reads Sent only once every transfer confirms on chain.
- Bulk send always sends OCT: entering Bulk drops a selected token, and the review shows the message the transfers carry.
- Token sends check the public OCT balance covers the fee; a node rejection frees the nonce and drops the pending History row.
- A token with 0 decimals no longer reads as 6; token balances stay exact, so Max never exceeds what is held.
- Send and bulk send refuse your own address with an inline note.
- History on a custom network listed nothing and its rows opened octrascan; each row opens its own network's explorer.
- Cancel on a queued tx really cancels it, only before it reaches a node; a tx already sent offers Hide (this device only) and never claims to cancel.
- A pending tx no longer shows twice while its hash lands; the mempool block skips rows already listed and follows the network.
- A pending tx is matched to a confirmed row only by this wallet's own non-call sends with a hash no other row holds.
- A rate-limited or timed-out status lookup is no longer read as not found, so live txs are not dropped.
- Dropped and expired txs read as failed in History and after a private op.
- Pending txs are reconciled against the network they were sent on, not the active one.
- A confirmed tx stays in History while the indexer catches up.
- Failed local rows can be hidden and leave after 7 days.
- Rows and details show the same sign; a failed tx shows none.
- EVM: ETH spent in a tx that also moved a token shows as its own row.
- A node rejection of a queued tx shows its reason, is not retried and frees the nonce.
- Settings no longer shows Back up again once the wallet has been backed up again.
- History: a contract call that moved nothing (List, Cancel listing, Approve) shows no 0 OCT or 0 ETH; its sheet keeps the action as the title.
- History: EVM dust reads < 0.000001 with no sign instead of -< 0.000001.
- EVM call details leave out raw bytes, gas limits and creation flags.

### Changed

- Store description mentions Ethereum and other EVM chains. Chrome needs version 111 or later; Firefox needs 140 (142 on Android).
- Firefox declares the data it sends: wallet addresses, balances and transactions go to RPC nodes, explorers, the bridge and price services.
- Bridge: a search button beside the Claim pill opens Find on the Bridge and Claim pages.
- Wallets list where each wallet comes from: Phrase, Private key or Watch-only.
- Settings > EVM drops its token import; tokens are imported from the token list.
- Security drops the status-only Wallet Password row.
- Send on Octra: the review slides up like EVM send, and a result screen shows Sending, then Sent once the network confirms it (Queued for private sends).
- Pages crossfade instead of sliding; onboarding steps fade only their content while the header and Continue stay still.
- Onboarding: every step keeps one Continue in the same place (Not now moved to the top right of Passkey); titles sit on one fixed block so fields never shift.
- Password strength shows blue bars and a grey word; red is only for passwords that do not match.
- Networks: Octra reads Always on; the EVM row toggles from anywhere on the row. Switches have a visible off track.
- Your wallet is ready labels the Octra and EVM addresses with their mark and cuts them to fit the small popup.
- Focus rings on the onboarding fields; focus moves to the step title on steps without a field. The mascot peek no longer bounces.
- First run: the password is typed on one screen and confirmed on the next, and setup ends on Your wallet is ready.
- Welcome: the terms are a footnote instead of a checkbox; Watch address moved into the import field.
- Wallet list: Create saves at once and ends on Your wallet is ready; Watch an address is covered by Import.
- Connected sites stay on their own wallet: switching wallets no longer asks to move them, and their requests sign with their wallet.
- Approvals end with the signing wallet and its balance; tap it to sign with another wallet, which moves the site there.
- A private request from a site on another wallet asks first: switch to that wallet, or move the site to the open one.
- The status bar names the site's wallet when it is not the open one.
- A site whose wallet was removed is asked to connect again.
- NFTs show every collection the wallet holds without an import step; Import stays for other contracts. Collections ignored before start hidden.
- NFT piece page: art, traits, status, held by, contract, with List for sale and Send (or Change price and Cancel listing) at the foot.
- NFT approve, list, cancel and send each open a review with the fee before signing, with USD next to every OCT amount.
- Home tags sit at the top right of the balance card, most urgent first: Move funds, Back up, Key update blocked, Set up private.
- A padded import shows a Move funds tag and sheet instead of the red box over the balance.
- Back up again is a Back up tag instead of a card under the balance; its first screen says Back up again.
- Dim is black and white: neutral greys, a white key with a lit edge as the only accent, small spaced capitals for labels and thin numerals for amounts.
- Home: Send is a white pill beside one dock for Receive, Bridge, Privacy and History, named on hover; on EVM, Privacy stays visible but disabled.
- The balance chart follows the day: green up, red down, grey when flat, fading out at both sides.
- The status bar is a blurred glass strip that lists scroll beneath. Every Home edge sits on the header margin.
- Lists are rounded panels with soft shadows instead of ruled lines; sheets close by dragging, an outside click or Escape, without a close button.
- EVM dollar values come from DefiLlama, so they keep working when the oracle is down.
- Home reads balances lightly every 30s and not at all while hidden or locked; it no longer runs a history poll. Token metadata is read once and cached.
- History is one list per address: Octra mainnet, devnet and the active custom network, and every EVM chain, each row labelled with its network; test networks read (test).
- Bridge fits the popup without scrolling; a Claim pill in its header opens a Claim page for OCT to wOCT with Ready, In progress and Completed as tabs with counts (Ready first, the wait shown as hours left), and a Find sheet for Find my transfers and Add by hash. An approved burn is resumed from the form.
- Bridge works for wallets imported from an Octra key: lock to a typed 0x address here, then claim, burn or pay from any EVM wallet on bridge.0xio.xyz.
- Toasts are one quiet pill above the status bar: a small red or blue dot, fixed size text, no outline or close button. Tap, swipe down or Escape dismisses; errors stay until dismissed, info fades after 4s.
- Success toasts are gone: copy buttons show Copied in place, and saved settings, renames, removals and claims show in the screen itself.
- Toast copy is plain and short; raw node and network errors go to the log, not the screen.
- Wording: standard wallet terms throughout, in all five languages (Insufficient balance, Network fee, Max fee, quotes, Pending and Completed, Watch-only, Reject on site requests).
- Wrong password in the reveal, passkey and delete sheets shows under the field.

## v2.5.7

### Security

- Every transaction is bound to the network, RPC and wallet it was reviewed on. A switch before it is sent, or before a queued retry, refuses it instead of sending it to the other network.
- Nonces, encryption key checks, pending key updates, claim budgets and claim scans are kept per network and wallet.
- Changing a custom network's RPC address makes it a new network: nothing kept for the old endpoint carries over.
- The proof workers serve only the wallet they were built for: a wallet switch rebuilds them under the new key instead of reusing the previous wallet's, and every request is checked against the active wallet.

### Fixed

- No success toast after encrypt, decrypt, migrate, key update, private send, claim, NFT send or listing cancel; a claim that lands on another wallet or network still says so.
- A zero balance reads $0 instead of < $0.01.
- No toast after creating, importing or watching a wallet, or adding an account; the import step shows the address without a Wallet found label.
- Signed messages verify with the 0xio SDK again: a stray 0x19 byte in the message framing (since 2.5.3) made every `verifyMessage` check fail.
- History, pending transactions, token balances, imported tokens, NFT details and the balance chart no longer show another network's or wallet's data after a switch.
- Custom networks are no longer tagged mainnet in History or reviews, and no longer get the mainnet token list.
- Sites are told when a transaction was refused or rejected instead of receiving a hash for it.
- Mainnet finds incoming private transfers: a node without the paged stealth read is read in one pass, and by id the same way.
- The claim scan resumes from where it stopped, per network and wallet, instead of from the first output every time; a failed page no longer moves it.
- A claim reads its output fresh from the node and checks the amount commitment before any proof; outputs claimed elsewhere leave the list. Waiting transfers are looked at again every 30 seconds.
- Site claims take a stealth output id and build the real claim; site requests for pending transfers list only this wallet's checked outputs.
- Site private sends build the stealth payload the Send screen builds; they used to send a plain recipient and amount.
- Burned NFTs leave the gallery instead of staying as empty tiles; one burned id no longer stops the owner scan.
- NFT and token holdings are read past the node's first page.
- Collections the node leaves out of the holdings (EUINT's newer contracts, such as Colonies) are found from the 0xio NFT list and, on mainnet, the 0xio indexer, and offered under detected NFTs.
- A busy node no longer drops NFTs: busy reads are asked again, and an owner scan that cannot finish keeps the NFTs already known.
- NFT metadata files and living programs are no longer kept on disk, since a file can change at the same path.

### Added

- Chain-state living NFTs (EUINT): the program may read its own network's RPC endpoint (`connect-src` names that endpoint only, never another host or the 0xio proxy), gets its full query, and reads custom nodes through the read-only bridge.
- Inline `data:application/json` token metadata.
- Collections the devnet registry does not list are found through `balance_of` and `owners_page`.
- The 0xio mascot: it peeks in on first open, turns its dial to unlock and while loading, dozes on the lock screen and wakes on input, and presses layers in (encrypt) or lifts them off (decrypt) during private operations.

### Changed

- Requests through the 0xio relay name the extension (x-0xio-client), so its load shows apart from other callers.
- Home balance chart is shaded below the line, like the token chart.
- New 0xio logo (the capsule mark) in the toolbar icons and across the wallet; a confirmed transaction shows the mark instead of a tick.
- Unused icon copies (`public/icons/`, `icon1024.png`) no longer ship in the package.
- No ticks anywhere: copy shows "Copied" in place, selections are filled rows or boxes, swap steps are dots, and loading spinners are the mascot's dial (layers during private operations).
- Private proofs are about 3x faster (rebuilt PVAC engine), and the proof generator table is built in the background after unlock instead of during the first proof.
- Private send, decrypt and key switch build their independent proofs side by side; on Firefox each runs on its own worker.

## v2.5.6

### Security

- Vault sealed under a random vault key wrapped by the password (or the device key); the session holds the vault key, never the password. Upgraded on first unlock.
- Network switches requested by a site need approval and are refused while that site has a pending request.
- Connected sites stay bound to the wallet they connected with; switching wallets asks to move or keep them.
- 0xio Desktop receives a one-way hash instead of the wallet key (needs Desktop 0.4.0+).
- Approval-window unlock counts toward the lock-screen lockout; the password never leaves the window.
- First-run password is required (8+ characters, optional passkey).
- Backup check: a wrong word restarts it with new positions and choices, so it cannot be passed by trying every option.

### Fixed

- First-run Create saved a different keypair than the recovery phrase it showed (since 2026-05-18). Affected wallets show a "Back up again" card.
- NFT and token transfers in History, token activity and transaction details read as "Sent NFT #5 GDSC" / "Received NFT" or the token amount, never "0 OCT".
- Bridge unlocks read as "Bridge unlock +N OCT"; calls that reach the wallet without a transfer no longer wait on "..."; zero-OCT calls show no sign; private sends show "Hidden".
- History kept on the device is rebuilt once so rows saved before these fixes are read again.
- Token details "Recent" lists only the current network's transactions.
- Token details "Recent" uses the History row: no icons, contract calls named by their method ("approve", "mint") instead of "Contract Call".
- Transactions timed on an exact second (about 1 in 1000) no longer fail the node's signature check.
- Add account skips indices whose address fails the 47-character check.
- RPC proxy is opt-in only: no fallback to or from it; mainnet and devnet only.
- Custom networks: own history, own explorer, own privacy setting, no relay; sites can switch to them.
- Passkey is re-wrapped on password change; a closed passkey prompt no longer counts as a wrong password.
- Sites see the installed wallet version instead of 2.5.2.
- Six listeners and timers were left running after their screens closed.
- Living NFT thumbnails persist across popup reopens.
- Tertiary text now passes 4.5:1 contrast in Dim, Day and Octra.
- Home header wallet name uses the full width.

### Added

- One add-wallet flow for first run and the wallet list: create, import, watch, add account.
- Three-word backup check after the recovery phrase.
- Import field detects a recovery phrase or a private key; word grid on request.
- Terms of Service and Privacy Policy consent on the welcome screen.
- Settings hub with a status line per section: Security, Backup, Connections, Appearance, Network, Tokens.
- Page and step transitions (forward from the right, back from the left; none on open or unlock).
- Wallet picture per address, shared with the mobile app.
- Recovery phrase and private key sheet with Reveal, Copy and a QR code for the mobile app.
- Wallet shown on message-signing requests.

### Changed

- Dialogs open as bottom sheets instead of centred popups (password, passkey, confirmations, rename, delete, memo, token import, reset); Escape closes them.
- Recovery phrase stays hidden until Show words; the private key is no longer shown beside it.
- Derive renamed Add account; picks the next free account number and previews the address.
- Home quick actions: Send and Receive, then Privacy, Bridge and History; Swap hidden while paused.
- Header wallet picture opens the wallet list.
- Lock screen: logo and "Welcome back"; Unlock with passkey is the main action when a passkey is set.
- Lock screen errors, Caps Lock hint, show password and lockout countdown shown under the field.
- Password dialog validates in place instead of toasts.
- Node polling reduced (snapshot every 2 min, no polling from hidden tabs, per-site request budget).
- Privacy features are disabled on networks added without privacy support.
- NFT gallery: Recent first, top six collections, searchable "Show all"; pinned toolbar and sheet search.
- Buttons scale slightly when pressed; the logo respects reduced motion.

## v2.5.5

- **Custom tokens no longer show OCT's price movement:** a token's detail page charted the OCT price feed and printed its 24h change beside that token's balance, so an asset we track no price for appeared to be down 39.5%. The chart and the change are now hidden for tokens without their own price data.
- **Token logos reach the detail screen:** a listed token showed its logo in the asset list but fell back to letters when opened, because the logo was never passed through. Both views now show the same mark, and the plate behind it is gone when there's real artwork.
- **Address book:** with wallets listed and no saved contacts, the screen showed your wallets above a message saying you had none. Contacts are now their own labelled group.
- **NFT media is size-checked before decoding,** matching the desktop and mobile wallets, so an oversized response from a node can't be decoded into memory unchecked.
- **Token details open as a sheet:** tapping an asset slides a panel up over the wallet instead of replacing the screen, so the balance chart behind it no longer flickers on the way in or out. Drag it down to dismiss. Inside: one number with its value and 24h change, a bare price chart, recent activity, and Send / Receive / Encrypt at the foot.
- **A quieter home screen:** the 24h change reads as +1.2% instead of an arrow, the asset tabs are plain text, and Privacy / Swap / Bridge sit in a single line under the actions (Swap moved there from the quick actions). Two unused stylesheets were removed, one of which was quietly forcing the balance area taller than its content.
- **Lock screen:** the password field and the Unlock button share the full width at the same height, an empty submit is flagged in red without shifting the layout, and the logo sits closer to the title.
- **Consistent greys and text sizes on every screen:** three competing grey shades became two, and off-scale sizes were snapped to the scale, so the same kind of label looks the same everywhere.
- **A quieter send screen:** Normal / Private and Single / Bulk are plain text on one line, the recipient and amount are simple fields without frames, and the fee is a single tappable line above the Review button. The fee picker itself is simpler: three plain tiers, a custom field, one Save (this also applies to NFT transfers). The amount field adds thousands separators as you type, shrinks long numbers to fit, and can take dollars instead - tap the value under it to switch, the OCT equivalent is shown beneath. The field turns red the moment the amount is more than you have. The review sheet is rebuilt to match: one number, a ruled list of details, and the same two-step confirm. The dollar value comes from the live price (it was a fixed rate), the token picker closes when you tap anywhere else, and the bulk private notice points to the desktop download.
- **Settings and History, simplified:** Settings is three plain lists with no icons or boxes, and every screen inside it (Preferences, Security and backup, Address book, Connected dApps, Imported tokens) follows the same lists and quiet fields, with the password, key and network dialogs rebuilt to match. History is one ruled list with plain-text network tabs, statuses written as words instead of badges, and the date and counterparty on one line; the devnet and watch-only notices are quiet lines instead of coloured boxes.
- **Privacy screen, simplified:** Encrypt, Decrypt and Claim are plain text, balances are two ruled rows, the amount is the same quiet field as Send and turns red when it is more than you have, and the fee is one tappable line that opens the same fee picker Send uses.
- **Adding a wallet, simplified:** the four ways to add one are plain rows, the wallet list is rows with a muted Active or Watch word, and the create, import, watch and derive forms use the same quiet fields as the rest of the wallet, with the seed cells and the back-up grid as hairline cells. Rename and delete are small dialogs that cannot be dismissed while working.
- **NFTs on a slow node:** a node that failed to answer was being read as "you own nothing", which could wipe a collection's grid, skip real imports during the per-wallet migration, or show the empty state where a retry belonged. Every read now tells failure from empty: the gallery keeps the last-known counts, a collection that could not be enumerated offers Retry, and the 60-second refresh actually refreshes (it was returning early). The saved snapshot no longer inlines large images, so it stays well under the browser's storage quota; tiles reload them from the local asset cache.
- **NFT market state can no longer be clobbered:** a listing check still in flight when you approved, listed or cancelled could overwrite the verified result a moment later. Open-time reads are now dropped once you act, and when the node cannot verify a confirmed listing or cancel the wallet says so instead of reporting failure or success.
- **Living NFT renderer locked to inline assets:** the sandboxed frame could load remote images, media and fonts, which a hostile program could use as a beacon. It is now limited to inline data, and a poster frame is accepted only as a bounded image.
- **NFT transfer fee is the one you picked:** the fee tier chosen in the transfer sheet was informational; it is now sent with the transaction. The sheet also can no longer be swiped away mid-send, which left it invisible but mounted.
- **Swap is paused:** the Swap entry on the home screen is disabled for now.
- **The back button sits in the same place on every screen.** The NFT detail page capped and centred its panel, which shifted its header sideways against the collectibles screen behind it. The claim screen showed no back button at all.
- **NFT send: the address book floats over the sheet.** Opening the recipient list used to grow the sheet; it now floats over the page below the field (above it when there is no room) and scrolls on its own.
- **Private transfers and claims requested by a site pay the right fee:** the dApp path submitted stealth sends with the plain-send fee, which mainnet rejects as too low. Both now use the live network quote (a site may pin its own), the approval window shows that fee, the recipient is checked up front, and a send from a balance that cannot be proven (over the layer cap or held for migration) is refused with the reason before minutes of proof work.
- **Rejected privacy operations free their nonce:** claims, encrypt, decrypt and the key switch now release the reserved nonce on a server rejection, like sends.
- **Updating the wallet no longer loses queued transactions silently:** anything still queued at update time is marked failed in History with a note to send it again.
- **Passkey unlock now keys off the authenticator:** the password was encrypted with a key derived from the passkey's credential id, which sits in storage next to it, so a copy of the extension's storage could recover the password without a fingerprint. The key now comes from the WebAuthn PRF extension, which only the authenticator produces after a successful check. Older passkey records are retired on sight; re-enable the passkey in Security and backup. Passkeys without PRF support are refused with an explanation.
- **Sites must connect before they can ask for anything that signs or changes state:** sending, contract calls, signing, broadcasting, view-key registration and network switching all required no connection. dApp registration stays open because the SDK registers before connecting, but it no longer writes anything to storage. A page that is not connected now gets a refusal instead of a prompt, a page can open the unlock screen at most once a minute, the availability probe no longer reveals whether the wallet is unlocked to unconnected pages, and a broadcast request must come from the connected address so it cannot plant a fake pending transaction in History.
- **Claims from a site need your approval:** claiming a private transfer through a connected dApp signed and paid a fee with no prompt. It now opens the same approval window as every other write.
- **The approval window says what it signs:** private transfers showed the amount a million times too small, claims and view-key registration read as "Send 0 OCT", a plain send showed a fee of 3 OU instead of the real default, and a sequence of contract calls listed only method names. Each now has its own title, private-op fees say "Set at submit", and every step of a sequence is spelled out with its contract, attached value and fee.
- **Wallet events reach only the exact site:** lock, unlock, account and balance events were matched by hostname, so an http page on the same host as a connected https site received them. Matching is now by full origin.
- **A rejected send no longer blocks the next one:** the nonce reserved for a transaction the node refused was kept for two minutes, so the following send carried a nonce one too high and failed. Definitive rejections now free it (unit-tested).
- **Sending your whole balance:** the spendable amount and Max now subtract the network fee (one per recipient for bulk), so an amount that would fail at the node is flagged in the form.
- **Clear all data also wipes the NFT asset cache** (it lives in IndexedDB, outside the storage that was cleared), the background worker drops its cached session key when the wallet locks, pending-transaction reconciliation and the balance chart work on custom networks, retry logic no longer treats an amount containing 400 as a fatal error, explorer links open without handing the page a reference to the wallet, and the dead devnet address is gone from the manifest.
- **Collectibles, simplified:** the gallery is a quiet summary line and plain rows with a count, Import and Manage are sheets that slide up (Enter submits, and Manage lists what you hold, what you have imported and what you have ignored as rows with Import, Ignore, Remove and Restore as words), and every label is a sentence instead of small capitals. An NFT opens as a page: the art, its name, a plain description, then a ruled list of facts (token, edition, contract that copies on tap, live render, attributes, rarity, marketplace) with Send and List or Cancel listing at the foot. More, List for sale and Send NFT are sheets on the same grammar as the rest of the wallet; the price is one number with OCT or USD as plain text, and the Send sheet uses the Send screen's fee line and cannot be swiped away mid-send. Tile statuses (price, Live, Approved, Unhide) are quiet words.

## v2.5.4

- **Private balances now work with the rest of the Octra network:** the wallet's encryption core was byte-for-byte realigned with the canonical implementation (H matrix generation, omega derivation, commitment hashing, wire format). Balances encrypted here are now readable by other Octra wallets and vice versa; proofs verify on-chain. Balances written by older versions remain readable through a built-in legacy fallback and are paused for private operations until upgraded.
- **Migrate balance, fixed and unified:** migrations were silently expiring in the network's staging area because the payload's anti-replay anchor hashed the wrong bytes - fixed, and a migration now confirms in minutes. One Migrate flow everywhere (Privacy tabs, Claim, private Send): a confirm popup shows the live network fee and checks your public balance before any proof work, progress runs inside the popup, the built payload is cached so an expired attempt resubmits in seconds at the fast fee tier, and a staged migration can never be double-submitted ("Upgrade in progress").
- **Compact balance is retired:** for current balances the migration IS the compaction - every over-limit surface now offers the same "Migrate balance" action instead of a compact that the network refuses.
- **One private operation per migrate cycle:** claims go one at a time ("Review claim (1 of N)") with honest guidance between them; the send button resolves the balance state up front ("Checking balance..." -> "Migrate balance" or "Review private send") instead of failing minutes into proof generation.
- **No more 7-second freezes:** the balance-state check was building a heavy crypto context on the UI thread the first time any screen ran it, freezing all input (~6.6s). It now runs in the worker pool; the popup stays responsive.
- **Faster migrations with 0xio Desktop:** when the desktop app is connected, the migration proofs build on native code instead of in-browser WASM.
- **Truthful transaction lifecycle:** dropped/expired transactions stop showing as Pending within seconds (previously up to 6 hours), dismissing a pending entry removes only that entry, and the migration fee shown is exactly the fee paid.
- **Address book:** your own wallets now appear automatically in a "My wallets" section, and the recipient dropdown refreshes from the live address book on every open.
- **Readability fixes:** white-on-pastel text corrected on several confirm/delete buttons across themes; long proof steps show a moving indeterminate bar instead of a full one.

## v2.5.3

- **Claim protection (brick preventer):** every balance-changing private operation adds encryption layers, and past a hard limit a balance can no longer be compacted - permanently freezing it. Claims were the one un-gated path there. The wallet now keeps a persistent per-account claim budget (shared across popup and background, refused when the balance state is unreadable) and stops any claim batch before it can cross the limit, telling you to compact first.
- **Safer claim batches:** a failed claim no longer burns the transaction nonce for the rest of the batch, partial successes report exactly what was claimed, and the "compact first" instruction is never swallowed by a success toast.
- **Key recognition fixed:** the wallet now recognizes its own registered keys in every historical form (webcli 3-way check ported to the PVAC core), ending false "encryption key mismatch" flags after network upgrades.
- **Honest hold states:** an account whose private balance awaits the network's v3 migration now says "your key is fine, balance awaiting migration" instead of a key scare; decrypt no longer offers a compact the node would refuse.
- **In-place compact on private send:** the compact-balance step runs inside the send flow with progress, then continues to review - no more detour to the Decrypt tab. Compacts pre-check the node and fail fast when key updates are refused.
- **Claim at scale:** stealth-output scanning is paginated, surviving past a thousand on-chain outputs.
- **Truthful proof progress:** the frozen "Circuit 0/65" counter is gone; the bound proof shows an indeterminate bar plus elapsed time.
- **Silent production builds:** console output is stripped from all shipped JS, including the WASM glue and workers.

## v2.5.2

- **Security hardening:** The encrypted vault is no longer decryptable at rest by the stored password verifier - the verifier and the AES key are now derived separately, and existing wallets migrate on the next unlock. `signMessage` is domain-separated (`"Octra Signed Message:\n<len>\n<message>"`) so a site can't get you to sign a fund-moving transaction disguised as a plain message, and it now requires an established connection. Removed a dead code path that could have placed the private key in an HTTP header.
- **Custom networks + chain detection:** Add your own Octra RPC endpoint from Preferences. Adding one now shows a trust warning (a custom RPC sees all your activity and can replay signed transactions onto another Octra network), and detection is an informational hint only - it never claims a verified identity or silently enables privacy.
- **Desktop connection:** The bottom-bar "No Desktop" status is now a Connect button that re-probes 0xio Desktop on demand (the automatic probe only ran at launch), with toast feedback. Compaction shows "via 0xio Desktop" while the desktop generates the proof.
- **Private-balance blocked state:** An account whose key update is on hold keeps encrypt/decrypt disabled even after the notice is dismissed - acknowledging it no longer re-enables the operations.
- **Fees:** A private (stealth) send falls back to the 1,000,000 OU standard when the node's recommended fee is unavailable, matching webcli, so it isn't rejected as "fee too low."
- **Design:** The "Review claim" button and the custom-network delete control now use the wallet's accent design tokens like the other primary actions.

## v2.5.1

- **Cross-chain swap (OCT -> ETH):** In-wallet cross-chain swap backed by the 0xio solver. A live, debounced quote auto-refreshes behind a freshness ring; OCT is locked in the SwapVault and a 3-stage progress stepper polls the solver through fill and settle. Replaces the earlier mock swap screen with the real quote -> lock -> fill -> settle flow.

## v2.5.0

- **Firefox support:** First cross-browser release. A dedicated Firefox build (`npm run build:firefox` -> `dist-firefox/`) emits an event-page manifest, ships the single-threaded (non-SAB) PVAC WASM, and runs the heavy range-proof work via the existing multi-worker bit-split pool (Firefox extensions can't use `SharedArrayBuffer`/threaded rayon). Chrome build is unchanged.
- **Cross-browser popup sizing:** The wide/full-tab layout is now triggered by an explicit `?view=expanded` marker instead of a window-size heuristic (which misfired in Firefox popups), and `<html>` is pinned to a hard 400px floor so Firefox's content-driven popup sizing matches Chrome.

## v2.4.4

- **Collectibles Screen & Cached Gallery:** Dedicated `/collectibles` screen with a flat NFT grid + on-chain storage enumeration, a Collections strip, per-tile overlays, and Hide/Unhide (with a warning when hiding a listed item). Resolved gallery data, circle assets, and per-contract ABIs are cached (disk + persisted snapshot) so reopening is instant, with a background refresh; a marketplace-compatibility gate hides marketplace UI on collections it can't serve
- **Full-Height NFT Detail:** Redesigned detail page - full-bleed hero, glass header, Share, and a `⋯` overflow menu (view on explorer, copy link, refresh metadata). Token ID / Edition / Contract info is centred with a pinned bottom action bar: **List for sale** and **Send** sit side-by-side; Send is disabled while the item is listed (in escrow) and goes full-width when the collection isn't listable
- **EUINT Living NFTs:** Sandboxed living-NFT renderer - an `oct://…html` program runs in a nested opaque-origin iframe with a read-only chain bridge (no wallet/network/key access), generative Web Audio gated to a speaker tap with wildcard-autoplay so cross-origin audio plays, a static poster captured from the first live render for grid thumbnails, retry-on-slow-node program fetch, and a CSP locked to `connect-src 'none'`. EUINT NFTs are send-only (never offered for listing)
- **Marketplace Refinements (Xpectrum):** Strict marketplace reads - a node timeout no longer reads as "not listed"; USD pricing in the list sheet; approval-aware single-signature listing; listed-pill + Approved badge on tiles that survive a slow/dead-node reopen; grouped price formatting (`100,000 OCT`)
- **NFT Transfer Bottom Sheet:** Transfer flow reworked into a bottom sheet (recipient -> review -> send -> done) with an address-book recipient drop-up and an OU fee-picker sheet. The transfer method is auto-detected from the contract ABI (SNS-1 `transfer`, single-token `transfer_to`, or ERC-721 `safe_transfer_from`), so one flow handles Geodesics, Bionts, and SNS NFTs. Token Send and NFT transfer now share `FeeSheet` + `RecipientField`
- **Full Localization:** The NFT surface and a long tail of app screens are localized across all five locales (en / zh / ja / ko / id)
- **Networking Robustness:** Hung RPC fetches are aborted via `AbortController` (12s/60s reads, 60s submit cap) instead of lingering ~20 min on a dead node; the nonce manager re-probes (retry balance, then `octra_account`) before declaring the network unreachable; the "network slow" banner clears on a network switch; a submit timeout surfaces "submitted - may be pending" instead of hanging
- **Console / Perf:** The living-NFT prelude forces `willReadFrequently` on the program's 2D canvas - silences Chrome's Canvas2D `getImageData` warning and speeds per-frame readbacks, trimming the `requestAnimationFrame` violations
- **Private Token dApp Provider:** New primitive-based provider surface so dApps (private tokens, dark pools) can drive private-token and private-AMM flows without ever touching wallet secrets. FHE primitives run headless via the offscreen document with keys kept in the background - `encrypt_value`, `decrypt_value`, `make_zero_proof`, `make_range_proof`, `get_private_balance` - plus `register_private_view_key`, one-approval nonce-sequenced `send_contract_transaction_sequence`, `get_private_capabilities` discovery, wrapped `contract_call_view`, and stable error codes. `connect` returns public key + wallet + version + granted permissions; sensitive primitives are permission-gated
- **Xpectrum NFT Support:** Renders composed (layered traits stacked on a canvas) and prerendered Xpectrum collections from on-chain circles (`circle_asset`), with a persistent composite cache and IPFS / `oct://` metadata + media resolution. The NFT detail view shows live listing status and lets you **list for sale** (approve marketplace -> `list_nft`) or **cancel a listing**, each verified by re-reading on-chain state. Hidden on networks without a configured marketplace; platform addresses are remote-config-ready
- **NFT Discovery (opt-in):** The NFTs tab surfaces NFT-shaped holdings (`octra_tokensByAddress`, `decimals: 0`) the wallet owns but hasn't imported, in a "NFTs you hold" section - each with **Import** or **Ignore**. Nothing is auto-imported, so unsolicited/scam airdrops are never silently listed; ignored collections are remembered per-network
- **Faster, More Reliable Privacy (PVAC/FHE):** Threaded WASM proof generation (rayon + shared memory + batch AES) with verifier hardening; FHE driven headlessly through the offscreen document; decrypt-timeout and runaway-worker fixes; detailed rayon init / proof-progress logging
- **Recommended OU Fees from RPC:** Privacy operations now fetch the recommended OU (gas) from the node instead of guessing
- **Custom Network in Bottom Switcher:** The bottom network switcher shows the active custom network instead of always labeling it "Mainnet"
- **RPC Official-First Fallback:** Reordered the JSON-RPC fallback chain to try the official endpoint first and dropped the dead mainnet IP
- **Token Hardening & Cleanup:** Sanitize token name/symbol from `octra_tokensByAddress`; removed the swap action button from the token detail screen
- **Dependency Security:** Vite 5 -> 6 and `@crxjs/vite-plugin` to stable 2.6.1 (clears the esbuild / Vite dev-server advisories), and vitest to 4.1.8 (GHSA-5xrq-8626-4rwp)

## v2.4.3

- **program_exec Contract Call Routing:** `send_transaction` and `sign_transaction` now detect `op_type: 'call'` or `encrypted_data` in params and route through `buildContractCallTransaction`, preserving method name, call params, and all contract call fields. Previously both handlers called `buildAndSignTransaction` unconditionally, producing plain transfers instead of `program_exec` transactions
- **Contract Call Approval UI:** Transaction approval popup now renders the contract call view (method name + parameters) for `sign_transaction` with `op_type: 'call'` or `encrypted_data`, not only for explicit `call_contract` requests. `to_` and `contract` fields are normalized to `to` before the popup opens so the recipient always displays correctly
- **Content Script Method Blocklist:** Replaced the `ALLOWED_METHODS` allowlist with a `BLOCKED_METHODS` blocklist covering internal-only background message types. New dApp methods are now available without manual allowlist updates; the background `handleDAppRequest` switch remains the real security boundary
- **Custom Token Delete from Detail Screen:** Trash icon in the token detail header for imported tokens - removes the token from `chrome.storage.local` and navigates back to the wallet

## v2.4.2

- **RFC-O-1 Provider Interface:** `window.octra` with `isOctra`, `request()`, `on/removeListener` - standard provider for third-party wallet interop. Multi-wallet registry via `window.octraProviders`. Error codes: 4001 (user rejected), 4100 (unauthorized), 4200 (unsupported), 4900/4901 (disconnected)
- **Privacy Transaction Preview:** Bottom sheet review for encrypt, decrypt, and claim operations - shows From/To flow, amount, fee, total deducted before confirmation
- **Proof Generation Overlay:** Fullscreen step-by-step progress matching private send UX - verify -> encrypt -> range proof (with circuit progress bar) -> submit. "Do not close" warning. Claim operations show live progress
- **Mainnet RPC Migration:** Primary endpoint moved to `https://octra.network/rpc` (HTTPS, no port blocking). Fallback to direct IP (bypasses nginx). HTTP 502/504 triggers automatic fallback
- **PVAC Decrypt Parallelism:** pvac-rs decrypt now parallelizes base layer PRF across CPU cores in production. WASM+rayon path for offscreen document. 4-8x speedup on multi-core
- **History Error 116 Retry:** When node returns "history index incomplete" with `missing: N`, automatically retries with reduced limit instead of returning empty
- **Pending->Confirmed Promotion:** RPC-confirmed transactions promoted to confirmed display immediately (MetaMask pattern) - no more stuck "Pending" when indexer is down
- **Claim Scan Progress:** Live progress during stealth output scanning ("Scanning 80/150 outputs (2 found)..."). 90s timeout on stealth RPC to prevent hang on truncated responses
- **History Refresh Button:** Manual refresh in history header with spin animation
- **DApp Privacy Transfers (SDK v2.6.0):** DApps can now initiate stealth transfers via `sendPrivateTransfer()`, list pending transfers via `getPendingPrivateTransfers()`, and claim via `claimPrivateTransfer()`. Extension handles PVAC ciphertext subtraction, proof generation, and approval popup. Requires `private_transfers` permission
- **RPC Token Migration:** Migrated token fetching to `octra_tokensByAddress` (replaces multi-call flow)
- **Production Logging:** Console/debugger stripping enabled in vite production builds
- **Balance Broadcast:** Extension fetches fresh balance 2s after every tx, broadcasts `balanceChanged` to all connected dApps

## v2.3.4

- **Network Mismatch Detection:** Detects when DApp and extension are on different networks, shows warning on connect and transaction approval popups
- **Network Quick Switch:** Rabby-style dropdown in bottom bar to switch between Mainnet and Devnet with debounce protection
- **DApp Network Auto-Detect:** Stores DApp's networkId on connect, compares with extension network before transactions
- **switchNetwork API:** DApps can request network switch via `wallet0xio.switchNetwork(id)`, extension broadcasts `networkChanged` event
- **Stealth Send Consensus Fix:** Added `send_zero_proof` (bound zero proof) to stealth transfer payload - required by Octra consensus
- **Key Switch Balance Warning:** Key switch overlay now warns about permanent encrypted balance loss with confirmation checkbox
- **Background PVAC Registration:** Pre-registers PVAC key on wallet load instead of blocking first encrypt/decrypt
- **Balance Snapshot Storage:** Stores balance snapshots locally every 30s for accurate portfolio chart (no more tx-reconstruction)
- **Removed Auto Key Switch:** Auto key switch in mobile disabled - user must manually decrypt before switching (prevents accidental balance loss)

## v2.3.2

- **Network-Aware Balance Dedup:** Encrypted balance requests now include network ID in dedup key, preventing stale mainnet data appearing on devnet (and vice versa)
- **Network Switch Balance Fix:** Immediate epoch + ref invalidation on network switch, stale in-flight requests discarded
- **OAT Network Awareness:** Token list only queries OAT contract balances on the network where they're deployed (fixes `bytecode not found` noise on mainnet)
- **Broadcast Timeout Scaling:** HFHE transactions (encrypt/decrypt/stealth) get 120s+ timeout instead of 30s (3.8MB payloads)
- **PVAC Pubkey Cache:** Deduplicates 4MB+ pvacPubkey fetches with 5-minute TTL cache
- **TX Hash Nonce Lookup:** Fallback nonce-based hash resolution when server omits tx_hash from broadcast response
- **DApp Connection Persistence:** Wallet connections persist across service worker restarts via `chrome.storage.local`

## v2.3.1

- **Live OCT Price Feeds:** Real-time OCT/USD price from 0xio oracle (CoinGecko + DexScreener multi-source aggregation)
- **USD Portfolio Worth:** Balance card displays total portfolio value in USD with OCT/USD toggle
- **Portfolio Worth Chart:** 24h chart reflects true portfolio worth (oracle price history × balance at each point in time)
- **Chart Hover Tooltip:** Shows interpolated portfolio worth + UTC time on hover, respects privacy toggle
- **NFT Collection Removal:** Three-dot menu on imported NFT collections with "Remove Collection" option
- **Production Console Stripping:** esbuild drops console.* and debugger statements in production builds

## Features (v2.3.0)

- **OAT Token Transfers:** Select and transfer OAT tokens from the Send screen alongside OCT
- **Fee Recommendations:** Dynamic fee estimates from the network via `octra_recommendedFee` RPC
- **HD Account Derivation:** Derive multiple wallet accounts from a single seed phrase
- **Token Auto-Discovery:** Automatic detection of token holdings from on-chain contracts
- **Custom RPC URL:** Configure a custom RPC endpoint in Settings to connect to any Octra-compatible node
- **Staging/Mempool View:** View pending (staging) transactions in the transaction history
- **Contract Call & Deploy History:** Transaction history now displays `call` and `deploy` operation types
- **Instant History Updates:** Pending transactions are injected into the history view immediately after submission
- **Fast Devnet History:** Transaction history on devnet fetches directly from the node RPC instead of the slower octrascan indexer
- **Internationalization (5 Languages):** Full coverage in English, Indonesian, Chinese, Japanese, and Korean, including new Send screen keys
