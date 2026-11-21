import { isOctAddress } from './address';

export const ONS_SUFFIX = '.oct';
export const ONS_NAME_MAX = 32;
export const ONS_PAGE_SIZE = 50;
export const ONS_YEARS_MIN = 1;
export const ONS_YEARS_MAX = 5;
export const ONS_BUSY_CODE = -32005;

export const ONS_SERVICE_NAME = 'Octra Name System';
export const ONS_SERVICE_SYMBOL = 'ONS';
export const ONS_INTERFACES = ['6'];

const LISTED_AS = new Map<string, string>([
  ['mainnet', 'mainnet'],
  ['devnet', 'devnet'],
  ['devnet2', 'devnet'],
]);

export const onsListNetwork = (networkId: string): string | null =>
  LISTED_AS.get(networkId) ?? null;

export type OnsInvalid = 'empty' | 'bad_character' | 'too_long' | 'hyphen_edge';
export type OnsName = { ok: true; name: string } | { ok: false; invalid: OnsInvalid };

// ASCII only: toLowerCase() maps U+212A (Kelvin sign) to "k", a look-alike.
const fold = (text: string): string =>
  text.replace(/^[ \t\n\r]+|[ \t\n\r]+$/g, '').replace(/[A-Z]/g, (c) => c.toLowerCase());

export function isNameInput(text: string): boolean {
  return typeof text === 'string' && fold(text).endsWith(ONS_SUFFIX);
}

export function normalizeName(input: string): OnsName {
  let name = typeof input === 'string' ? fold(input) : '';
  if (name.endsWith(ONS_SUFFIX)) name = name.slice(0, -ONS_SUFFIX.length);
  if (name === '') return { ok: false, invalid: 'empty' };
  if (!/^[a-z0-9-]+$/.test(name)) return { ok: false, invalid: 'bad_character' };
  if (name.length > ONS_NAME_MAX) return { ok: false, invalid: 'too_long' };
  if (name.startsWith('-') || name.endsWith('-')) return { ok: false, invalid: 'hyphen_edge' };
  return { ok: true, name };
}

export type OnsStatus = 'available' | 'active' | 'grace' | 'reserved' | 'invalid';
export type OnsKind = 'none' | 'circle' | 'wallet';
export type OnsTarget = 'wallet' | 'circle';
export type OnsCircleStatus = 'none' | 'waiting' | 'confirmed';

export interface OnsNameInfo {
  tokenId: string;
  name: string;
  owner: string;
  expires: number;
  kind: OnsKind;
  circle: string | null;
  wallet: string | null;
  circleStatus: OnsCircleStatus;
}

export interface OnsResolved {
  kind: OnsKind;
  target: string | null;
}

export interface OnsFeed {
  clock: number;
  microOctPerUsd: string;
  feedEpoch: number;
}

const STATUSES: Record<string, OnsStatus> = {
  '0': 'available',
  '1': 'active',
  '2': 'grace',
  '3': 'reserved',
  '4': 'invalid',
};
const KINDS: Record<string, OnsKind> = { '0': 'none', '1': 'circle', '2': 'wallet' };
const CIRCLE_STATUSES: Record<string, OnsCircleStatus> = {
  '0': 'none',
  '1': 'waiting',
  '2': 'confirmed',
};
const DIGITS = /^\d+$/;

const own = <T>(table: Record<string, T>, key: string): T | null =>
  Object.prototype.hasOwnProperty.call(table, key) ? table[key] : null;

const safeInt = (raw: string): number | null => {
  if (!DIGITS.test(raw)) return null;
  const n = Number(raw);
  return Number.isSafeInteger(n) ? n : null;
};

export const parseStatus = (raw: string): OnsStatus | null => own(STATUSES, raw);
export const parseKind = (raw: string): OnsKind | null => own(KINDS, raw);

export const parseTarget = (raw: string): string | null =>
  raw === '' || isOctAddress(raw) ? raw : null;

export function parseName(raw: string): string | null {
  if (raw === '') return '';
  const parsed = normalizeName(raw);
  return parsed.ok && parsed.name === raw ? raw : null;
}

export function parseNameInfo(raw: string): OnsNameInfo | null {
  const parts = raw.split('|');
  if (parts.length !== 8) return null;
  const [tokenId, name, owner, expiresRaw, kindRaw, circle, wallet, circleRaw] = parts;
  const expires = safeInt(expiresRaw);
  const kind = parseKind(kindRaw);
  const circleStatus = own(CIRCLE_STATUSES, circleRaw);
  if (!DIGITS.test(tokenId) || !name || parseName(name) === null || !isOctAddress(owner))
    return null;
  if (expires === null || kind === null || circleStatus === null) return null;
  if (parseTarget(circle) === null || parseTarget(wallet) === null) return null;
  return {
    tokenId,
    name,
    owner,
    expires,
    kind,
    circle: circle || null,
    wallet: wallet || null,
    circleStatus,
  };
}

export function parseResolve(raw: string): OnsResolved | null {
  const parts = raw.split('|');
  if (parts.length !== 2) return null;
  const kind = parseKind(parts[0]);
  if (kind === null || parseTarget(parts[1]) === null) return null;
  if (kind === 'none' && parts[1] !== '') return null;
  return { kind, target: parts[1] || null };
}

export function parseNames(raw: string): string[] | null {
  if (raw === '') return [];
  const names = raw.split(',');
  return names.every((name) => name !== '' && parseName(name) !== null) ? names : null;
}

export function parseNameList(list: unknown): Record<string, string> | null {
  const services = (list as { services?: unknown } | null)?.services;
  if (!Array.isArray(services)) return null;
  const byNetwork: Record<string, string> = Object.create(null);
  const seen = new Set<string>();
  for (const entry of services) {
    const { network, address, suffix } = (entry ?? {}) as Record<string, unknown>;
    if (typeof network !== 'string' || !/^[a-z0-9-]{1,32}$/.test(network)) continue;
    if (suffix !== ONS_SUFFIX) continue;
    if (seen.has(network)) {
      delete byNetwork[network];
      continue;
    }
    seen.add(network);
    if (typeof address === 'string' && isOctAddress(address)) byNetwork[network] = address;
  }
  return byNetwork;
}

export function isNameService(raw: string): boolean {
  const fields = raw.split('|');
  return (
    fields.length === 5 &&
    fields[0] === ONS_SERVICE_NAME &&
    fields[1] === ONS_SERVICE_SYMBOL &&
    ONS_INTERFACES.includes(fields[4])
  );
}

export const parseCount = (raw: string): number | null => safeInt(raw);

export const parsePrice = (raw: string): string | null => (DIGITS.test(raw) ? raw : null);

export function parseFeed(raw: string): OnsFeed | null {
  const parts = raw.split('|');
  if (parts.length !== 3) return null;
  const clock = safeInt(parts[0]);
  const feedEpoch = safeInt(parts[2]);
  if (clock === null || feedEpoch === null || !DIGITS.test(parts[1])) return null;
  return { clock, microOctPerUsd: parts[1], feedEpoch };
}

export type OnsFailure =
  | 'not_available'
  | 'invalid'
  | 'not_registered'
  | 'not_set'
  | 'points_to_circle'
  | 'points_to_wallet'
  | 'expired'
  | 'reserved'
  | 'service_changed'
  | 'busy'
  | 'unavailable'
  | 'bad_reply';

export function emptyTargetReason(
  target: OnsTarget,
  statusRaw: string,
  kind: OnsKind | null
): OnsFailure {
  switch (parseStatus(statusRaw)) {
    case 'available':
      return 'not_registered';
    case 'grace':
      return 'expired';
    case 'reserved':
      return 'reserved';
    case 'invalid':
      return 'invalid';
    case 'active':
      if (kind === 'none') return 'not_set';
      if (kind === 'circle' && target === 'wallet') return 'points_to_circle';
      if (kind === 'wallet' && target === 'circle') return 'points_to_wallet';
      return 'bad_reply';
    default:
      return 'bad_reply';
  }
}

export type OnsErrorCode =
  | 'busy'
  | 'bad_name'
  | 'name_reserved'
  | 'name_taken'
  | 'not_enough_sent'
  | 'feed_stale'
  | 'paused'
  | 'not_owner'
  | 'name_expired'
  | 'name_points_elsewhere'
  | 'not_authorized'
  | 'name_not_registered'
  | 'name_lapsed'
  | 'reverted'
  | 'unavailable';

const REVERTS: Record<string, OnsErrorCode> = {
  'bad name': 'bad_name',
  'name reserved': 'name_reserved',
  'name taken': 'name_taken',
  'not enough sent': 'not_enough_sent',
  'feed is stale': 'feed_stale',
  paused: 'paused',
  'not owner': 'not_owner',
  'name expired': 'name_expired',
  'name points elsewhere': 'name_points_elsewhere',
  'not authorized': 'not_authorized',
  'name not registered': 'name_not_registered',
  'name lapsed': 'name_lapsed',
};

export function onsErrorCode(message: string, code?: number): OnsErrorCode {
  const text = typeof message === 'string' ? message : '';
  if (code === ONS_BUSY_CODE || /program view busy/i.test(text)) return 'busy';
  const ons = /(?:^|[^a-z])ons: ([a-z ]+)/.exec(text);
  if (ons) return own(REVERTS, ons[1].trim()) ?? 'reverted';
  return /execution reverted/i.test(text) ? 'reverted' : 'unavailable';
}

export const isOnsRevert = (code: OnsErrorCode): boolean =>
  code !== 'busy' && code !== 'unavailable';
