import { beforeEach, describe, expect, it } from 'vitest';
import { activeNetworkHasPrivacy } from '../background/services/networkPrivacy';

const local = new Map<string, unknown>();

beforeEach(() => {
  local.clear();
  (chrome.storage as any).local = {
    get: async (keys: string | string[]) => {
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async () => {},
  };
});

const node = (id: string, supports_privacy: boolean) => ({
  id,
  name: id,
  rpc_url: 'http://127.0.0.1:8080',
  explorer_url: '',
  explorer_address_url: '',
  indexer_url: '',
  supports_privacy,
});

describe('private operations follow the active network', () => {
  it('uses the answer the user gave for their own node, read from storage', async () => {
    local.set('0xio_custom_networks', [node('custom_home', false), node('custom_lab', true)]);
    local.set('0xio_current_network', 'custom_home');
    expect(await activeNetworkHasPrivacy()).toBe(false);
    local.set('0xio_current_network', 'custom_lab');
    expect(await activeNetworkHasPrivacy()).toBe(true);
  });

  it('refuses for a custom id that is no longer configured', async () => {
    local.set('0xio_custom_networks', []);
    local.set('0xio_current_network', 'custom_gone');
    expect(await activeNetworkHasPrivacy()).toBe(false);
  });

  it('keeps privacy on the built-in networks', async () => {
    expect(await activeNetworkHasPrivacy()).toBe(true);
    local.set('0xio_current_network', 'devnet');
    expect(await activeNetworkHasPrivacy()).toBe(true);
  });
});
