import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import manifest from './manifest.json';
import { resolve } from 'path';
import { readFileSync, writeFileSync, readdirSync } from 'fs';
import { transform } from 'esbuild';

/**
 * Custom plugin: crxjs copies web_accessible_resources .ts files as-is
 * without transpiling. This plugin post-processes them via esbuild to
 * strip TypeScript syntax so the browser can execute them.
 */
function transpileWebAccessibleTS() {
  return {
    name: 'transpile-web-accessible-ts',
    apply: 'build',
    async writeBundle(options) {
      const outDir = options.dir || 'dist';
      const contentDir = resolve(outDir, 'src/content');
      let files;
      try {
        files = readdirSync(contentDir).filter((f) => f.endsWith('.ts'));
      } catch {
        return;
      }
      for (const file of files) {
        const filePath = resolve(contentDir, file);
        const code = readFileSync(filePath, 'utf-8');
        const result = await transform(code, {
          loader: 'ts',
          target: 'es2020',
        });
        // Remove `export {}` which is only needed for TS module resolution
        const cleaned = result.code.replace(/^export\s*\{\s*\}\s*;?\s*$/m, '');
        writeFileSync(filePath, cleaned);
      }
    },
  };
}

/**
 * Vite copies public/ verbatim, so its .js (pvac-offscreen.js, the pvac_rs.js WASM glue, the rayon
 * snippets) bypass esbuild's `drop: ['console']` and would still log in a production build. Strip
 * console from those dist copies too, so `npm run build` is silent in every inspect view. DEBUG=1
 * keeps them, same escape hatch as the esbuild drop.
 */
function stripConsoleFromPublicJs() {
  const keepConsole = process.env.DEBUG === '1' || process.env.DEBUG === 'true';
  return {
    name: 'strip-console-public-js',
    apply: 'build',
    async writeBundle(options) {
      if (keepConsole) return;
      const outDir = options.dir || 'dist';
      const publicDir = resolve(__dirname, 'public');
      const jsFiles = [];
      const walk = (dir, rel) => {
        let entries;
        try {
          entries = readdirSync(dir, { withFileTypes: true });
        } catch {
          return;
        }
        for (const e of entries) {
          const childRel = rel ? `${rel}/${e.name}` : e.name;
          if (e.isDirectory()) walk(resolve(dir, e.name), childRel);
          else if (e.name.endsWith('.js')) jsFiles.push(childRel);
        }
      };
      walk(publicDir, '');
      for (const rel of jsFiles) {
        const filePath = resolve(outDir, rel);
        let code;
        try {
          code = readFileSync(filePath, 'utf-8');
        } catch {
          continue;
        }
        try {
          const result = await transform(code, {
            loader: 'js',
            target: 'es2020',
            drop: ['console', 'debugger'],
          });
          writeFileSync(filePath, result.code);
        } catch {}
      }
    },
  };
}

/**
 * Dev-serve only: crxjs replaces every HTML input in dist with its loading stub, but the
 * sandboxed renderer.html runs at a null origin where the stub's reload dance never
 * completes - it reloads itself forever and living NFTs fall back to the static image.
 * Overwrite the stub with a page that loads the renderer module straight from the dev
 * server (the dev sandbox CSP explicitly allows localhost:5173 scripts).
 */
function devSandboxRenderer() {
  return {
    name: 'dev-sandbox-renderer',
    apply: 'serve',
    configureServer(server) {
      server.httpServer?.once('listening', () => {
        const html = readFileSync(resolve(__dirname, 'renderer.html'), 'utf-8')
          .replace(
            'src="/src/renderer/index.ts"',
            'src="http://localhost:5173/src/renderer/index.ts"'
          )
          .replace("script-src 'self'", "script-src 'self' http://localhost:5173")
          .replace('connect-src ', 'connect-src http://localhost:5173 ws://localhost:5173 ');
        // crxjs writes its dist stubs on serve start; replace ours shortly after (and again
        // a bit later in case crxjs re-emits).
        const write = () => {
          try {
            writeFileSync(resolve(__dirname, 'dist', 'renderer.html'), html);
          } catch {}
        };
        setTimeout(write, 1500);
        setTimeout(write, 6000);
      });
    },
  };
}

export default defineConfig(({ command }) => {
  // DEV ONLY: crxjs serves sandbox pages from the Vite dev server, so the sandbox CSP must allow
  // localhost:5173 (connect for @crx/dev-ready + HMR, script for the served module). We inject it
  // only for `serve` so the committed manifest and production build stay clean (no localhost).
  if (
    command === 'serve' &&
    manifest.content_security_policy?.sandbox &&
    !manifest.content_security_policy.sandbox.includes('localhost:5173')
  ) {
    manifest.content_security_policy.sandbox = manifest.content_security_policy.sandbox
      .replace("script-src 'self'", "script-src 'self' http://localhost:5173")
      .replace('connect-src ', 'connect-src http://localhost:5173 ws://localhost:5173 ');
  }

  return {
    define: {
      __EXT_VERSION__: JSON.stringify(manifest.version),
    },
    plugins: [
      react(),
      crx({ manifest }),
      transpileWebAccessibleTS(),
      stripConsoleFromPublicJs(),
      devSandboxRenderer(),
    ],
    resolve: {
      alias: {
        src: resolve(__dirname, 'src'),
      },
    },
    esbuild: {
      drop:
        command === 'serve' || process.env.DEBUG === '1' || process.env.DEBUG === 'true'
          ? ['debugger']
          : ['console', 'debugger'],
    },
    server: {
      port: 5173,
      strictPort: true,
      hmr: {
        port: 5173,
      },
      // Vite 6's default CORS only trusts localhost-ish origins. The sandboxed renderer.html
      // (null origin) and extension pages need module access too; keep the list scoped -
      // wide-open cors would serve source (incl. injected env keys) to any website.
      cors: {
        origin: ['null', /^chrome-extension:\/\//, /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/],
      },
    },
    build: {
      sourcemap: false,
      // Chrome MV3 rejects the crx-injected <link rel="modulepreload"> tags as a "cross-world
      // extension resource mismatch" (they're for lazy chunks loaded via dynamic import, so they
      // also warn "preloaded but not used"). Disabling the tags removes the console spam; the
      // chunks still load on demand.
      modulePreload: false,
      rollupOptions: {
        input: {
          popup: 'index.html',
          // Sandboxed living-NFT renderer (declared in manifest.sandbox.pages). Listed here so
          // the build always emits it even if the crx plugin doesn't auto-detect sandbox pages.
          renderer: 'renderer.html',
        },
      },
      assetsInlineLimit: 0,
    },
    optimizeDeps: {
      exclude: ['pvac-rs'],
    },
  };
});
