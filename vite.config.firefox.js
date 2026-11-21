// Firefox build (dist-firefox/) - separate from vite.config.js so the Chrome pipeline stays
// untouched. Prereq: non-threaded PVAC WASM staged in wasm-firefox/ (the threaded build needs
// SharedArrayBuffer, which Firefox extensions don't have).
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { crx } from '@crxjs/vite-plugin';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, readdirSync, copyFileSync, existsSync, rmSync } from 'fs';
import { transform, build as esbuildBuild } from 'esbuild';
import { toFirefoxManifest, loadBaseManifest } from './build/firefox-manifest.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = 'dist-firefox';
const WASM_STAGE = resolve(__dirname, 'wasm-firefox');

const KEEP_CONSOLE = process.env.DEBUG === '1' || process.env.DEBUG === 'true';

// crxjs copies web_accessible .ts files verbatim - strip TS syntax post-bundle.
function transpileWebAccessibleTS() {
  return {
    name: 'transpile-web-accessible-ts',
    apply: 'build',
    async writeBundle(options) {
      const outDir = options.dir || OUT_DIR;
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
        const result = await transform(code, { loader: 'ts', target: 'es2020' });
        const cleaned = result.code.replace(/^export\s*\{\s*\}\s*;?\s*$/m, '');
        writeFileSync(filePath, cleaned);
      }
    },
  };
}

// Overwrite the threaded PVAC artifacts from public/ with the non-threaded build (both load
// paths fetch them by URL from the extension root, so replacing the dist copies is enough),
// then strip files that must not ship on Firefox (dev benchmark, Chrome-only offscreen host).
function swapNonThreadedWasm() {
  return {
    name: 'firefox-nonthreaded-wasm',
    apply: 'build',
    closeBundle() {
      const targets = ['pvac_rs.js', 'pvac_rs_bg.wasm'];
      let missing = false;
      for (const f of targets) {
        const src = resolve(WASM_STAGE, f);
        const dst = resolve(__dirname, OUT_DIR, f);
        if (existsSync(src)) {
          copyFileSync(src, dst);
        } else {
          missing = true;
          // eslint-disable-next-line no-console
          console.warn(
            `\n[firefox build] MISSING non-threaded ${f} in wasm-firefox/ - the bundled THREADED ` +
              `one cannot instantiate on Firefox. Stage it: cd ../pvac-rs && ./build-wasm.sh --no-copy, ` +
              `then node build/sync-firefox-wasm.mjs\n`
          );
        }
      }
      if (!missing) {
        // eslint-disable-next-line no-console
        console.log('[firefox build] swapped in non-threaded PVAC WASM from wasm-firefox/');
      }
      // snippets/ = wasm-bindgen-rayon worker helpers from the THREADED build in public/:
      // the non-threaded pvac_rs.js never references them.
      for (const dead of [
        'benchmark',
        'pvac-offscreen.js',
        'pvac-offscreen-guard.js',
        'pvac-offscreen.html',
        'snippets',
      ]) {
        const p = resolve(__dirname, OUT_DIR, dead);
        if (existsSync(p)) {
          rmSync(p, { recursive: true, force: true });
          // eslint-disable-next-line no-console
          console.log(`[firefox build] removed ${dead} (not shipped on Firefox)`);
        }
      }
    },
  };
}

// public/ .js copied verbatim (the swapped-in non-threaded pvac_rs.js, pvac-worker.js) bypass
// esbuild's drop:['console'], so strip them in dist-firefox too - runs on closeBundle AFTER
// swapNonThreadedWasm so it catches the swapped glue. DEBUG=1 keeps them.
function stripConsoleFromPublicJs() {
  return {
    name: 'strip-console-public-js',
    apply: 'build',
    async closeBundle() {
      if (KEEP_CONSOLE) return;
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
        const filePath = resolve(__dirname, OUT_DIR, rel);
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
        } catch {
        }
      }
    },
  };
}

// The renderer shell runs in a sandboxed iframe (null principal); Firefox forbids a null
// principal from loading external moz-extension:// modules but allows inline scripts, so
// bundle the shell into one IIFE and inline it into renderer.html. Chrome keeps its module.
function inlineRendererShell() {
  return {
    name: 'firefox-inline-renderer-shell',
    apply: 'build',
    async closeBundle() {
      const htmlPath = resolve(__dirname, OUT_DIR, 'renderer.html');
      if (!existsSync(htmlPath)) return;
      const out = await esbuildBuild({
        entryPoints: [resolve(__dirname, 'src/renderer/index.ts')],
        bundle: true,
        format: 'iife',
        minify: true,
        write: false,
        target: 'es2020',
        define: { __FIREFOX__: 'true', __CHROME__: 'false' },
        alias: { src: resolve(__dirname, 'src') },
        logLevel: 'silent',
      });
      // "</script" inside the bundle would close the inline tag early - escape it.
      const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
      let html = readFileSync(htmlPath, 'utf-8');
      html = html
        .replace(
          /<script\b[^>]*\bsrc="[^"]*\/assets\/renderer-[^"]*\.js"[^>]*><\/script>/,
          `<script>${js}</script>`
        )
        .replace(
          /\s*<link\b[^>]*\bhref="[^"]*\/assets\/(renderer|protocol|logger)-[^"]*\.js"[^>]*>/g,
          ''
        );
      writeFileSync(htmlPath, html);
      // eslint-disable-next-line no-console
      console.log(
        '[firefox build] inlined renderer shell into renderer.html (sandbox null-principal safe)'
      );
    },
  };
}

export default defineConfig(() => {
  const manifest = toFirefoxManifest(loadBaseManifest());
  return {
    define: {
      __FIREFOX__: JSON.stringify(true),
      __CHROME__: JSON.stringify(false),
      __EXT_VERSION__: JSON.stringify(manifest.version),
    },
    plugins: [
      react(),
      crx({ manifest, browser: 'firefox' }),
      transpileWebAccessibleTS(),
      swapNonThreadedWasm(),
      stripConsoleFromPublicJs(),
      inlineRendererShell(),
    ],
    resolve: {
      alias: { src: resolve(__dirname, 'src') },
    },
    esbuild: {
      drop: KEEP_CONSOLE ? ['debugger'] : ['console', 'debugger'],
    },
    build: {
      outDir: OUT_DIR,
      sourcemap: false,
      modulePreload: false,
      rollupOptions: {
        input: {
          popup: 'index.html',
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
