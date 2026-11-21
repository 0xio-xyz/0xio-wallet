import { Children, isValidElement, useState } from 'react';
import type { ReactElement, ReactNode } from 'react';
import { HistoryContext, ParamsContext, createHistory, matchPath, parsePath } from './history';
import type { Location } from './history';
import { useLocation, useRedirect } from './hooks';

export function MemoryRouter({
  children,
  initialEntries = ['/'],
  initialIndex,
}: {
  children?: ReactNode;
  initialEntries?: string[];
  initialIndex?: number;
}) {
  const [history] = useState(() => createHistory(initialEntries, initialIndex));
  return <HistoryContext.Provider value={history}>{children}</HistoryContext.Provider>;
}

export function Navigate({
  to,
  replace,
  state,
}: {
  to: string;
  replace?: boolean;
  state?: unknown;
}): null {
  useRedirect(to, replace, state);
  return null;
}

interface RouteProps {
  path?: string;
  element?: ReactNode;
}

export function Route(props: RouteProps): null {
  void props;
  return null;
}

export function Routes({
  children,
  location: given,
}: {
  children?: ReactNode;
  location?: Pick<Location, 'pathname'> | string;
}) {
  const current = useLocation();
  const pathname =
    typeof given === 'string' ? parsePath(given).pathname : (given ?? current).pathname;

  let best: { element: ReactNode; params: Record<string, string>; score: number } | null = null;
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    const { path, element } = (child as ReactElement<RouteProps>).props;
    if (path === undefined) return;
    const hit = matchPath(path, pathname);
    if (hit && (!best || hit.score > best.score)) best = { element, ...hit };
  });

  const found = best as { element: ReactNode; params: Record<string, string> } | null;
  if (!found) return null;
  return <ParamsContext.Provider value={found.params}>{found.element}</ParamsContext.Provider>;
}
