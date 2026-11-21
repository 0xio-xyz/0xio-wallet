import { networkService } from 'src/services/network/NetworkService';

export async function callView(
  contract: string,
  method: string,
  params: unknown[] = [],
  caller?: string
): Promise<string | null> {
  try {
    const r = await networkService.contractCallView(
      contract,
      method,
      params.length > 0 ? params : '',
      caller ?? contract
    );
    return r != null ? String(r) : null;
  } catch {
    return null;
  }
}

// Like callView, but lets a node error (timeout / unreachable) PROPAGATE instead of swallowing
// it into null. Use when a timeout must not masquerade as a real negative - e.g. "is this token
// listed?" must never answer "no" just because the node didn't respond.
export async function callViewStrict(
  contract: string,
  method: string,
  params: unknown[] = [],
  caller?: string
): Promise<string | null> {
  const r = await networkService.contractCallView(
    contract,
    method,
    params.length > 0 ? params : '',
    caller ?? contract
  );
  return r != null ? String(r) : null;
}

export const splitPipe = (s: string | null): string[] => (s ? s.split('|') : []);
export const splitEntries = (s: string | null): string[] => (s ? s.split('~') : []);
export const toNum = (s: string | undefined): number => {
  const n = Number(s);
  return Number.isFinite(n) ? n : 0;
};
export const isTruthy = (s: string | undefined): boolean => s === '1' || s === 'true';
