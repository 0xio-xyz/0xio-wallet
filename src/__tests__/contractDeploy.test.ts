// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import nacl from 'tweetnacl';
import { ZeroXIOConfig } from 'src/utils/config';
import { networkService, setFeeRetrySleepForTests } from 'src/services/network/NetworkService';
import { captureTxScope } from 'src/services/network/txScope';
import { RpcResponseError } from 'src/services/network/txOutcome';
import { computeTxHash } from 'src/utils/octra/txHash';
import {
  DeployChangedError,
  deployFeeError,
  liveDeployOu,
  previewDeploy,
  submitDeploy,
} from 'src/services/contracts/contractDeploy';
import {
  DEPLOY_MAX_CODE_BYTES,
  base64DecodedLength,
  deployBaseOu,
  deployReviewError,
  parseDeployRequest,
} from 'src/utils/octra/deployTx';

const NET = ZeroXIOConfig.STORAGE.KEYS.CURRENT_NETWORK;
const ACTIVE = ZeroXIOConfig.STORAGE.KEYS.ACTIVE_WALLET;
const A = 'octAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
const C1 = 'octCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
const C2 = 'octDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD';

const SEED = new Uint8Array(32).map((_, i) => i + 1);
const PRIVATE_KEY = btoa(String.fromCharCode(...SEED));
const KEYPAIR = nacl.sign.keyPair.fromSeed(SEED);
const PUBLIC_KEY = btoa(String.fromCharCode(...KEYPAIR.publicKey));
const CODE = btoa('contract code bytes');

const fromB64 = (b64: string) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
const verifies = (payload: string, signature: string) =>
  nacl.sign.detached.verify(
    new TextEncoder().encode(payload),
    fromB64(signature),
    KEYPAIR.publicKey
  );

const local = new Map<string, unknown>();

beforeEach(() => {
  networkService.forgetFeeQuotes();
  setFeeRetrySleepForTests(async () => {});
  local.clear();
  local.set(NET, 'mainnet');
  local.set(ACTIVE, A);
  (chrome.storage as any).local = {
    get: async (keys?: string | string[] | null) => {
      if (keys == null) return Object.fromEntries(local);
      const list = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(list.filter((k) => local.has(k)).map((k) => [k, local.get(k)]));
    },
    set: async (items: Record<string, unknown>) => {
      for (const [k, v] of Object.entries(items)) local.set(k, structuredClone(v));
    },
    remove: async (keys: string | string[]) => {
      for (const k of Array.isArray(keys) ? keys : [keys]) local.delete(k);
    },
  };
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('buildDeployTransaction', () => {
  it('signs the canonical field order with constructor params as the message', async () => {
    const tx = await networkService.buildDeployTransaction({
      from: A,
      bytecodeB64: CODE,
      constructorParams: '["Token",18]',
      nonce: 7,
      ou: '200000',
      toAddress: C1,
      privateKey: PRIVATE_KEY,
    });
    const manual =
      `{"from":"${A}","to_":"${C1}","amount":"0","nonce":7,"ou":"200000",` +
      `"timestamp":${tx.timestamp},"op_type":"deploy","encrypted_data":"${CODE}",` +
      `"message":"[\\"Token\\",18]"}`;
    expect(verifies(manual, tx.signature)).toBe(true);
    expect(tx.public_key).toBe(PUBLIC_KEY);
    expect(Object.keys(tx)).toEqual([
      'from',
      'to_',
      'amount',
      'nonce',
      'ou',
      'timestamp',
      'op_type',
      'encrypted_data',
      'message',
      'signature',
      'public_key',
    ]);
    expect(Number.isInteger(tx.timestamp)).toBe(false);
  });

  it('leaves the message out when there are no constructor params', async () => {
    const tx = await networkService.buildDeployTransaction({
      from: A,
      bytecodeB64: CODE,
      nonce: 3,
      ou: '250000',
      toAddress: C1,
      privateKey: PRIVATE_KEY,
      publicKey: PUBLIC_KEY,
    });
    const manual =
      `{"from":"${A}","to_":"${C1}","amount":"0","nonce":3,"ou":"250000",` +
      `"timestamp":${tx.timestamp},"op_type":"deploy","encrypted_data":"${CODE}"}`;
    expect(verifies(manual, tx.signature)).toBe(true);
    expect('message' in tx).toBe(false);
  });
});

describe('parseDeployRequest', () => {
  it('reads bytecode, params and fee', () => {
    const res = parseDeployRequest({ bytecode: CODE, params: '["a", 1]', ou: '300000' });
    expect(res).toEqual({
      ok: true,
      request: {
        bytecodeB64: CODE,
        codeBytes: 'contract code bytes'.length,
        constructorParams: '["a", 1]',
        ou: 300000n,
      },
    });
  });

  it('serializes array params and leaves the fee to the wallet when none is given', () => {
    const res = parseDeployRequest({ bytecode: CODE, params: ['a', 1] });
    expect(res.ok && res.request.constructorParams).toBe('["a",1]');
    expect(res.ok && res.request.ou).toBeNull();
  });

  it.each([[undefined], [''], ['abc'], ['ab!='], ['AA=A'], ['===='], [' QUJD'], [123]])(
    'rejects bytecode %j',
    (bytecode) => {
      expect(parseDeployRequest({ bytecode }).ok).toBe(false);
    }
  );

  it('caps the decoded code size', () => {
    const atCap = 'AAAA'.repeat(174762) + 'AAA=';
    expect(base64DecodedLength(atCap)).toBe(DEPLOY_MAX_CODE_BYTES);
    expect(parseDeployRequest({ bytecode: atCap }).ok).toBe(true);
    const over = 'AAAA'.repeat(174763);
    expect(base64DecodedLength(over)).toBe(DEPLOY_MAX_CODE_BYTES + 1);
    const res = parseDeployRequest({ bytecode: over });
    expect(res.ok === false && res.error).toMatch(/larger than 512 KB/);
  });

  it.each([['0'], ['-1'], ['1.5'], ['abc'], ['50000001'], [50_000_001], [1.5], [{}]])(
    'rejects fee %j',
    (ou) => {
      const res = parseDeployRequest({ bytecode: CODE, ou });
      expect(res.ok === false && res.error).toBe('Invalid fee');
    }
  );

  it('accepts a fee up to 50,000,000 OU', () => {
    const res = parseDeployRequest({ bytecode: CODE, ou: 50_000_000 });
    expect(res.ok && res.request.ou).toBe(50_000_000n);
  });

  it('rejects params that are not JSON, too long or not signable', () => {
    expect(parseDeployRequest({ bytecode: CODE, params: 'not json' }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: { a: 1 } }).ok).toBe(false);
    expect(
      parseDeployRequest({ bytecode: CODE, params: JSON.stringify(['x'.repeat(70_000)]) }).ok
    ).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: '["\ud800"]' }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: '[1,\u0001 2]' }).ok).toBe(false);
    expect(parseDeployRequest({ bytecode: CODE, params: '[1,\n 2]' }).ok).toBe(true);
    expect(parseDeployRequest({ bytecode: CODE, params: '["😀"]' }).ok).toBe(true);
  });
});

describe('deployReviewError', () => {
  const shown = { codeBytes: 19, contractAddress: C1, constructorParams: '', ou: '200000' };

  it('passes a sound review and blocks a broken one', () => {
    expect(deployReviewError(shown)).toBeNull();
    expect(deployReviewError({ ...shown, contractAddress: 'nope' })).toMatch(/address/);
    expect(deployReviewError({ ...shown, ou: '60000000' })).toBe('Invalid fee');
    expect(deployReviewError({ ...shown, codeBytes: 0 })).toMatch(/code/);
    expect(deployReviewError(undefined)).not.toBeNull();
  });
});

describe('deploy fee', () => {
  it('takes the node recommendation when it is above the size-based base', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({
      minimum: '900000',
      recommended: '900000',
      fast: '900000',
    });
    expect(await liveDeployOu(CODE, scope)).toBe(900000n);
  });

  it('never goes below the size-based base, and prices nothing when the node is silent', async () => {
    const scope = await captureTxScope(A);
    const big = 'AAAA'.repeat(1024);
    expect(deployBaseOu(big.length)).toBe(204000n);
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({
      minimum: '1000',
      recommended: '1000',
      fast: '1000',
    });
    expect(await liveDeployOu(big, scope)).toBe(204000n);
    networkService.forgetFeeQuotes();
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(new Error('down'));
    expect(await liveDeployOu(CODE, scope)).toBeNull();
    expect(await deployFeeError(CODE, 900000n, scope)).toBe('Network fee unavailable. Try again.');
  });

  it('keeps a site fee the node takes and checks the reviewed fee against the live minimum', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({
      minimum: '300000',
      recommended: '900000',
      fast: '900000',
    });
    expect(await liveDeployOu(CODE, scope, 400000n)).toBe(400000n);
    expect(await liveDeployOu(CODE, scope, 250000n)).toBe(900000n);
    expect(await deployFeeError(CODE, 400000n, scope)).toBeNull();
    expect(await deployFeeError(CODE, 250000n, scope)).toBe(
      'The network fee changed. Review again.'
    );
  });
});

describe('submitDeploy', () => {
  const reviewed = { nonce: 5, contractAddress: C1 };

  it('previews without holding the nonce', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(5);
    const release = vi.spyOn(networkService, 'releaseNonce');
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ address: C1 });
    expect(await previewDeploy(CODE, scope)).toEqual(reviewed);
    expect(release).toHaveBeenCalledWith(A, 5, 'mainnet');
    expect(rpc).toHaveBeenCalledWith(
      'octra_computeContractAddress',
      [CODE, A, 5],
      undefined,
      scope
    );
  });

  it('submits the reviewed deploy and records it for History', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(5);
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ tx_hash: 'h1' });
    const res = await submitDeploy({
      scope,
      privateKey: PRIVATE_KEY,
      bytecodeB64: CODE,
      constructorParams: '',
      ou: 200000n,
      reviewed,
    });
    expect(res).toEqual({ txHash: 'h1', contractAddress: C1 });
    const [method, [signed], , pin] = rpc.mock.calls[0];
    expect(method).toBe('octra_submit');
    expect(pin).toBe(scope);
    expect(signed).toMatchObject({ to_: C1, op_type: 'deploy', ou: '200000', nonce: 5 });
    const pending = [...local.entries()].find(([k]) => k.startsWith('pending_tx_'))?.[1] as any;
    expect(pending).toMatchObject({ opType: 'deploy', to: C1, hash: 'h1', network: 'mainnet' });
  });

  it('refuses when the nonce moved the contract address after the review', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(6);
    const release = vi.spyOn(networkService, 'releaseNonce');
    const rpc = vi.spyOn(networkService, 'jsonRpcCall').mockResolvedValue({ address: C2 });
    await expect(
      submitDeploy({
        scope,
        privateKey: PRIVATE_KEY,
        bytecodeB64: CODE,
        constructorParams: '',
        ou: 200000n,
        reviewed,
      })
    ).rejects.toBeInstanceOf(DeployChangedError);
    expect(rpc.mock.calls.map((c) => c[0])).toEqual(['octra_computeContractAddress']);
    expect(release).toHaveBeenCalledWith(A, 6, 'mainnet');
  });

  it('tracks a deploy by its local hash when the node gives no verdict, and keeps it pending', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(5);
    const release = vi.spyOn(networkService, 'releaseNonce');
    const rpc = vi
      .spyOn(networkService, 'jsonRpcCall')
      .mockRejectedValue(new TypeError('Failed to fetch'));
    const res = await submitDeploy({
      scope,
      privateKey: PRIVATE_KEY,
      bytecodeB64: CODE,
      constructorParams: '',
      ou: 200000n,
      reviewed,
    });
    const [, [signed]] = rpc.mock.calls[0];
    expect(res).toEqual({
      txHash: computeTxHash(signed as any),
      contractAddress: C1,
      outcomeUnknown: true,
    });
    expect(release).not.toHaveBeenCalled();
    expect([...local.keys()].some((k) => k.startsWith('pending_tx_'))).toBe(true);
  });

  it('a node verdict is still an error that frees the nonce', async () => {
    const scope = await captureTxScope(A);
    vi.spyOn(networkService, 'getNextNonce').mockResolvedValue(5);
    const release = vi.spyOn(networkService, 'releaseNonce');
    vi.spyOn(networkService, 'jsonRpcCall').mockRejectedValue(
      new RpcResponseError('bad signature', { code: 105 })
    );
    await expect(
      submitDeploy({
        scope,
        privateKey: PRIVATE_KEY,
        bytecodeB64: CODE,
        constructorParams: '',
        ou: 200000n,
        reviewed,
      })
    ).rejects.toThrow(/bad signature/);
    expect(release).toHaveBeenCalledWith(A, 5, 'mainnet');
  });

  it('sends nothing once the wallet moved to another network', async () => {
    const scope = await captureTxScope(A);
    local.set(NET, 'devnet');
    const rpc = vi.spyOn(networkService, 'jsonRpcCall');
    const nonce = vi.spyOn(networkService, 'getNextNonce');
    await expect(
      submitDeploy({
        scope,
        privateKey: PRIVATE_KEY,
        bytecodeB64: CODE,
        constructorParams: '',
        ou: 200000n,
        reviewed,
      })
    ).rejects.toThrow(/network changed/);
    expect(nonce).not.toHaveBeenCalled();
    expect(rpc).not.toHaveBeenCalled();
  });
});
