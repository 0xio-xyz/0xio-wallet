import { beforeAll, describe, expect, it, vi } from 'vitest';

type Sent = { requestId: string; method: string; params: unknown };

const sent: Sent[] = [];
const answers = new Map<string, unknown>();
const port = {
  onmessage: null as null | ((e: { data: unknown }) => void),
  start() {},
  postMessage(msg: Sent) {
    sent.push(msg);
    const answer = answers.get(msg.method) ?? { success: true, data: null };
    queueMicrotask(() =>
      port.onmessage?.({ data: { requestId: msg.requestId, response: answer } })
    );
  },
};

const announced: any[] = [];
const eth = () => (window as any).ethereum;

beforeAll(async () => {
  window.addEventListener('eip6963:announceProvider', (e) =>
    announced.push((e as CustomEvent).detail)
  );
  await import('../content/injected');
  window.dispatchEvent(
    new MessageEvent('message', {
      data: { source: '0xio-port-init', nonce: 'n' },
      ports: [port as any],
    })
  );
});

describe('window.ethereum', () => {
  it('is defined as 0xio, not MetaMask', () => {
    expect(eth().isOxio).toBe(true);
    expect(eth().isMetaMask).toBe(false);
  });

  it('announces itself through EIP-6963 on load and on request', () => {
    expect(announced).toHaveLength(1);
    const { info, provider } = announced[0];
    expect(info).toMatchObject({ name: '0xio Wallet', rdns: 'xyz.0xio.wallet' });
    expect(info.uuid).toMatch(/^[0-9a-f-]{36}$/);
    expect(info.icon).toMatch(/^data:image\/png;base64,/);
    expect(provider).toBe(eth());
    window.dispatchEvent(new Event('eip6963:requestProvider'));
    expect(announced).toHaveLength(2);
    expect(announced[1].info.uuid).toBe(info.uuid);
  });

  it('sends requests through the private port and returns the result', async () => {
    answers.set('wallet_getProviderState', {
      success: true,
      data: { chainId: '0x1', accounts: [] },
    });
    answers.set('eth_blockNumber', { success: true, data: '0x2a' });
    expect(await eth().request({ method: 'eth_blockNumber', params: [] })).toBe('0x2a');
    expect(sent.find((s) => s.method === 'eth_blockNumber')?.params).toEqual([]);
    expect(eth().chainId).toBe('0x1');
  });

  it('rejects with EIP-1193 codes and keeps error data', async () => {
    answers.set('personal_sign', {
      success: false,
      error: { code: 4001, message: 'User rejected the request.' },
    });
    await expect(eth().request({ method: 'personal_sign', params: ['hi'] })).rejects.toMatchObject({
      code: 4001,
    });
    answers.set('eth_call', {
      success: false,
      error: { code: 3, message: 'execution reverted', data: '0xa2ad39b9' },
    });
    await expect(eth().request({ method: 'eth_call', params: [{}] })).rejects.toMatchObject({
      code: 3,
      data: '0xa2ad39b9',
    });
    await expect(eth().request('eth_chainId')).rejects.toMatchObject({ code: -32602 });
    await expect(eth().request({ method: 'eth_call', params: [1n] })).rejects.toMatchObject({
      code: -32602,
    });
  });

  it('emits accountsChanged and chainChanged from wallet pushes, once per change', async () => {
    const accounts = vi.fn();
    const chains = vi.fn();
    eth().on('accountsChanged', accounts);
    eth().on('chainChanged', chains);
    const push = (evmData: unknown) => port.onmessage?.({ data: { type: 'evm_event', evmData } });
    push({ accounts: ['0xabc'], chainId: '0x1' });
    push({ accounts: ['0xabc'], chainId: '0x1' });
    push({ accounts: ['0xabc'], chainId: '0x1237' });
    push({ accounts: [], chainId: '0x1237' });
    expect(accounts.mock.calls).toEqual([[['0xabc']], [[]]]);
    expect(chains.mock.calls).toEqual([['0x1237']]);
    eth().removeListener('accountsChanged', accounts);
    push({ accounts: ['0xdef'], chainId: '0x1237' });
    expect(accounts).toHaveBeenCalledTimes(2);
    expect(eth().selectedAddress).toBe('0xdef');
  });

  it('serves legacy send and sendAsync', async () => {
    answers.set('eth_chainId', { success: true, data: '0x1237' });
    expect(eth().send({ id: 1, jsonrpc: '2.0', method: 'eth_accounts' })).toEqual({
      id: 1,
      jsonrpc: '2.0',
      result: ['0xdef'],
    });
    const res = await new Promise((resolve) =>
      eth().sendAsync({ id: 2, jsonrpc: '2.0', method: 'eth_chainId' }, (_e: unknown, r: unknown) =>
        resolve(r)
      )
    );
    expect(res).toEqual({ id: 2, jsonrpc: '2.0', result: '0x1237' });
  });
});

describe('the wagmi connect sequence', () => {
  it('resolves permissions, accounts, chain and capabilities in order', async () => {
    const acct = '0x9858effd232b4033e47d90003d41ec34ecaeda94';
    answers.set('wallet_requestPermissions', {
      success: true,
      data: [
        {
          parentCapability: 'eth_accounts',
          caveats: [{ type: 'restrictReturnedAccounts', value: [acct] }],
        },
      ],
    });
    answers.set('eth_accounts', { success: true, data: [acct] });
    answers.set('eth_chainId', { success: true, data: '0x1' });
    answers.set('wallet_getCapabilities', { success: true, data: {} });
    const accountsChanged = vi.fn();
    eth().on('accountsChanged', accountsChanged);
    const perms = await eth().request({
      method: 'wallet_requestPermissions',
      params: [{ eth_accounts: {} }],
    });
    expect(perms[0].caveats[0].value).toEqual([acct]);
    expect(await eth().request({ method: 'eth_accounts' })).toEqual([acct]);
    expect(await eth().request({ method: 'eth_chainId' })).toBe('0x1');
    expect(await eth().request({ method: 'wallet_getCapabilities', params: [acct] })).toEqual({});
    expect(accountsChanged).toHaveBeenLastCalledWith([acct]);
    expect(eth().selectedAddress).toBe(acct);
    eth().removeListener('accountsChanged', accountsChanged);
  });
});

describe('the extension going away', () => {
  it('rejects with 4900, emits disconnect once and reports not connected', async () => {
    const gone = { success: false, error: { code: 'EXTENSION_NOT_FOUND', message: 'reloaded' } };
    answers.set('eth_blockNumber', gone);
    const disconnect = vi.fn();
    eth().on('disconnect', disconnect);
    expect(eth().isConnected()).toBe(true);
    await expect(eth().request({ method: 'eth_blockNumber' })).rejects.toMatchObject({
      code: 4900,
    });
    await expect(eth().request({ method: 'eth_blockNumber' })).rejects.toMatchObject({
      code: 4900,
    });
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(disconnect.mock.calls[0][0]).toMatchObject({ code: 4900 });
    expect(eth().isConnected()).toBe(false);
  });
});

describe('another wallet already on the page', () => {
  it('keeps its window.ethereum and still announces 0xio', async () => {
    const theirs = { isMetaMask: true };
    for (const k of ['wallet0xio', 'ZeroXIOWallet', 'wallet', 'octra', 'ethereum']) {
      delete (window as any)[k];
    }
    (window as any).ethereum = theirs;
    const before = announced.length;
    vi.resetModules();
    await import('../content/injected');
    expect((window as any).ethereum).toBe(theirs);
    expect(announced.length).toBeGreaterThan(before);
    expect(announced[announced.length - 1].info.rdns).toBe('xyz.0xio.wallet');
  });
});
