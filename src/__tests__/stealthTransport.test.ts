import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  PrivacyNetworkService,
  resetStealthTransportForTests,
} from 'src/services/network/PrivacyNetworkService';
import { stealthClaimStatus, KEY_BOUND_OUTPUT } from 'src/services/privacy/stealthWaiting';
import type { NetworkService } from 'src/services/network/NetworkService';

vi.mock('src/services/privacy/claimBudget', () => ({
  seedClaimBudget: vi.fn(),
  seedClaimBudgetEmpty: vi.fn(),
  consumeClaimSlot: vi.fn(),
  refundClaimSlot: vi.fn(),
  plausibleLayers: vi.fn(),
}));
vi.mock('src/services/network/NetworkService', () => ({
  privacyNetworkService: {},
  networkService: {},
}));
vi.mock('src/utils/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const out = (id: number, epoch: number, claimed = 0) => ({
  id,
  epoch_id: epoch,
  claimed,
  eph_pub: 'e',
  stealth_tag: 't',
  enc_amount: 'a',
});
const missing = (method: string) => ({
  error: { code: -32601, message: `method not found: ${method}` },
});

let answers: unknown[] = [];
const calls: { method: string; params: unknown[] }[] = [];
const fetchMock = vi.fn(async (_url: string, init: { body: string }) => {
  const body = JSON.parse(init.body);
  calls.push({ method: body.method, params: body.params });
  const next = answers.shift();
  return new Response(next === undefined ? '' : JSON.stringify(next));
});

const net = { id: 'mainnet' };
const service = () =>
  new PrivacyNetworkService({
    getCurrentNetworkUrl: async () => 'https://node',
    getCurrentNetworkId: async () => net.id,
  } as unknown as NetworkService);

beforeEach(() => {
  resetStealthTransportForTests();
  answers = [];
  calls.length = 0;
  fetchMock.mockClear();
  vi.stubGlobal('fetch', fetchMock);
});

describe('stealth outputs', () => {
  it('pages on devnet until has_more is false, from a null cursor', async () => {
    net.id = 'devnet';
    answers = [
      { result: { outputs: [out(9, 50), out(8, 49)], has_more: true, next_before_id: 8 } },
      { result: { outputs: [out(7, 40)], has_more: false } },
    ];
    const r = await service().getStealthOutputsPaged(10);
    expect(r.complete).toBe(true);
    expect(r.outputs.map((o) => o.id)).toEqual([9, 8, 7]);
    expect(calls.map((c) => c.params)).toEqual([
      [10, null, 64],
      [10, 8, 64],
    ]);
  });

  it('a failed page is an incomplete scan', async () => {
    net.id = 'devnet';
    answers = [
      { result: { outputs: [out(9, 50)], has_more: true, next_before_id: 9 } },
      { error: { code: -32000, message: 'busy' } },
    ];
    const r = await service().getStealthOutputsPaged(0);
    expect(r.complete).toBe(false);
    expect(r.outputs.map((o) => o.id)).toEqual([9]);
  });

  it('falls back to the one-shot read on mainnet and remembers it per network', async () => {
    net.id = 'mainnet';
    const s = service();
    answers = [
      missing('octra_stealthOutputsPage'),
      { result: { from_epoch: 1765000, count: 1, outputs: [out(461, 1765019, 1)] } },
    ];
    const r = await s.getStealthOutputsPaged(1765000);
    expect(r).toMatchObject({ complete: true, fromEpoch: 1765000 });
    expect(calls[1]).toEqual({ method: 'octra_stealthOutputs', params: [1765000] });

    answers = [{ result: { outputs: [] } }];
    await s.getStealthOutputsPaged(1765018);
    expect(calls[2]).toEqual({ method: 'octra_stealthOutputs', params: [1765018] });

    net.id = 'devnet';
    answers = [{ result: { outputs: [], has_more: false } }];
    await s.getStealthOutputsPaged(5);
    expect(calls[3].method).toBe('octra_stealthOutputsPage');
  });

  it('a first one-shot scan reads only the recent window', async () => {
    net.id = 'mainnet';
    answers = [missing('octra_stealthOutputsPage'), { result: { outputs: [] } }];
    const r = await service().getStealthOutputsPaged(0, { headEpoch: 2085711 });
    expect(calls[1]).toEqual({ method: 'octra_stealthOutputs', params: [2035711] });
    expect(r.fromEpoch).toBe(2035711);
  });

  it('reads by id one-shot from the oldest epoch where the node lacks it', async () => {
    net.id = 'mainnet';
    const s = service();
    answers = [
      missing('octra_stealthOutputsById'),
      { result: { outputs: [out(5, 300), out(6, 310), out(7, 320)] } },
    ];
    const both = await s.getStealthOutputsById([5, 7], { minEpoch: 300 });
    expect(both?.map((o) => o.id)).toEqual([5, 7]);
    answers = [{ result: { outputs: [out(5, 300)] } }];
    await expect(s.getStealthOutputsById([5, 9], { minEpoch: 300 })).resolves.toBeNull();
    answers = [{ result: { outputs: [out(5, 300)] } }];
    const some = await s.getStealthOutputsById([5, 9], { minEpoch: 300, partial: true });
    expect(some?.map((o) => o.id)).toEqual([5]);
  });

  it('refuses an incomplete by-id answer for a claim', async () => {
    net.id = 'devnet';
    answers = [{ result: { requested: 1, count: 0, complete: false, outputs: [] } }];
    await expect(service().getStealthOutputsById([0])).resolves.toBeNull();
    expect(calls[0]).toEqual({ method: 'octra_stealthOutputsById', params: [[0]] });
  });
});

describe('claim check', () => {
  const commitment = new Uint8Array(32).fill(7);
  const b64 = btoa(String.fromCharCode(...commitment));
  const owned = (over = {}) => ({
    amount: 5,
    blinding: new Uint8Array(32),
    amountHash: KEY_BOUND_OUTPUT,
    amountCommitment: b64,
    ...over,
  });

  it('is ready only when the commitment reproduces', async () => {
    await expect(stealthClaimStatus(owned(), async () => commitment)).resolves.toBe('ready');
    await expect(stealthClaimStatus(owned(), async () => new Uint8Array(32).fill(1))).resolves.toBe(
      'amount_commitment_mismatch'
    );
  });

  it('a mainnet output without amount_hash is legacy', async () => {
    await expect(
      stealthClaimStatus(owned({ amountHash: undefined }), async () => commitment)
    ).resolves.toBe('legacy_stealth_output');
  });

  it('a missing commitment is not claimable', async () => {
    await expect(
      stealthClaimStatus(owned({ amountCommitment: undefined }), async () => commitment)
    ).resolves.toBe('amount_commitment_missing');
  });
});

describe('claim by id', () => {
  it('refuses a transfer id that is not an output id before any read', async () => {
    const r = await service().claimPrivateTransfer('octA', 'pk', 'abc', undefined, {
      networkId: 'devnet',
      rpcUrl: 'https://node',
      address: 'octA',
    } as never);
    expect(r).toEqual({ success: false, error: 'Unknown transfer' });
    expect(calls).toEqual([]);
  });
});
