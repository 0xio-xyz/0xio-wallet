# Third-Party Notices

0xio Wallet is licensed under **GPL-3.0-only** (see [LICENSE](LICENSE)). It incorporates the following third-party components, whose licenses and attributions are reproduced here.

## PVAC-HFHE / privacy engine (WebAssembly)

The bundled `public/pvac_rs_bg.wasm`, `src/wasm/pvac_rs_bg.wasm`, and the Firefox variants are a Rust port of the PVAC-HFHE privacy engine in Octra Labs' reference client, [webcli](https://github.com/octra-labs/webcli), by **Octra Labs / lambda0xe**:

- Upstream [octra-labs/webcli](https://github.com/octra-labs/webcli) (Octra Labs) - **GPL-2.0-or-later**
- Upstream `octra-labs/pvac_hfhe_cpp` - **GPL-3.0**

Because these are copyleft, this extension as a whole is distributed under **GPL-3.0-only**. The engine follows the PVAC implementation in [webcli](https://github.com/octra-labs/webcli).

## wasm-bindgen-rayon worker helper

`public/snippets/wasm-bindgen-rayon-*/src/workerHelpers.no-bundler.js` - Copyright 2022 Google Inc., **Apache License, Version 2.0** (header preserved in-file). Apache-2.0 is compatible for inclusion within a GPL-3.0 work.

## npm dependencies

Runtime dependencies and their licenses (all permissive or weak-copyleft, GPL-3.0-compatible):

| License | Packages |
| --- | --- |
| MIT | @noble/curves, @noble/hashes, @scure/bip32, @scure/base, react, react-dom, scheduler, loose-envify, js-tokens |
| Unlicense | tweetnacl |

These ten packages are the whole runtime dependency tree. Everything else in the build is written in this repository.

Rust crate dependencies of the privacy engine are MIT / Apache-2.0 / BSD-3-Clause.

Full license texts for npm dependencies are available in each package's directory under `node_modules/`.
