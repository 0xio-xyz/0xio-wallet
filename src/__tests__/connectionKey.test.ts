import { describe, expect, it } from 'vitest';
import { connectionKey } from '../background/services/dappConnections';

describe('connectionKey', () => {
  it('keeps the stored key format', () => {
    const origins = [
      'https://dex.0xio.xyz',
      'https://例え.jp:8443',
      'http://localhost:3000',
      'https://a.b/?q=~~>>',
    ];
    for (const origin of origins) {
      const want = Buffer.from(origin)
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(connectionKey(origin)).toBe(`dapp_connection_${want}`);
    }
  });
});
