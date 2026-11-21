# Contributing

## License and sign-off

0xio Wallet is GPL-3.0-only. By submitting a contribution you agree it is licensed under GPL-3.0-only and that you have the right to submit it. Sign off every commit with `git commit -s` to certify the [Developer Certificate of Origin](https://developercertificate.org).

## Building

Prerequisites: Node 22 and npm 11 (`npm i -g npm@11` - the lockfile is npm 11; Node 22 ships npm 10 and will reject it).

```
npm ci
npm run build          # Chrome  -> dist/
npm run build:firefox  # Firefox -> dist-firefox/
```

The privacy engine (PVAC WASM) is prebuilt into `public/` and `src/wasm/` from the [pvac-rs](https://github.com/0xio-xyz/pvac-rs) repo. To rebuild it, follow pvac-rs - the threaded (Chrome) build needs a nightly Rust toolchain; the non-threaded (Firefox) build does not.

## Before opening a PR

```
npm run lint
npm run typecheck
npm run format:check
npm test
```

Match the surrounding code. A few house rules that aren't obvious:

- Direct `useEffect` in components is avoided - use `useMountEffect`, or tag a genuinely unavoidable effect with `// effect:audited - <reason>`.
- Server state goes through React Query, not hand-rolled fetch-in-effect.
- Comments explain *why*, not *what*.
