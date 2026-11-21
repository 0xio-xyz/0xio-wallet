import type { EvmCall, EvmParam } from 'src/services/evm/callDetail';
import { callAction, isUnlimited, methodWords, readableMethod } from 'src/utils/callReading';
import {
  argKind,
  argLabel,
  argLabelWords,
  capCallText,
  networkName,
  plausibleTime,
  type ArgKind,
  type ArgSpec,
} from 'src/utils/callArgs';
import { fromUnits } from 'src/utils/amount';
import { isOctAddress } from 'src/utils/octra/address';
import { middleOf, whenOf, type TxDetailRow } from './TxDetails';
import { trimAmount } from './TxRow';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export const EVM_MAX_ARGS = 10;
export const OCTRA_MAX_ARGS = 8;
export const CALL_DATA_MAX = 32;
const AMOUNT_NAMES = new Set(['value', 'amount', 'wad', 'rawamount']);
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const NOISE_NAMES = new Set(['iscreation', 'data', 'calldata', 'gaslimit']);
const BYTES = /^bytes\d*(\[\d*\])*$/;
const INTEGER = /^\d{1,80}$/;
const SELECTOR = /^0x[0-9a-f]{8}$/i;

export interface CallArg {
  index: number;
  name?: string;
  label: string;
  type?: string;
  value: string;
  friendly?: string;
}

export interface CallData {
  method: string | null;
  functionName: string | null;
  selector: string | null;
  contract: { address: string; name: string | null } | null;
  args: CallArg[];
  input: string | null;
}

const argText = (value: unknown): string =>
  typeof value === 'string'
    ? value
    : typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint'
      ? String(value)
      : (JSON.stringify(value) ?? String(value));

const isAddressText = (text: string) => isOctAddress(text) || ADDRESS.test(text);

const valueLabel = (index: number, t: Translate) =>
  t('txDetail.valueN', { n: index + 1, defaultValue: 'Value {{n}}' });

export function callMethod(
  raw: string | null | undefined,
  signature?: string | null
): Pick<CallData, 'method' | 'functionName'> {
  const name = readableMethod(raw);
  const fn = signature?.trim() || (name ? raw!.trim() : null);
  if (!name) return { method: null, functionName: fn };
  const words = methodWords(name);
  return { method: words, functionName: fn && fn !== words ? fn : null };
}

export const callSelector = (selector: string | null | undefined): string | null =>
  selector && SELECTOR.test(selector) ? selector.toLowerCase() : null;

export const callInput = (input: string | null | undefined): string | null =>
  input && input.length > 2 ? capCallText(input) : null;

const plain = (label: string, text: string): TxDetailRow => {
  const long = text.length > 28;
  return {
    label,
    value: long ? middleOf(text) : text,
    mono: long,
    copy: long ? text : undefined,
  };
};

function friendlyOf(
  text: string,
  kind: ArgKind,
  t: Translate,
  unit?: { decimals: number; symbol: string } | null
): string | null {
  if (kind === 'chain') return networkName(text);
  if (kind === 'epoch' && INTEGER.test(text)) {
    return t('txDetail.arg.epochValue', { n: text, defaultValue: 'Epoch {{n}}' });
  }
  if (kind === 'expiry') {
    const ms = plausibleTime(text);
    if (ms) return whenOf(ms);
  }
  if (kind === 'amount' && unit && INTEGER.test(text)) {
    return `${trimAmount(fromUnits(text, unit.decimals))} ${unit.symbol}`;
  }
  return null;
}

export function formatArgRow(
  label: string,
  value: unknown,
  kind: ArgKind,
  t: Translate,
  unit?: { decimals: number; symbol: string } | null
): TxDetailRow {
  const text = argText(value);
  if (isAddressText(text)) return { label, value: middleOf(text), mono: true, copy: text };
  const friendly = friendlyOf(text, kind, t, unit);
  if (friendly) return { label, value: friendly };
  if (typeof value === 'boolean' || text === 'true' || text === 'false') {
    return {
      label,
      value:
        text === 'true'
          ? t('txDetail.yes', { defaultValue: 'Yes' })
          : t('txDetail.no', { defaultValue: 'No' }),
    };
  }
  return plain(label, text);
}

function callArg(
  index: number,
  name: string | undefined,
  label: string,
  type: string | undefined,
  raw: string,
  friendly: string | null
): CallArg {
  const value = capCallText(raw);
  return {
    index,
    label,
    value,
    ...(name ? { name } : {}),
    ...(type ? { type } : {}),
    ...(friendly && friendly !== raw ? { friendly: capCallText(friendly) } : {}),
  };
}

function octraType(value: unknown): string | undefined {
  if (typeof value === 'boolean') return 'bool';
  if (typeof value === 'number') return Number.isInteger(value) ? 'int' : undefined;
  if (typeof value === 'string') return isAddressText(value) ? 'address' : 'string';
  return undefined;
}

function specUnit(
  spec: ArgSpec,
  args: readonly unknown[]
): { decimals: number; symbol: string } | null {
  if (!spec.unit) return null;
  if ('symbol' in spec.unit) return spec.unit;
  const symbol = argText(args[spec.unit.assetArg] ?? '').trim();
  const decimals = spec.unit.decimals[symbol.toUpperCase()];
  return decimals === undefined ? null : { decimals, symbol: symbol.toUpperCase() };
}

const specLabel = (spec: ArgSpec, t: Translate) =>
  spec.label ? argLabelWords(spec.label, t) : argLabel(spec.name, t);

export function knownArgPlaceholders(specs: readonly ArgSpec[], t: Translate): TxDetailRow[] {
  return specs.filter((s) => !s.onlyWhenUnread).map((s) => ({ label: specLabel(s, t), value: '' }));
}

export function octraArgRows(
  args: readonly unknown[],
  specs: readonly ArgSpec[] | null,
  abiNames: readonly string[] | null,
  t: Translate
): { rows: TxDetailRow[]; args: CallArg[] } {
  const rows: TxDetailRow[] = [];
  if (specs) {
    const read = new Set<number>();
    for (const spec of specs) {
      if (spec.index >= args.length || !spec.unit) continue;
      if (specUnit(spec, args) && 'assetArg' in spec.unit) read.add(spec.unit.assetArg);
    }
    for (const spec of specs) {
      if (spec.index >= args.length) continue;
      if (spec.onlyWhenUnread && read.has(spec.index)) continue;
      rows.push(
        formatArgRow(
          specLabel(spec, t),
          args[spec.index],
          spec.kind ?? argKind(spec.name),
          t,
          specUnit(spec, args)
        )
      );
    }
  } else if (abiNames) {
    args.forEach((value, index) => {
      const name = abiNames[index]?.trim();
      if (!name || rows.length >= OCTRA_MAX_ARGS) return;
      rows.push(formatArgRow(argLabel(name, t), value, argKind(name), t));
    });
  }
  const bySpec = new Map((specs ?? []).map((spec) => [spec.index, spec]));
  const entries = args.slice(0, CALL_DATA_MAX).map((value, index) => {
    const spec = bySpec.get(index);
    const name = spec?.name ?? (abiNames?.[index]?.trim() || undefined);
    const label = spec ? specLabel(spec, t) : name ? argLabel(name, t) : valueLabel(index, t);
    const text = argText(value);
    const friendly = isAddressText(text)
      ? null
      : friendlyOf(
          text,
          spec?.kind ?? (name ? argKind(name) : 'text'),
          t,
          spec ? specUnit(spec, args) : null
        );
    return callArg(index, name, label, octraType(value), text, friendly);
  });
  return { rows, args: entries };
}

const isNoise = (param: EvmParam) =>
  BYTES.test(param.type) || NOISE_NAMES.has(param.name.replace(/^_+/, '').toLowerCase());

export function evmShownArgs(call: EvmCall): { param: EvmParam; index: number }[] {
  return (call.params ?? [])
    .map((param, index) => ({ param, index }))
    .filter(({ param }) => !!param.name.replace(/^_+/, '') && !isNoise(param))
    .slice(0, EVM_MAX_ARGS);
}

function isTokenAmount(call: EvmCall, p: EvmParam): boolean {
  if (!p.type.startsWith('uint')) return false;
  const action = callAction(call.method);
  if (action !== 'approve' && action !== 'revoke' && action !== 'transfer') return false;
  return AMOUNT_NAMES.has(p.name.replace(/^_+/, '').toLowerCase());
}

function evmFriendly(
  call: EvmCall,
  p: EvmParam,
  names: Record<string, string | null>,
  t: Translate
): string | null {
  if (p.type === 'address' && ADDRESS.test(p.value)) return names[p.value.toLowerCase()] ?? null;
  if (isTokenAmount(call, p) && /^\d+$/.test(p.value)) {
    const symbol = call.token?.symbol;
    if (isUnlimited(p.value)) {
      const word = t('txDetail.unlimited', { defaultValue: 'Unlimited' });
      return symbol ? `${word} ${symbol}` : word;
    }
    if (call.token) return `${trimAmount(fromUnits(p.value, call.token.decimals))} ${symbol}`;
  }
  return null;
}

export function evmArgRow(
  call: EvmCall,
  p: EvmParam,
  names: Record<string, string | null>,
  t: Translate
): TxDetailRow {
  const label = argLabel(p.name, t);
  const friendly = evmFriendly(call, p, names, t);
  if (p.type === 'address' && ADDRESS.test(p.value)) {
    return { label, value: friendly ?? middleOf(p.value), mono: !friendly, copy: p.value };
  }
  if (friendly) return { label, value: friendly };
  const kind = argKind(p.name);
  if (p.type === 'bool') return formatArgRow(label, p.value === 'true' || p.value === '1', kind, t);
  return formatArgRow(label, p.value, kind, t);
}

export function evmCallData(
  call: EvmCall,
  names: Record<string, string | null>,
  t: Translate
): CallArg[] {
  return (call.params ?? []).slice(0, CALL_DATA_MAX).map((p, index) => {
    const bare = p.name.replace(/^_+/, '').trim();
    const raw = argText(p.value);
    const friendly =
      evmFriendly(call, p, names, t) ??
      (bare && !isAddressText(raw) ? friendlyOf(raw, argKind(p.name), t) : null);
    return callArg(
      index,
      p.name.trim() || undefined,
      bare ? argLabel(p.name, t) : valueLabel(index, t),
      p.type.trim() || undefined,
      raw,
      friendly
    );
  });
}

export const ouToOct = (ou: string | null | undefined): string | null => {
  const n = Number(ou);
  return ou && Number.isFinite(n) && n > 0
    ? parseFloat((n / 1_000_000).toFixed(6)).toString()
    : null;
};
