import { ZeroXIOConfig } from 'src/utils/config';

/**
 * Spam rules for token and NFT collection names, shared by the EVM fallback (when the oracle
 * gave no verdict), Octra tokens and NFT collections. They mirror the oracle's evm_tokens.rs, so
 * the wallet and the oracle judge the same name the same way.
 */

export type SpamReason = 'flagged' | 'link' | 'bait' | 'impersonation' | 'unverified_unpriced';

const REASONS: readonly SpamReason[] = [
  'flagged',
  'link',
  'bait',
  'impersonation',
  'unverified_unpriced',
];

export const isSpamReason = (v: unknown): v is SpamReason =>
  typeof v === 'string' && (REASONS as readonly string[]).includes(v);

const HIDDEN =
  // eslint-disable-next-line no-control-regex
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]|\u034f/g;

const LOOKALIKE: ReadonlyMap<string, string> = new Map(
  (
    [
      ['аα', 'a'],
      ['АΑ', 'A'],
      ['ВΒ', 'B'],
      ['Ьь', 'b'],
      ['сϲ', 'c'],
      ['СϹ', 'C'],
      ['ԁ', 'd'],
      ['Ԁ', 'D'],
      ['еε', 'e'],
      ['ЕΕ', 'E'],
      ['һ', 'h'],
      ['НΗ', 'H'],
      ['іιı', 'i'],
      ['ІΙӀ', 'I'],
      ['ј', 'j'],
      ['Ј', 'J'],
      ['κк', 'k'],
      ['КΚ', 'K'],
      ['ӏ', 'l'],
      ['МΜ', 'M'],
      ['Ν', 'N'],
      ['ηп', 'n'],
      ['оο', 'o'],
      ['ОΟ', 'O'],
      ['рρ', 'p'],
      ['РΡ', 'P'],
      ['ԛ', 'q'],
      ['ѕ', 's'],
      ['Ѕ', 'S'],
      ['тτ', 't'],
      ['ТΤ', 'T'],
      ['υ', 'u'],
      ['ν', 'v'],
      ['ԝω', 'w'],
      ['Ԝ', 'W'],
      ['хχ', 'x'],
      ['ХΧ', 'X'],
      ['уγ', 'y'],
      ['УΥҮ', 'Y'],
      ['Ζ', 'Z'],
    ] as const
  ).flatMap(([from, to]) => [...from].map((c) => [c, to] as [string, string]))
);
const DOTS = new Set(['\u2024', '\u3002', '\uff61', '\ufe52']);

export function foldConfusables(text: string): string {
  let out = '';
  for (const c of text.replace(HIDDEN, '')) {
    const cp = c.codePointAt(0) ?? 0;
    if (cp >= 0xff01 && cp <= 0xff5e) out += String.fromCodePoint(cp - 0xfee0);
    else if (DOTS.has(c)) out += '.';
    else out += LOOKALIKE.get(c) ?? c;
  }
  return out;
}

export const normalizeSymbol = (symbol: string): string =>
  foldConfusables(symbol).replace(/\s+/gu, '').toLowerCase();

const ALNUM = /[\p{Alphabetic}\p{N}]/u;
const ALPHA = /\p{Alphabetic}/u;
const LOWER = /\p{Lowercase}/u;
const UPPER = /\p{Uppercase}/u;

export function hasLink(text: string): boolean {
  const s = foldConfusables(text).toLowerCase();
  if (s.includes('http') || s.includes('www.')) return true;
  const chars = [...s];
  return chars.some((c, i) => {
    if (c !== '.' || i === 0 || !ALNUM.test(chars[i - 1])) return false;
    let tld = 0;
    while (tld < 11 && /^[a-z]$/.test(chars[i + 1 + tld] ?? '')) tld++;
    return tld >= 2 && tld <= 10;
  });
}

function words(text: string): string[] {
  const out: string[] = [];
  let cur = '';
  let prev: string | null = null;
  for (const c of foldConfusables(text)) {
    const boundary =
      prev !== null && ((LOWER.test(prev) && UPPER.test(c)) || ALPHA.test(prev) !== ALPHA.test(c));
    const alnum = ALNUM.test(c);
    if ((!alnum || boundary) && cur) {
      out.push(cur.toLowerCase());
      cur = '';
    }
    if (alnum) {
      cur += c;
      prev = c;
    } else prev = null;
  }
  if (cur) out.push(cur.toLowerCase());
  return out;
}

const BAIT_WORDS = [
  'claim',
  'reward',
  'rewards',
  'airdrop',
  'visit',
  'free',
  'voucher',
  'bonus',
  'gift',
  'redeem',
  'eligible',
];
const BAIT_ANYWHERE = ['airdrop', 'voucher', 'eligible'];

export function hasBait(text: string): boolean {
  const lower = foldConfusables(text).toLowerCase();
  if (BAIT_ANYWHERE.some((w) => lower.includes(w))) return true;
  return words(text).some((w) =>
    BAIT_WORDS.some(
      (b) => w === b || (w.length === b.length + 1 && w.startsWith(b) && w.endsWith('s'))
    )
  );
}

const OCT_ETHEREUM = '0x4647e1fe715c9e23959022c2416c71867f5a6e80';
const WETH_OP_STACK = '0x4200000000000000000000000000000000000006';

/**
 * Canonical contracts per chain and normalized symbol. A listed symbol on another contract is an
 * impersonation; an empty list means no ERC-20 may use that symbol on that chain.
 */
const CANONICAL: ReadonlyMap<number, ReadonlyMap<string, readonly string[]>> = new Map(
  (
    [
      [
        1,
        [
          ['eth', []],
          ['weth', ['0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2']],
          ['usdc', ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48']],
          ['usdt', ['0xdac17f958d2ee523a2206206994597c13d831ec7']],
          ['dai', ['0x6b175474e89094c44da98b954eedeac495271d0f']],
          ['wbtc', ['0x2260fac5e5542a773aa44fbcfedf7c193bc2c599']],
        ],
      ],
      [
        4663,
        [
          ['eth', []],
          ['weth', ['0x0bd7d308f8e1639fab988df18a8011f41eacad73']],
          ['usdc', []],
          ['usdt', []],
          ['dai', []],
          ['wbtc', []],
        ],
      ],
      [
        8453,
        [
          ['eth', []],
          ['weth', [WETH_OP_STACK]],
          ['usdc', ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913']],
          ['dai', ['0x50c5725949a6f0c72e6c4a641f24049a917db0cb']],
        ],
      ],
      [
        42161,
        [
          ['eth', []],
          ['weth', ['0x82af49447d8a07e3bd95bd0d56f35241523fbab1']],
          [
            'usdc',
            [
              '0xaf88d065e77c8cc2239327c5edb3a432268e5831',
              '0xff970a61a04b1ca14834a43f5de4533ebddb5cc8',
            ],
          ],
          ['usdt', ['0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9']],
          ['dai', ['0xda10009cbd5d07dd0cecc66161fc93d7c9000da1']],
          ['wbtc', ['0x2f2a2543b76a4166549f7aab2e75bef0aefc5b0f']],
        ],
      ],
      [
        10,
        [
          ['eth', []],
          ['weth', [WETH_OP_STACK]],
          [
            'usdc',
            [
              '0x0b2c639c533813f4aa9d7837caf62653d097ff85',
              '0x7f5c764cbc14f9669b88837ca1490cca17c31607',
            ],
          ],
          ['usdt', ['0x94b008aa00579c1307b0ef2c499ad98a8ce58e58']],
          ['dai', ['0xda10009cbd5d07dd0cecc66161fc93d7c9000da1']],
          ['wbtc', ['0x68f180fcce6836688e9084f035309e29bf0a2095']],
        ],
      ],
      [
        137,
        [
          ['weth', ['0x7ceb23fd6bc0add59e62ac25578270cff1b9f619']],
          [
            'usdc',
            [
              '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
              '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
            ],
          ],
          ['usdt', ['0xc2132d05d31c914a87c6611c10748aeb04b58e8f']],
          ['dai', ['0x8f3cf7ad23cd3cadbd9735aff958023239c6a063']],
          ['wbtc', ['0x1bfd67037b42cf73acf2047067bd4f2c47d9bfd6']],
        ],
      ],
    ] as [number, [string, string[]][]][]
  ).map(([chain, list]) => [chain, new Map(list)])
);

const EVERY_CHAIN: ReadonlyMap<string, readonly [number, string][]> = new Map([
  ['oct', [[1, OCT_ETHEREUM]]],
  ['woct', [[1, OCT_ETHEREUM]]],
]);

export function impersonatesEvm(chainId: number, symbol: string, contract: string): boolean {
  const sym = normalizeSymbol(symbol);
  const c = contract.toLowerCase();
  const homes = EVERY_CHAIN.get(sym);
  if (homes) return !homes.some(([chain, a]) => chain === chainId && a === c);
  const set = CANONICAL.get(chainId)?.get(sym);
  return !!set && !set.includes(c);
}

export function impersonatesOctra(networkId: string, symbol: string, contract: string): boolean {
  const sym = normalizeSymbol(symbol);
  if (sym !== 'oct' && sym !== 'woct') return false;
  const known = ZeroXIOConfig.CONTRACTS.WOCT[networkId];
  return !known || contract !== known;
}

interface NameInput {
  symbol?: string | null;
  name?: string | null;
  priced: boolean;
}

function textRules(input: NameInput): SpamReason | null {
  if (input.priced) return null;
  const texts = [input.symbol, input.name].filter((t): t is string => !!t);
  if (texts.some(hasLink)) return 'link';
  if (texts.some(hasBait)) return 'bait';
  return null;
}

export function evmSpamReason(
  chainId: number,
  contract: string,
  input: NameInput
): SpamReason | null {
  return (
    textRules(input) ??
    (input.symbol && impersonatesEvm(chainId, input.symbol, contract) ? 'impersonation' : null)
  );
}

export function octraSpamReason(
  networkId: string,
  contract: string,
  input: NameInput
): SpamReason | null {
  return (
    textRules(input) ??
    (input.symbol && impersonatesOctra(networkId, input.symbol, contract) ? 'impersonation' : null)
  );
}

export function collectionSpamReason(name: string | null | undefined): 'link' | 'bait' | null {
  if (!name) return null;
  if (hasLink(name)) return 'link';
  if (hasBait(name)) return 'bait';
  return null;
}

export const tokenShown = (override: boolean | undefined, spam: SpamReason | null): boolean =>
  override ?? spam === null;
