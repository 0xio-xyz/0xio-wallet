import { createContext, useContext } from 'react';

export interface Location {
  pathname: string;
  search: string;
  hash: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  state: any;
  key: string;
}

export interface NavigateOptions {
  replace?: boolean;
  state?: unknown;
}

export interface NavigateFunction {
  (to: string, options?: NavigateOptions): void;
  (delta: number): void;
}

export type Params = Readonly<Record<string, string | undefined>>;

type SearchInit = string | URLSearchParams | Record<string, string> | [string, string][];

export type SetURLSearchParams = (
  next: SearchInit | ((prev: URLSearchParams) => SearchInit),
  options?: NavigateOptions
) => void;

export interface History {
  subscribe: (fn: () => void) => () => void;
  location: () => Location;
  navigate: NavigateFunction;
}

export function parsePath(to: string): Pick<Location, 'pathname' | 'search' | 'hash'> {
  let rest = to;
  let hash = '';
  let search = '';
  const h = rest.indexOf('#');
  if (h >= 0) {
    hash = rest.slice(h);
    rest = rest.slice(0, h);
  }
  const q = rest.indexOf('?');
  if (q >= 0) {
    search = rest.slice(q);
    rest = rest.slice(0, q);
  }
  return {
    pathname: rest,
    search: search === '?' ? '' : search,
    hash: hash === '#' ? '' : hash,
  };
}

function resolvePath(to: string, from: string): string {
  if (to.startsWith('/')) return to;
  const out = from.split('/').filter(Boolean);
  for (const part of to.split('/')) {
    if (part === '..') out.pop();
    else if (part && part !== '.') out.push(part);
  }
  return '/' + out.join('/');
}

function newKey(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function createHistory(initialEntries: string[], initialIndex?: number): History {
  const first = (entry: string, i: number): Location => {
    const parsed = parsePath(entry);
    return {
      ...parsed,
      pathname: resolvePath(parsed.pathname || '/', '/'),
      state: null,
      key: i === 0 ? 'default' : newKey(),
    };
  };
  const entries = (initialEntries.length ? initialEntries : ['/']).map(first);
  let index = Math.min(Math.max(initialIndex ?? entries.length - 1, 0), entries.length - 1);
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((fn) => fn());

  const navigate = (to: string | number, options: NavigateOptions = {}) => {
    if (typeof to === 'number') {
      const next = Math.min(Math.max(index + to, 0), entries.length - 1);
      if (next === index) return;
      index = next;
      emit();
      return;
    }
    const current = entries[index];
    const parsed = parsePath(to);
    const next: Location = {
      pathname: parsed.pathname ? resolvePath(parsed.pathname, current.pathname) : current.pathname,
      search: parsed.search,
      hash: parsed.hash,
      state: options.state ?? null,
      key: newKey(),
    };
    if (options.replace) entries[index] = next;
    else {
      entries.splice(index + 1, entries.length - index - 1, next);
      index += 1;
    }
    emit();
  };

  return {
    subscribe: (fn) => {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },
    location: () => entries[index],
    navigate: navigate as NavigateFunction,
  };
}

export const HistoryContext = createContext<History | null>(null);
export const ParamsContext = createContext<Params>({});

export function useHistory(): History {
  const history = useContext(HistoryContext);
  if (!history) throw new Error('Router hooks need a <MemoryRouter> above them');
  return history;
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

const segments = (path: string) => path.split('/').filter(Boolean);

export function matchPath(
  pattern: string,
  pathname: string
): { params: Record<string, string>; score: number } | null {
  const want = segments(pattern);
  const have = segments(pathname);
  const params: Record<string, string> = {};
  let score = 0;
  for (let i = 0; i < want.length; i++) {
    const part = want[i];
    if (part === '*') {
      params['*'] = have.slice(i).map(safeDecode).join('/');
      return { params, score };
    }
    if (i >= have.length) return null;
    if (part.startsWith(':')) {
      params[part.slice(1)] = safeDecode(have[i]);
      score += 2;
    } else if (part.toLowerCase() === have[i].toLowerCase()) score += 3;
    else return null;
  }
  return want.length === have.length ? { params, score: score + 1 } : null;
}
