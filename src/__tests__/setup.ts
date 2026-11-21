import { vi } from 'vitest';

const chromeMock = {
  runtime: {
    sendMessage: vi.fn(),
    onMessage: { addListener: vi.fn(), removeListener: vi.fn() },
    getURL: vi.fn((path: string) => `chrome-extension://mock-id/${path}`),
    reload: vi.fn(),
    id: 'mock-extension-id',
  },
  storage: {
    local: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
    session: {
      get: vi.fn().mockResolvedValue({}),
      set: vi.fn().mockResolvedValue(undefined),
      remove: vi.fn().mockResolvedValue(undefined),
    },
  },
  tabs: {
    create: vi.fn(),
    query: vi.fn().mockResolvedValue([]),
  },
};

vi.stubGlobal('chrome', chromeMock);

let rpcClock = 0;
const { setRpcTimingForTests } = await import('src/services/network/rpcExchange');
setRpcTimingForTests({
  now: () => Date.now() + rpcClock,
  sleep: async (ms) => {
    rpcClock += ms;
  },
});
