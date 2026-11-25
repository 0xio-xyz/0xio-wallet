# Contributing

Everyone taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License and sign-off

0xio Wallet is MIT licensed. By submitting a contribution you agree it is licensed under MIT and that you have the right to submit it. Sign off every commit with `git commit -s` to certify the [Developer Certificate of Origin](https://developercertificate.org).

## Building

Prerequisites: Node 22 and npm 11 (`npm i -g npm@11` - the lockfile is npm 11; Node 22 ships npm 10 and will reject it).

```
npm ci
npm run build          # Chrome  -> dist/
npm run build:firefox  # Firefox -> dist-firefox/
```

The privacy engine (PVAC WASM) ships prebuilt in `public/` and `src/wasm/`. It is a Rust port of the PVAC engine in Octra Labs' [webcli](https://github.com/octra-labs/webcli).

## Before opening a PR

```
npm run lint
npm run typecheck
npm run format:check
npm test
```

Match the surrounding code. A few 0xio rules that aren't obvious:

- Direct `useEffect` in components is avoided - use `useMountEffect`, or tag a genuinely unavoidable effect with `// effect:audited - <reason>`.
