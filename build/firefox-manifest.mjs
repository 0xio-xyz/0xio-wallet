import { readFileSync, writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');

// Floors: data_collection_permissions is honoured from Firefox 140 desktop and 142 Android.
// The wallet sends addresses, balances and signed transactions to RPC nodes, explorers, the
// bridge and price services, which Mozilla classes as financial and payment information.
const GECKO = {
  id: 'wallet@0xio.xyz',
  strict_min_version: '140.0',
  data_collection_permissions: { required: ['financialAndPaymentInfo'] },
};
const GECKO_ANDROID = { strict_min_version: '142.0' };

export function toFirefoxManifest(base) {
  const m = structuredClone(base);

  // Background: Firefox MV3 uses an event page (scripts), not a service worker.
  const swEntry = m.background?.service_worker;
  m.background = {
    scripts: swEntry ? [swEntry] : [],
    type: m.background?.type ?? 'module',
  };

  // Chrome-only manifest keys: ignored by Firefox (warnings) - strip for a clean build.
  delete m.cross_origin_embedder_policy;
  delete m.cross_origin_opener_policy;
  delete m.sandbox;
  delete m.minimum_chrome_version;

  // `offscreen` permission has no Firefox equivalent.
  if (Array.isArray(m.permissions)) {
    m.permissions = m.permissions.filter((p) => p !== 'offscreen');
  }

  // Drop the sandbox CSP (no sandboxed pages on Firefox); keep extension_pages (incl.
  // 'wasm-unsafe-eval', which Firefox 102+ supports but does not enable by default).
  if (m.content_security_policy && typeof m.content_security_policy === 'object') {
    const { sandbox, ...rest } = m.content_security_policy;
    m.content_security_policy = rest;
  }

  // On Chrome renderer.html is a manifest `sandbox` page; on Firefox (no sandbox key) the living-NFT
  // shell is loaded into an opaque-origin allow-scripts iframe, which requires the page to be
  // web-accessible. crxjs appends its content-script chunks to this entry.
  m.web_accessible_resources = [
    { resources: ['renderer.html'], matches: ['http://*/*', 'https://*/*'] },
  ];

  m.browser_specific_settings = { gecko: GECKO, gecko_android: GECKO_ANDROID };
  return m;
}

export function loadBaseManifest() {
  return JSON.parse(readFileSync(resolve(ROOT, 'manifest.json'), 'utf-8'));
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const out = toFirefoxManifest(loadBaseManifest());
  const dest = resolve(ROOT, 'manifest.firefox.json');
  writeFileSync(dest, JSON.stringify(out, null, 2) + '\n');
  console.log(`Wrote ${dest}`);
  console.log(`  background: ${JSON.stringify(out.background)}`);
  console.log(`  permissions: ${JSON.stringify(out.permissions)}`);
  console.log(`  gecko.id: ${out.browser_specific_settings.gecko.id}`);
}
