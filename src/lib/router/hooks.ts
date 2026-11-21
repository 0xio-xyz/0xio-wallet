import { useCallback, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { ParamsContext, useHistory } from './history';
import type { Location, NavigateFunction, Params, SetURLSearchParams } from './history';

export function useLocation(): Location {
  const history = useHistory();
  return useSyncExternalStore(history.subscribe, history.location, history.location);
}

export function useNavigate(): NavigateFunction {
  return useHistory().navigate;
}

export function useParams(): Params {
  return useContext(ParamsContext);
}

export function useSearchParams(): [URLSearchParams, SetURLSearchParams] {
  const history = useHistory();
  const { search } = useLocation();
  const params = useMemo(() => new URLSearchParams(search), [search]);
  const setParams = useCallback<SetURLSearchParams>(
    (next, options) => {
      const current = history.location();
      const value = typeof next === 'function' ? next(new URLSearchParams(current.search)) : next;
      const text = new URLSearchParams(value).toString();
      history.navigate((text ? '?' + text : current.pathname) + current.hash, options);
    },
    [history]
  );
  return [params, setParams];
}

export function useRedirect(to: string, replace: boolean | undefined, state: unknown) {
  const navigate = useNavigate();
  useEffect(() => {
    navigate(to, { replace, state });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []); // effect:audited - a redirect runs once when it mounts
}
