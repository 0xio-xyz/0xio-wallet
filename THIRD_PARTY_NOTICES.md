# Third-Party Notices

0xio Wallet is licensed under the MIT License (see [LICENSE](LICENSE)). It includes the following third-party components, whose licenses and attributions are reproduced here.

## PVAC-HFHE privacy engine

The bundled `public/pvac_rs_bg.wasm`, `src/wasm/pvac_rs_bg.wasm` and the Firefox variants are built from pvac-rs by 0xio Labs, a Rust port of the PVAC-HFHE engine in Octra Labs' reference client [webcli](https://github.com/octra-labs/webcli). webcli and its PVAC code are released by Octra Labs under the BSD 3-Clause License:

```
BSD 3-Clause License

Copyright (c) 2023-2026, Octra Labs <dev@octra.org>
All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:

1. Redistributions of source code must retain the above copyright notice, this
   list of conditions and the following disclaimer.

2. Redistributions in binary form must reproduce the above copyright notice,
   this list of conditions and the following disclaimer in the documentation
   and/or other materials provided with the distribution.

3. Neither the name of the copyright holder nor the names of its contributors
   may be used to endorse or promote products derived from this software
   without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS"
AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE
IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## wasm-bindgen-rayon worker helper

`public/snippets/wasm-bindgen-rayon-*/src/workerHelpers.no-bundler.js`: Copyright 2022 Google Inc., Apache License, Version 2.0 (header preserved in the file).

## npm dependencies

| License | Packages |
| --- | --- |
| MIT | @noble/curves, @noble/hashes, @scure/bip32, @scure/base, react, react-dom, scheduler, loose-envify, js-tokens |
| Unlicense | tweetnacl |

These ten packages are the whole runtime dependency tree. Everything else in the build is written in this repository. Full license texts are in each package directory under `node_modules/`.

The Rust crates the privacy engine depends on are under the MIT, Apache-2.0 or BSD-3-Clause licenses.
