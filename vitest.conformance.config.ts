import { defineConfig } from 'vitest/config';
import { resolve } from 'path';

const sdk = resolve(__dirname, '../0xio-sdk');

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/__tests__/setup.ts'],
    include: ['src/__tests__/protocol2.conformance.test.ts'],
  },
  resolve: {
    alias: {
      src: resolve(__dirname, 'src'),
      '@0xio/conformance': resolve(sdk, 'conformance'),
    },
  },
  server: { fs: { allow: [__dirname, sdk] } },
});
