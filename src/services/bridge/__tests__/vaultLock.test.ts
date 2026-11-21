import { describe, expect, it, vi } from 'vitest';

vi.mock('src/services/network/NetworkService', () => ({
  networkService: { jsonRpcCall: vi.fn() },
}));

import { isVaultLock } from '../bridge';
import { BRIDGE } from '../constants';

const listEntry = (over: Record<string, unknown> = {}) => ({
  hash: 'f93b96eca55215f8313b93dc73783d1f795f60a36e13b1b8c6dc6c641fe69f2c',
  epoch: 2161194,
  from: 'oct3yo8i1H1f5rQMcmXdKwLemCW1WpbhzPNgbYrqSiW2fSo',
  to: BRIDGE.octraVault,
  amount: '1499999000',
  ou: '1000',
  timestamp: 1792276160.73,
  op_type: 'call',
  message: '["0x473ed3dcfbc71a63fb50e0ba5a9553b252ff3c8d"]',
  ...over,
});

describe('isVaultLock', () => {
  it('reads a lock from the address list with no method name or status', () => {
    expect(isVaultLock(listEntry())).toBe(true);
  });

  it('still reads the older shape with the method name', () => {
    expect(
      isVaultLock(
        listEntry({ op_type: undefined, message: undefined, encrypted_data: 'lock_to_eth' })
      )
    ).toBe(true);
    expect(isVaultLock(listEntry({ encrypted_data: 'unlock_trusted' }))).toBe(false);
  });

  it('ignores other vault calls, other contracts and plain sends', () => {
    expect(isVaultLock(listEntry({ message: '["oct1", "5", "abc"]' }))).toBe(false);
    expect(isVaultLock(listEntry({ message: 'not json' }))).toBe(false);
    expect(isVaultLock(listEntry({ to: 'oct3yo8i1H1f5rQMcmXdKwLemCW1WpbhzPNgbYrqSiW2fSo' }))).toBe(
      false
    );
    expect(isVaultLock(listEntry({ op_type: 'standard', message: undefined }))).toBe(false);
  });
});
