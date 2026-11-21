import { act, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import {
  MemoryRouter,
  Navigate,
  Route,
  Routes,
  matchPath,
  useLocation,
  useNavigate,
  useParams,
  useSearchParams,
} from 'src/lib/router';
import type {
  Location,
  NavigateFunction,
  NavigateOptions,
  SetURLSearchParams,
} from 'src/lib/router';

const seen: { nav: NavigateFunction[]; loc: Location[]; setSearch?: SetURLSearchParams } = {
  nav: [],
  loc: [],
};

function Probe() {
  const navigate = useNavigate();
  const location = useLocation();
  const [search, setSearch] = useSearchParams();
  seen.nav.push(navigate);
  seen.loc.push(location);
  seen.setSearch = setSearch;
  return (
    <p data-testid="where">
      {location.pathname}
      {location.search}|{JSON.stringify(location.state)}|{search.get('mode') ?? ''}
    </p>
  );
}

function Param({ name }: { name: string }) {
  return <p data-testid="param">{useParams()[name]}</p>;
}

function app(entries?: string[]) {
  seen.nav = [];
  seen.loc = [];
  return render(
    <MemoryRouter initialEntries={entries}>
      <Probe />
      <Routes>
        <Route path="/" element={<p>home</p>} />
        <Route path="/send" element={<p>send</p>} />
        <Route path="/send/evm" element={<p>send evm</p>} />
        <Route path="/claim" element={<Navigate to="/privacy" replace />} />
        <Route path="/privacy" element={<p>privacy</p>} />
        <Route path="/settings/networks" element={<p>networks</p>} />
        <Route path="/settings/networks/:chainId" element={<Param name="chainId" />} />
        <Route path="/dapp-approval/:approvalId" element={<Param name="approvalId" />} />
      </Routes>
    </MemoryRouter>
  );
}

const where = () => screen.getByTestId('where').textContent;
const nav = () => seen.nav[seen.nav.length - 1];
const go = (to: string | number, options?: NavigateOptions) =>
  act(() => (nav() as (to: string | number, options?: NavigateOptions) => void)(to, options));

describe('router', () => {
  it('starts at / and renders the matching route', () => {
    app();
    expect(where()).toBe('/|null|');
    expect(screen.getByText('home')).toBeTruthy();
    expect(seen.loc[0].key).toBe('default');
  });

  it('starts at the initial entry, with its search', () => {
    app(['/privacy?mode=decrypt']);
    expect(where()).toBe('/privacy?mode=decrypt|null|decrypt');
    expect(screen.getByText('privacy')).toBeTruthy();
  });

  it('matches static paths exactly, not by prefix', () => {
    app(['/send/evm']);
    expect(screen.getByText('send evm')).toBeTruthy();
    go('/send');
    expect(screen.getByText('send')).toBeTruthy();
    go('/settings/networks');
    expect(screen.getByText('networks')).toBeTruthy();
  });

  it('reads params and decodes them', () => {
    app(['/settings/networks/8453']);
    expect(screen.getByTestId('param').textContent).toBe('8453');
    go('/dapp-approval/a%20b');
    expect(screen.getByTestId('param').textContent).toBe('a b');
  });

  it('renders nothing for an unknown path', () => {
    app(['/nowhere']);
    expect(where()).toBe('/nowhere|null|');
    expect(screen.queryByText('home')).toBeNull();
  });

  it('pushes, goes back and stops at the first entry', () => {
    app();
    go('/send');
    go('/privacy');
    expect(where()).toBe('/privacy|null|');
    go(-1);
    expect(where()).toBe('/send|null|');
    go(-1);
    go(-1);
    expect(where()).toBe('/|null|');
  });

  it('replace swaps the entry instead of adding one', () => {
    app();
    go('/send');
    go('/privacy', { replace: true });
    go(-1);
    expect(where()).toBe('/|null|');
  });

  it('a push after going back drops the forward entries', () => {
    app();
    go('/send');
    go(-1);
    go('/privacy');
    go(1);
    expect(where()).toBe('/privacy|null|');
    go(-1);
    expect(where()).toBe('/|null|');
  });

  it('carries state and gives every entry its own key', () => {
    app();
    go('/send', { state: { token: 'x', private: true } });
    expect(where()).toBe('/send|{"token":"x","private":true}|');
    const first = seen.loc[seen.loc.length - 1].key;
    go('/send');
    expect(where()).toBe('/send|null|');
    expect(seen.loc[seen.loc.length - 1].key).not.toBe(first);
    go(-1);
    expect(where()).toBe('/send|{"token":"x","private":true}|');
  });

  it('keeps one navigate function for the life of the router', () => {
    app();
    go('/send');
    go('/privacy?mode=decrypt');
    expect(new Set(seen.nav).size).toBe(1);
  });

  it('reads and sets search params', () => {
    app();
    go('/privacy?mode=decrypt&compact=1');
    expect(where()).toBe('/privacy?mode=decrypt&compact=1|null|decrypt');
    act(() => seen.setSearch!({ mode: 'encrypt' }));
    expect(where()).toBe('/privacy?mode=encrypt|null|encrypt');
    act(() =>
      seen.setSearch!((prev) => {
        prev.delete('mode');
        return prev;
      })
    );
    expect(where()).toBe('/privacy|null|');
  });

  it('Navigate redirects and replaces', () => {
    app();
    go('/claim');
    expect(where()).toBe('/privacy|null|');
    go(-1);
    expect(where()).toBe('/|null|');
  });

  it('Routes follows a location prop over the live one', () => {
    render(
      <MemoryRouter initialEntries={['/send']}>
        <Routes location={{ pathname: '/privacy' }}>
          <Route path="/send" element={<p>send</p>} />
          <Route path="/privacy" element={<p>privacy</p>} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('privacy')).toBeTruthy();
  });

  it('a static segment beats a param at the same depth', () => {
    render(
      <MemoryRouter initialEntries={['/a/new']}>
        <Routes>
          <Route path="/a/:id" element={<p>param</p>} />
          <Route path="/a/new" element={<p>static</p>} />
        </Routes>
      </MemoryRouter>
    );
    expect(screen.getByText('static')).toBeTruthy();
  });

  it('matchPath handles params, splats and length', () => {
    expect(matchPath('/a/:id', '/a/7')?.params).toEqual({ id: '7' });
    expect(matchPath('/a/:id', '/a')).toBeNull();
    expect(matchPath('/a', '/a/7')).toBeNull();
    expect(matchPath('/a/*', '/a/b/c')?.params).toEqual({ '*': 'b/c' });
    expect(matchPath('*', '/anything')?.params).toEqual({ '*': 'anything' });
    expect(matchPath('/', '/')).not.toBeNull();
  });
});
