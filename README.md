# 0xio Wallet

Non-custodial browser wallet for the **Octra Network** with PVAC-HFHE privacy - encrypted balances, stealth transfers, and range proofs, all running client-side in a Chrome or Firefox extension.

- **Version:** 3.0.6
- **Platform:** Chromium 111+ and Firefox 140+ (Android 142+) on Manifest V3
- **License:** [GPL-3.0-only](LICENSE)
- **Copyright:** (C) 2025-2026 0xio Labs

## Features

- **Non-custodial** - keys are generated and stored on-device (AES-256-GCM vault, PBKDF2-SHA256).
- **Encrypted balances (PVAC-HFHE)** - move OCT between a public and a homomorphically-encrypted private balance; the network operates on ciphertexts it can't read.
- **Stealth transfers** - send OCT with the recipient hidden and the amount encrypted (ECDH x25519 + PVAC); the amount is proven in range with a compact aggregated proof, and claiming scans the on-chain outputs page by page from a stored point per network and wallet (one pass on a node without paging), and re-reads each output and checks its commitment before claiming; only an output the node reads as unspent is claimed, and a dropped or released claim is resent as its saved bytes only while the output reads unspent, its nonce is still the next one and its fee is the reviewed one, else built fresh. A site claim refuses with nothing sent as `CLAIM_OUTPUT_SPENT`, `CLAIM_OUTPUT_UNREADABLE` or `CLAIM_CONFLICT`, or as `RATE_LIMIT_EXCEEDED` or `NETWORK_ERROR` after the retry window; an output already claimed here returns the earlier hash.
- **Cross-chain swap** - in-wallet OCT <-> ETH swaps backed by the 0xio solver (live quote -> lock -> fill -> settle).
- **EVM** - a 0x address per account from the same phrase (m/44'/60'/0'/0/i) on Ethereum, Robinhood Chain and any network you add: balances, ERC-20 import, send with a live fee and a review, token charts (DefiLlama), history beside Octra's (Blockscout through the 0xio oracle, or an added network's own Blockscout explorer) with contract calls read by action and contract on both, and an EIP-1193 / EIP-6963 provider for websites.
- **Bridge** - OCT <-> wOCT inside the wallet (bridge to Ethereum and claim, or bridge back to Octra), any chain to OCT through Relay, and transfers read back from the chains. Every step has its own review, and the Octra network fee is read live.
- **NFTs** - every held collection without an import step (Import for the rest), newest pieces, hide with Undo, Xpectrum list and change price, SNS-1 and Biont collections, and sandboxed EUINT "living" NFTs.
- **Names (ONS)** - on a network with an ONS contract (devnet today): send to `name.oct` by picking the resolved address, with the name read again before signing; primary names shown beside addresses; names held show in NFTs with their own artwork read from `token_uri` like any NFT (a plate drawn by the wallet only when the artwork cannot be loaded), an Expired tag once expired, and Transfer while active. The contract address is read from the token-lists name list (`octra.namelist.json`) and checked on chain before use; the last address that passed is kept for when the list cannot be reached.
- **dApp provider** - inject a wallet provider into web pages, with an approval popup and a per-method permission boundary in the background worker.
- **Cross-browser** - one codebase builds for Chrome (threaded WASM) and Firefox (non-SAB WASM).
- **Localized** - English, Chinese, Japanese, Korean, Indonesian.

## Architecture

```
Popup UI (React 18)          Service Worker (MV3)       Content Script
 - Wallet management          - Transaction queue         - dApp provider bridge
 - Encrypt / decrypt          - RPC routing + fallback    - Message signing
 - Stealth send / claim       - Pending tx tracking       - Per-method permission gate
 - NFT gallery + swap         - dApp approval queue
```

Three-layer Manifest V3 design: the popup is ephemeral, the service worker is persistent and owns all network I/O, and the content script injects the provider for dApp connectivity. Heavy PVAC proof work runs off the main thread in Web Workers (and, when installed, the optional [0xio Desktop](https://github.com/0xio-xyz) native accelerator). A paired 0xio Desktop can also sign for sites: the extension relays their Octra requests to the menu bar wallet.

The privacy engine is a Rust crate ([`pvac-rs`](https://github.com/0xio-xyz/pvac-rs)) compiled to WebAssembly and bundled in `public/`.

## Build

Prerequisites: Node 22, npm 11 (`npm i -g npm@11` - the lockfile is npm 11).

```bash
npm ci
npm run build          # Chrome  -> dist/
npm run build:firefox  # Firefox -> dist-firefox/
```

Load unpacked: Chrome -> `chrome://extensions` (Developer Mode) -> "Load unpacked" -> `dist/`. Firefox -> `about:debugging` -> "Load Temporary Add-on" -> `dist-firefox/manifest.json`.

The wallet needs no API keys: the hosted 0xio services serve wallet reads without one, limited per IP.

To rebuild the PVAC WASM from source, see [`pvac-rs`](https://github.com/0xio-xyz/pvac-rs); the build scripts strip local paths and copy the artifacts into `public/` and `src/wasm/`.

## Security model

- Private keys never leave the device; the vault is AES-256-GCM under a random vault key, wrapped by PBKDF2-SHA256 (900k iterations) of the password.
- While unlocked, `chrome.storage.session` (RAM-only, cleared on browser close) holds that vault key, never the password; progressive lockout on failed unlocks.
- PVAC proofs run in isolated Web Workers; the WASM is loaded same-origin via `chrome.runtime.getURL()`, never fetched externally.
- The proof workers are bound to the wallet seed they were built from; every request carries a fingerprint of the active wallet's seed and is refused on a mismatch.
- dApp requests cross a per-method permission boundary in the background worker; approval popups show the requesting origin.
- No telemetry - the wallet talks only to Octra nodes and the configured 0xio services.

Found a vulnerability? See [SECURITY.md](SECURITY.md) for private disclosure.

## Contributing

Contributions are welcome under GPL-3.0-only - see [CONTRIBUTING.md](CONTRIBUTING.md). Version history is in [CHANGELOG.md](CHANGELOG.md).

## License

GPL-3.0-only - see [LICENSE](LICENSE). Bundled third-party components and the GPL-derived PVAC WASM are documented in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
