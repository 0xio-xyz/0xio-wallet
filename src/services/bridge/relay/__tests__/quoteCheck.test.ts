import { describe, expect, it } from 'vitest';
import {
  parseRelayChains,
  QuoteCheckError,
  relayOrderId,
  verifyQuote,
  type QuoteCheckInput,
  type RelayQuote,
} from '../quoteCheck';
import { abiFunction, decodeAbi, encodeAbi, encodeCall, hexBytes, parseParams } from '../abiDecode';
import casesFile from './fixtures/cases.json';
import relayChains from './fixtures/relay-chains.json';
import arbUsdc from './fixtures/quote-arb-usdc.json';
import baseNative from './fixtures/quote-base-native.json';
import baseUsdc from './fixtures/quote-base-usdc.json';
import ethNative from './fixtures/quote-eth-native.json';
import ethUsdc from './fixtures/quote-eth-usdc.json';

/*
 * Real quotes from the 0xio proxy (POST /bridge/any/quote) and Relay's chain list, plus tampered copies. Every
 * expected outcome in cases.json came from running the original 0xio-bridge quoteCheck.ts (ethers) on the same
 * input, so these tests pin the port to it.
 */

type Path = Array<string | number>;
type Patch = [Path, unknown];
interface Case {
  fixture: string;
  name: string;
  patches: Patch[];
  expect: { ok: boolean; quoteCheckError?: boolean; message?: string };
}
interface CasesFile {
  nowSec: number;
  fixtures: Record<
    string,
    Omit<QuoteCheckInput, 'quote' | 'outRaw' | 'user' | 'octraRecipient' | 'woct' | 'octraBridge'>
  >;
  cases: Case[];
}

const { nowSec, fixtures, cases } = casesFile as unknown as CasesFile;
const quotes: Record<string, { outRaw: string; quote: unknown }> = {
  'arb-usdc': arbUsdc,
  'base-native': baseNative,
  'base-usdc': baseUsdc,
  'eth-native': ethNative,
  'eth-usdc': ethUsdc,
};

const USER = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const OCTRA = 'oct5MrNfjiXFNRDLwsodn8Zm9hDKNGAYt3eQDCQ52bSpCHq';
const WOCT = '0x4647e1fE715c9e23959022C2416C71867F5a6E80';
const BRIDGE = '0xE7eD69b852fd2a1406080B26A37e8E04e7dA4caE';

// relayOrderId as the original (ethers TypedDataEncoder) computed it; they also equal Relay's own orderId.
const ORIGINAL_ORDER_IDS: Record<string, string> = {
  'base-native': '0x4ce3eb4e0a2b93f472eb84df73696458e1582cedfb65bb6cdea993548abc1903',
  'base-usdc': '0x796292db79b7679e9271f1b7009c97ce28d8cf0e2bfb3ba78e1744d1a7edf3db',
  'arb-usdc': '0xaf888b95d620b3c5499db344f327a9b69c659ccad5c8c8b4c4335cdcc59095d5',
};

function baseState(fixture: string) {
  const { outRaw, quote } = quotes[fixture];
  const input: QuoteCheckInput = {
    ...fixtures[fixture],
    quote: quote as RelayQuote,
    outRaw,
    user: USER,
    octraRecipient: OCTRA,
    woct: WOCT,
    octraBridge: BRIDGE,
    nowSec,
  };
  return structuredClone({ input, relayChains: relayChains.chains as unknown[] });
}

function applyWords(hex: string, hunks: Array<[number, number, string[]]>): string {
  const words = [hex.slice(0, 10), ...(hex.slice(10).match(/.{1,64}/g) ?? [])];
  for (const [at, del, insert] of [...hunks].reverse()) words.splice(at, del, ...insert);
  return words.join('');
}

function applyPatches(state: Record<string, unknown>, patches: Patch[]) {
  for (const [path, value] of patches) {
    const parent = path.slice(0, -1).reduce<any>((node, key) => node[key], state);
    const key = path[path.length - 1];
    const op = value as { $delete?: boolean; $words?: Array<[number, number, string[]]> } | null;
    if (op && typeof op === 'object' && op.$delete) delete parent[key];
    else if (op && typeof op === 'object' && op.$words)
      parent[key] = applyWords(parent[key], op.$words);
    else parent[key] = structuredClone(value);
  }
}

function outcome(fixture: string, patches: Patch[]) {
  const state = baseState(fixture);
  applyPatches(state, patches);
  try {
    verifyQuote(state.input, parseRelayChains(state.relayChains));
    return { ok: true };
  } catch (e) {
    const quoteCheckError = e instanceof QuoteCheckError;
    return { ok: false, quoteCheckError, message: quoteCheckError ? e.message : undefined };
  }
}

describe('relay quote check port', () => {
  it('has a case list from the original', () => {
    expect(Object.keys(fixtures).sort()).toEqual(Object.keys(quotes).sort());
    expect(cases.length).toBeGreaterThan(150);
  });

  it.each(Object.entries(ORIGINAL_ORDER_IDS))('recomputes the %s order id', (fixture, id) => {
    const v2 = (quotes[fixture].quote as RelayQuote).protocol?.v2;
    expect(relayOrderId(v2!.orderData!)).toBe(id);
    expect(v2!.orderId).toBe(id);
  });

  it.each(cases.map((c) => [`${c.fixture} ${c.name}`, c] as const))(
    '%s matches the original',
    (_, c) => {
      expect(outcome(c.fixture, c.patches)).toEqual({
        ok: c.expect.ok,
        ...(c.expect.ok
          ? {}
          : { quoteCheckError: c.expect.quoteCheckError, message: c.expect.message }),
      });
    }
  );

  it('reads chains the way the original does', () => {
    const chains = parseRelayChains(relayChains.chains);
    expect(chains.get(1)).toEqual({
      id: 1,
      evm: true,
      protocolChainId: 'ethereum',
      depository: '0x4cd00e387622c35bddb9b4c962c136462338bc31',
      erc20Router: '0xb92fe925dc43a0ecde6c8b1a2709c170ec4fff4f',
      approvalProxy: '0xccc88a9d1b4ed6b0eaba998850414b24f1c315be',
      solvers: expect.arrayContaining(['0xf70da97812cb96acdf810712aa562db8dfa3dbef']),
    });
    expect(parseRelayChains({ chains: [] }).size).toBe(0);
    expect(parseRelayChains([{ id: '1' }, null, { id: 2 }]).get(2)?.solvers).toEqual([]);
  });
});

describe('abi codec', () => {
  it('encodes burnToOctra like ethers', () => {
    const burn = abiFunction('burnToOctra(string octraRecipient, uint256 amount)');
    expect(burn.selector).toBe('0xe3e3aed0');
    expect(encodeCall(burn, [OCTRA, 1_500_000n])).toBe(
      '0xe3e3aed00000000000000000000000000000000000000000000000000000000000000040000000000000000000000000000000000000000000000000000000000016e360000000000000000000000000000000000000000000000000000000000000002f6f6374354d724e666a6958464e52444c77736f646e385a6d3968444b4e4741597433655144435135326253704348710000000000000000000000000000000000'
    );
  });

  it('round trips nested tuple arrays', () => {
    const params = parseParams(
      '(address target, bool allowFailure, uint256 value, bytes callData)[] calls, address to, bytes32 id, string note'
    );
    const values = [
      [
        [WOCT.toLowerCase(), false, 5n, '0xdeadbeef'],
        [BRIDGE.toLowerCase(), true, 0n, '0x'],
      ],
      USER.toLowerCase(),
      '0x' + 'ab'.repeat(32),
      'hi',
    ];
    const out = decodeAbi(params, encodeAbi(params, values));
    expect(out.calls[1].target).toBe(BRIDGE.toLowerCase());
    expect(out.calls[0].callData).toBe('0xdeadbeef');
    expect(out.calls[1].allowFailure).toBe(true);
    expect([out.to, out.id, out.note]).toEqual(values.slice(1));
  });

  it('defers bad items and throws on overruns, like ethers', () => {
    const params = parseParams('address a, address b');
    const dirty = hexBytes(
      '0x' + 'ff'.repeat(12) + '11'.repeat(20) + '00'.repeat(12) + '22'.repeat(20)
    );
    const out = decodeAbi(params, dirty);
    expect(out.b).toBe('0x' + '22'.repeat(20));
    expect(() => out.a).toThrow();
    expect(() => out[2]).toThrow(RangeError);
    expect(() => decodeAbi(params, dirty.slice(0, 40))).toThrow();
  });
});
