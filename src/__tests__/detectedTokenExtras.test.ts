import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  detectedEvmToken,
  detectedKey,
  detectedSignature,
  detectedSpamReason,
  loadEvmTokenPlan,
  parseDetectedToken,
  planEvmTokens,
  readDetected,
  recordSentTokens,
  refreshDetection,
  sentKey,
  type DetectedRecord,
  type DetectedToken,
} from 'src/services/evm/detectedTokens';
import { fetchEvmHistory } from 'src/services/evm/history';
import { evmNetworksFor } from 'src/services/evm/networks';
import { IMAGE_PROXY } from 'src/services/evm/nfts';
import { explorerLogoUrl } from 'src/services/evm/tokens';
import { evmManageRows } from 'src/features/settings/tokens/manageRows';
import { evmVisKey } from 'src/services/tokens/tokenVisibility';
import { clearSessionCaches } from 'src/utils/sessionCaches';

const ADDR = '0x9858EfFD232B4033E47d90003D41EC34EcaEda94';
const ADDR2 = '0xabcdef0000000000000000000000000000000002';
const PEER = '0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0';
const SPAM = '0x2222222222222222222222222222222222222222';
const GOOD = '0x3333333333333333333333333333333333333333';
const HIDDEN = '0x5555555555555555555555555555555555555555';
const ICON = 'https://assets.coingecko.com/coins/images/1/small/good.png';

let local: Record<string, unknown> = {};
const pick = (keys: unknown) => {
  if (keys === null || keys === undefined) return { ...local };
  const list = typeof keys === 'string' ? [keys] : Array.isArray(keys) ? keys : [];
  return Object.fromEntries(list.filter((k) => k in local).map((k) => [k, local[k as string]]));
};

beforeEach(() => {
  local = {};
  const c = chrome as unknown as Record<string, any>;
  c.storage.local.get = vi.fn(async (keys: unknown) => pick(keys));
  c.storage.local.set = vi.fn(async (items: Record<string, unknown>) => {
    Object.assign(local, structuredClone(items));
  });
  clearSessionCaches();
});

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

const item = (over: Partial<DetectedToken> & { contract: string }): DetectedToken => ({
  symbol: 'TKN',
  name: 'Token',
  decimals: 18,
  balance: '1000',
  price: null,
  verified: null,
  spam: false,
  spamReason: null,
  logo: null,
  ...over,
});

const record = (items: DetectedToken[], sent: string[] = []): DetectedRecord => ({
  at: Date.now(),
  indexed: true,
  complete: true,
  items,
  sent,
});

const detected = {
  1: record([
    item({ contract: GOOD, symbol: 'GOOD', decimals: 6, logo: ICON }),
    item({ contract: SPAM, symbol: 'FREE', spam: true, spamReason: 'bait' }),
    item({ contract: HIDDEN, symbol: 'HID', decimals: 0 }),
  ]),
};

const proxied = (url: string) => `${IMAGE_PROXY}?u=${encodeURIComponent(url)}`;

describe('detected tokens in History', () => {
  const ethereum = evmNetworksFor('mainnet').filter((n) => n.chainId === 1);
  const tx = (n: number) => `0x${String(n).padStart(64, '0')}`;
  const transfer = (n: number, token: string, value: string) => ({
    transaction_hash: tx(n),
    timestamp: `2026-10-1${n}T00:00:00.000000Z`,
    log_index: n,
    from: { hash: PEER },
    to: { hash: ADDR },
    total: { value },
    token: { address_hash: token },
  });
  const transfers = [
    transfer(1, GOOD, '2500000'),
    transfer(2, SPAM, '1000000000000000000'),
    transfer(3, HIDDEN, '7'),
  ];
  const stub = () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      const body = String(url).includes('/api/evm/history')
        ? { transactions: [] as unknown[], token_transfers: transfers }
        : { items: String(url).includes('token-transfers') ? transfers : [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  };
  const symbols = (items: { token: { symbol: string } | null }[]) =>
    items.map((i) => i.token?.symbol);

  it('lists shown detected tokens with their own symbol and decimals', async () => {
    stub();
    const plan = planEvmTokens({ chainIds: [1], imported: [], detected, vis: {} });
    const { items } = await fetchEvmHistory(ADDR, ethereum, {
      detected: plan.custom.filter((t) => t.detected),
    });
    expect(symbols(items)).toEqual(['HID', 'GOOD']);
    const good = items.find((i) => i.token?.symbol === 'GOOD')!;
    expect(good.amount).toBe('2.5');
    expect(good.token).toMatchObject({ detected: true, address: GOOD, logo: proxied(ICON) });
  });

  it('leaves out spam tokens and tokens the user hid', async () => {
    stub();
    const vis = { 1: { [HIDDEN.toLowerCase()]: false } };
    const plan = planEvmTokens({ chainIds: [1], imported: [], detected, vis });
    const { items } = await fetchEvmHistory(ADDR, ethereum, {
      detected: plan.custom.filter((t) => t.detected),
    });
    expect(symbols(items)).toEqual(['GOOD']);
  });

  it('without a plan, no detected token reaches the list', async () => {
    stub();
    const { items } = await fetchEvmHistory(ADDR, ethereum);
    expect(items).toEqual([]);
  });

  it('reads the plan per network and address', async () => {
    local[detectedKey(1, ADDR)] = detected[1];
    local[evmVisKey(1, ADDR)] = { [HIDDEN.toLowerCase()]: false };
    const mine = await loadEvmTokenPlan(ADDR, [1]);
    expect(mine.custom.map((t) => t.symbol)).toEqual(['GOOD']);
    expect((await loadEvmTokenPlan(ADDR2, [1])).custom).toEqual([]);
    expect((await loadEvmTokenPlan(ADDR, [4663])).custom).toEqual([]);
  });
});

describe('explorer logos', () => {
  it('takes only https URLs on known image hosts', () => {
    for (const ok of [
      ICON,
      'https://coin-images.coingecko.com/coins/images/6319/large/usdc.png?1696506694',
      'https://raw.githubusercontent.com/trustwallet/assets/master/logo.png',
    ]) {
      expect(explorerLogoUrl(ok)).toBe(ok);
    }
    for (const bad of [
      'http://assets.coingecko.com/x.png',
      'https://evil.example/x.png',
      'https://assets.coingecko.com.evil.example/x.png',
      'https://assets.coingecko.com@evil.example/x.png',
      'https://assets.coingecko.com:8443/x.png',
      'https://assets.coingecko.com',
      'https://assets.coingecko.com/a b.png',
      'https://assets.coingecko.com/a‮.png',
      `https://assets.coingecko.com/${'a'.repeat(512)}`,
      'ipfs://bafy/logo.png',
      'data:image/png;base64,AAAA',
      42,
      null,
    ]) {
      expect(explorerLogoUrl(bad)).toBeNull();
    }
  });

  it('keeps the logo on a clean item and drops it on spam or a foreign host', () => {
    const base = { contract: GOOD, symbol: 'GOOD', decimals: 6, balance: '5' };
    expect(parseDetectedToken({ ...base, logo: ICON })?.logo).toBe(ICON);
    expect(parseDetectedToken({ ...base, logo: ICON, spam: true })?.logo).toBeNull();
    expect(parseDetectedToken({ ...base, logo: 'https://evil.example/x.png' })?.logo).toBeNull();
  });

  it('renders through the image proxy only while the wallet does not call it spam', () => {
    const good = item({ contract: GOOD, symbol: 'GOOD', logo: ICON });
    expect(detectedEvmToken(1, good, null).logo).toBe(proxied(ICON));
    expect(detectedEvmToken(1, good, 'bait').logo).toBeNull();
    expect(detectedEvmToken(1, item({ contract: GOOD }), null).logo).toBeNull();

    const baited = item({ contract: SPAM, symbol: 'X', name: 'Claim now', spam: null, logo: ICON });
    const none = { imported: new Set<string>(), sent: new Set<string>() };
    expect(detectedSpamReason(1, baited, none)).toBe('bait');
    const recs = { 1: record([baited]) };
    const shown = { 1: { [SPAM.toLowerCase()]: true } };
    const plan = planEvmTokens({ chainIds: [1], imported: [], detected: recs, vis: shown });
    expect(plan.custom).toHaveLength(1);
    expect(plan.custom[0].logo).toBeNull();
  });

  it('Settings rows carry the proxied logo, spam rows keep initials', () => {
    const rows = evmManageRows({
      address: ADDR,
      networks: [{ chainId: 1, name: 'Ethereum' }],
      imported: [],
      detected: {
        1: record([
          ...detected[1].items,
          item({ contract: PEER, spam: true, spamReason: 'flagged', logo: ICON }),
        ]),
      },
      vis: {},
      balances: [],
    });
    const logo = (c: string) => rows.find((r) => r.contract === c.toLowerCase())?.logo;
    expect(logo(GOOD)).toBe(proxied(ICON));
    expect(logo(PEER)).toBeNull();
  });

  it('a new logo changes what Home reads', () => {
    const before = record([item({ contract: GOOD })]);
    const after = record([item({ contract: GOOD, logo: ICON })]);
    expect(detectedSignature(after)).not.toBe(detectedSignature(before));
  });
});

describe('tokens this wallet sent from', () => {
  const spamItem = {
    contract: SPAM,
    symbol: 'FREE',
    name: 'free.xyz',
    decimals: 6,
    balance: '5',
    spam: true,
    spamReason: 'link',
  };
  const oracle = (status = 200) =>
    vi.fn(async (url: string) => {
      if (String(url).includes('/api/evm/tokens')) {
        return status === 200
          ? new Response(JSON.stringify({ items: [spamItem], complete: true }), { status })
          : new Response('{}', { status });
      }
      const body = String(url).includes('/api/evm/history')
        ? { transactions: [] as unknown[], token_transfers: [] as unknown[] }
        : { items: [] as unknown[] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
  const verdict = (rec: DetectedRecord | undefined) =>
    detectedSpamReason(1, rec!.items[0], { imported: new Set(), sent: new Set(rec!.sent) });

  it('keeps a send per network and address, lowercase', async () => {
    expect(await recordSentTokens(1, ADDR, [SPAM, SPAM.toUpperCase().replace('0X', '0x')])).toBe(
      true
    );
    expect(local[sentKey(1, ADDR)]).toEqual([SPAM.toLowerCase()]);
    expect(sentKey(1, ADDR)).toBe(`0xio_evm_sent_1_${ADDR.toLowerCase()}`);
    expect(local[sentKey(1, ADDR2)]).toBeUndefined();
    expect(local[sentKey(4663, ADDR)]).toBeUndefined();
    await recordSentTokens(1, ADDR, ['nope']);
    expect(local[sentKey(1, ADDR)]).toEqual([SPAM.toLowerCase()]);
  });

  it('survives a refresh whose history page no longer shows the send', async () => {
    await recordSentTokens(1, ADDR, [SPAM]);
    globalThis.fetch = oracle();
    const recs = await refreshDetection(ADDR, [1], { force: true });
    expect(recs[1]?.sent).toContain(SPAM.toLowerCase());
    expect(verdict(recs[1])).toBeNull();

    clearSessionCaches();
    const again = await refreshDetection(ADDR, [1], { force: true });
    expect(verdict(again[1])).toBeNull();
    clearSessionCaches();
    expect(verdict((await readDetected([1], ADDR))[1])).toBeNull();
    expect(local[sentKey(1, ADDR)]).toEqual([SPAM.toLowerCase()]);

    const other = await refreshDetection(ADDR2, [1], { force: true });
    expect(verdict(other[1])).toBe('link');
  });

  it('a full record never pushes out a local send', async () => {
    const many = Array.from(
      { length: 500 },
      (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`
    );
    local[detectedKey(1, ADDR)] = record(
      [item({ ...spamItem, spam: true, spamReason: 'link' })],
      many
    );
    await recordSentTokens(1, ADDR, [SPAM]);
    clearSessionCaches();
    const rec = (await readDetected([1], ADDR))[1];
    expect(rec?.sent).toHaveLength(500);
    expect(verdict(rec)).toBeNull();
  });

  it('a chain the oracle stops indexing keeps the record', async () => {
    await recordSentTokens(1, ADDR, [SPAM]);
    globalThis.fetch = oracle(404);
    const recs = await refreshDetection(ADDR, [1], { force: true });
    expect(recs[1]).toMatchObject({ indexed: false, sent: [SPAM.toLowerCase()] });
    expect(local[sentKey(1, ADDR)]).toEqual([SPAM.toLowerCase()]);
  });

  it('keeps what history finds as a local send too', async () => {
    globalThis.fetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/evm/tokens')) {
        return new Response(JSON.stringify({ items: [spamItem], complete: true }), {
          status: 200,
        });
      }
      const sent = { from: { hash: ADDR }, to: { hash: PEER }, token: { address_hash: SPAM } };
      const body = String(url).includes('/api/evm/history')
        ? { transactions: [] as unknown[], token_transfers: [sent] }
        : { items: String(url).includes('token-transfers') ? [sent] : [] };
      return new Response(JSON.stringify(body), { status: 200 });
    }) as unknown as typeof fetch;
    await refreshDetection(ADDR, [1], { force: true });
    expect(local[sentKey(1, ADDR)]).toEqual([SPAM.toLowerCase()]);
  });
});
