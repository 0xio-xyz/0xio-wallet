// Copies pvac-rs/pkg/{pvac_rs.js,pvac_rs_bg.wasm} into wasm-firefox/, where vite.config.firefox.js
// picks them up and swaps them into dist-firefox/. We keep them in a separate staging dir (not
// public/) so the Chrome build keeps shipping the THREADED artifacts unchanged.
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { copyFileSync, existsSync, mkdirSync, statSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const PKG = resolve(ROOT, '..', 'pvac-rs', 'pkg');
const STAGE = resolve(ROOT, 'wasm-firefox');

const FILES = ['pvac_rs.js', 'pvac_rs_bg.wasm'];

if (!existsSync(PKG)) {
  console.error(`ERROR: ${PKG} not found. Build the non-threaded WASM first:`);
  console.error('  cd ../pvac-rs && ./build-wasm.sh --no-copy');
  process.exit(1);
}

mkdirSync(STAGE, { recursive: true });

for (const f of FILES) {
  const src = resolve(PKG, f);
  if (!existsSync(src)) {
    console.error(`ERROR: ${src} missing - did build-wasm.sh (non-threaded) succeed?`);
    process.exit(1);
  }
  const dst = resolve(STAGE, f);
  copyFileSync(src, dst);
  console.log(`  ${f}  (${(statSync(dst).size / 1024).toFixed(0)} KB)  -> wasm-firefox/`);
}

// Sanity: a non-threaded build must NOT declare shared memory. Warn if it looks threaded.
import { readFileSync } from 'fs';
const glue = readFileSync(resolve(STAGE, 'pvac_rs.js'), 'utf-8');
if (glue.includes('shared:true') || glue.includes('initThreadPool')) {
  console.warn(
    '\nWARNING: staged pvac_rs.js looks THREADED (shared memory / initThreadPool present).\n' +
      '  This will FAIL to instantiate on Firefox. Rebuild with ./build-wasm.sh (NOT -threaded).\n'
  );
} else {
  console.log('\nOK: staged glue is non-threaded (no shared memory). Ready for build:firefox.');
}
