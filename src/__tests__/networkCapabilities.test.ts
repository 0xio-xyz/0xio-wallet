import { describe, it, expect, afterEach } from 'vitest';
import { syncCustomNetworks, type CustomNetwork } from 'src/utils/config';
import {
  getNetworkConfig,
  getExplorerTxUrl,
  supportsPrivacy,
  networkCapabilities,
  historyNetworks,
} from 'src/utils/network';

const ID = 'custom_1700000000000';
const node = (over: Partial<CustomNetwork> = {}): CustomNetwork => ({
  id: ID,
  name: 'My Node',
  rpc_url: 'http://10.0.0.5:8080',
  explorer_url: '',
  explorer_address_url: '',
  indexer_url: '',
  supports_privacy: false,
  color: '#9b8cff',
  ...over,
});

describe('custom network resolution', () => {
  afterEach(() => syncCustomNetworks([]));

  it('resolves a custom id to its own config, not mainnet', () => {
    syncCustomNetworks([node()]);
    expect(getNetworkConfig(ID).name).toBe('My Node');
    expect(getNetworkConfig(ID).rpc_url).toBe('http://10.0.0.5:8080');
  });

  it('still falls back to mainnet for an id it has never seen', () => {
    expect(getNetworkConfig('custom_gone').name).toBe(getNetworkConfig('mainnet').name);
  });

  it("takes privacy from the user's config instead of mainnet's", () => {
    syncCustomNetworks([node({ supports_privacy: false })]);
    expect(supportsPrivacy(ID)).toBe(false);
    syncCustomNetworks([node({ supports_privacy: true })]);
    expect(supportsPrivacy(ID)).toBe(true);
  });

  it('gives no explorer link when the node has none, rather than octrascan', () => {
    syncCustomNetworks([node()]);
    expect(getExplorerTxUrl(ID, 'abc')).toBe('');
    syncCustomNetworks([node({ explorer_url: 'https://scan.example.com/tx.html?hash=' })]);
    expect(getExplorerTxUrl(ID, 'abc')).toBe('https://scan.example.com/tx.html?hash=abc');
  });

  it('offers no 0xio-hosted feature and no proxy on a custom node', () => {
    syncCustomNetworks([node()]);
    const caps = networkCapabilities(ID);
    expect([caps.proxy, caps.market, caps.swap, caps.bridge]).toEqual([false, false, false, false]);
    expect(caps.tokenListTag).toBeUndefined();
    expect(networkCapabilities('mainnet').proxy).toBe(true);
    expect(networkCapabilities('devnet').swap).toBe(true);
  });

  it('reads history from the custom node alone, never the built-ins', () => {
    expect(historyNetworks(ID)).toEqual([ID]);
    expect(historyNetworks('mainnet')).toEqual(['mainnet', 'devnet']);
  });
});
