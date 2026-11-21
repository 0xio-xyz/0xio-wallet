import type { Wallet } from 'src/types/wallet';

export interface WarmContext {
  networkId: string;
  wallet: Wallet;
  privateBalance: number;
}

type Warmer = (ctx: WarmContext) => Promise<unknown>;

const warmers = new Set<Warmer>();

export function registerScopeWarmer(warm: Warmer): () => void {
  warmers.add(warm);
  return () => warmers.delete(warm);
}

export async function warmScope(ctx: WarmContext, budgetMs = 150): Promise<void> {
  if (warmers.size === 0) return;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const budget = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, budgetMs);
  });
  const all = Promise.allSettled([...warmers].map((warm) => warm(ctx)));
  await Promise.race([all, budget]);
  clearTimeout(timer);
}
