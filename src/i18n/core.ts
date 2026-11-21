export type TOptions = Record<string, unknown>;
export type TFunction = (key: string, a?: string | TOptions, b?: TOptions) => string;
export type Resources = Record<string, unknown>;

interface Snapshot {
  language: string;
  t: TFunction;
}

const NS = 'translation';
const own = (o: object, k: string) => Object.prototype.hasOwnProperty.call(o, k);
const isNode = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

let resources: Record<string, Resources> = {};
let fallback = 'en';
const listeners = new Set<() => void>();

function find(tree: unknown, key: string): unknown {
  if (!isNode(tree)) return undefined;
  if (own(tree, key)) return tree[key];
  const parts = key.split('.');
  let node: unknown = tree;
  for (let i = 0; i < parts.length; i++) {
    if (!isNode(node)) return undefined;
    let hit = false;
    for (let j = parts.length; j > i; j--) {
      const head = parts.slice(i, j).join('.');
      if (own(node, head)) {
        node = node[head];
        i = j - 1;
        hit = true;
        break;
      }
    }
    if (!hit) return undefined;
  }
  return node;
}

function isPath(key: string): boolean {
  const prose = /[ ,?!;]/;
  if (!prose.test(key)) return true;
  const dot = key.indexOf('.');
  return dot > 0 && !prose.test(key.slice(0, dot));
}

function hierarchy(lng: string): string[] {
  const out = [lng];
  const base = lng.split('-')[0];
  if (base !== lng) out.push(base);
  if (!out.includes(fallback)) out.push(fallback);
  return out;
}

function pluralSuffix(lng: string, count: number): string {
  try {
    return '_' + new Intl.PluralRules(lng).select(count);
  } catch {
    return '_' + new Intl.PluralRules('en').select(count);
  }
}

function lookup(lng: string, key: string, opts: TOptions): unknown {
  const plural = opts.count !== undefined && typeof opts.count !== 'string';
  for (const code of hierarchy(lng)) {
    const tree = resources[code];
    if (!tree) continue;
    const tries: string[] = [];
    if (plural) {
      if (opts.count === 0) tries.push(key + '_zero');
      tries.push(key + pluralSuffix(code, opts.count as number));
    }
    tries.push(key);
    for (const k of tries) {
      const hit = find(tree, k);
      if (hit !== undefined && hit !== null) return hit;
    }
  }
  return undefined;
}

function valueOf(data: TOptions, name: string): unknown {
  if (own(data, name)) return data[name];
  let node: unknown = data;
  for (const part of name.split('.')) {
    if (!isNode(node) || !own(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function interpolate(text: string, data: TOptions): string {
  return text.replace(/\{\{(.+?)\}\}/g, (whole, raw: string) => {
    const name = raw.trim().replace(/^-\s*/, '');
    const value = valueOf(data, name);
    if (value === undefined) return own(data, name) ? '' : whole;
    return value === null ? '' : String(value);
  });
}

function defaultOf(lng: string, opts: TOptions): unknown {
  if (opts.count !== undefined && typeof opts.count !== 'string') {
    const zero = opts.count === 0 ? opts.defaultValue_zero : undefined;
    const form = opts['defaultValue' + pluralSuffix(lng, opts.count as number)];
    return zero || form || opts.defaultValue;
  }
  return opts.defaultValue;
}

function translate(lng: string, rawKey: string, a?: string | TOptions, b?: TOptions): string {
  const opts: TOptions = typeof a === 'string' ? { ...b, defaultValue: a } : (a ?? {});
  if (rawKey === undefined || rawKey === null) return '';
  let key = String(rawKey);
  let ns = NS;
  if (key.includes(':') && isPath(key) && !key.includes('$t(')) {
    const parts = key.split(':');
    ns = parts.shift() as string;
    key = parts.join('.');
  }
  let res = ns === NS ? lookup(lng, key, opts) : undefined;
  if (isNode(res)) return `key '${key} (${lng})' returned an object instead of string.`;
  if (res === undefined) {
    const hasDefault = Object.keys(opts).some(
      (k) => k.startsWith('defaultValue') && opts[k] !== undefined
    );
    if (hasDefault) res = defaultOf(lng, opts);
    if (res === undefined || res === null) res = key;
  }
  return typeof res === 'string' ? interpolate(res, opts) : (res as string);
}

const snapshotFor = (language: string): Snapshot => ({
  language,
  t: (key, a, b) => translate(language, key, a, b),
});

let snapshot = snapshotFor('en');

const notify = () => listeners.forEach((fn) => fn());
export const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const read = () => snapshot;

export interface I18n {
  readonly language: string;
  readonly resolvedLanguage: string;
  t: TFunction;
  init(config: { resources: Record<string, Resources>; lng?: string; fallbackLng?: string }): void;
  changeLanguage(lng: string): Promise<TFunction>;
}

const i18n: I18n = {
  get language() {
    return snapshot.language;
  },
  get resolvedLanguage() {
    return hierarchy(snapshot.language).find((code) => resources[code]) ?? snapshot.language;
  },
  t: (key, a, b) => translate(snapshot.language, key, a, b),
  init(config) {
    resources = config.resources;
    fallback = config.fallbackLng ?? 'en';
    snapshot = snapshotFor(config.lng ?? fallback);
    notify();
  },
  changeLanguage(lng) {
    if (lng && lng !== snapshot.language) {
      snapshot = snapshotFor(lng);
      notify();
    }
    return Promise.resolve(snapshot.t);
  },
};

export default i18n;
