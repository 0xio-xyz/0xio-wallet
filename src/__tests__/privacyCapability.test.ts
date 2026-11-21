import { describe, it, expect, afterEach } from 'vitest';
import { syncCustomNetworks, type CustomNetwork } from 'src/utils/config';
import { networkCapabilities, getNetworkConfig } from 'src/utils/network';

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

describe('private operations follow the network', () => {
  afterEach(() => syncCustomNetworks([]));

  it('blocks every private operation on a node the user said has no privacy', () => {
    syncCustomNetworks([node({ supports_privacy: false })]);
    expect(networkCapabilities(ID).privacy).toBe(false);
  });

  it('allows them on a node the user said does have it', () => {
    syncCustomNetworks([node({ supports_privacy: true })]);
    expect(networkCapabilities(ID).privacy).toBe(true);
  });

  it('keeps both built-ins private-capable, so nothing regresses off a custom node', () => {
    expect(networkCapabilities('mainnet').privacy).toBe(true);
    expect(networkCapabilities('devnet').privacy).toBe(true);
  });

  it('names the network, so the screen can say which one cannot do this', () => {
    syncCustomNetworks([node()]);
    expect(getNetworkConfig(ID).name).toBe('My Node');
  });
});
