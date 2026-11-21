import { isSafePosterDataUrl } from 'src/features/wallet/nft/euint/LivingNftFrame';
import { getPoster, posterKey, savePoster } from 'src/features/wallet/nft/euint/posterCache';

export interface PosterJob {
  networkId: string;
  contract: string;
  tokenId: string;
  uri: string;
  scope: string;
}

export const jobKey = (j: Pick<PosterJob, 'networkId' | 'contract' | 'tokenId'>) =>
  posterKey(j.networkId, j.contract, j.tokenId);

interface Options {
  concurrency?: number;
  timeoutMs?: number;
  hasPoster: (job: PosterJob) => Promise<boolean>;
  save: (job: PosterJob, dataUrl: string) => Promise<void> | void;
}

interface Slot {
  job: PosterJob;
  timer: ReturnType<typeof setTimeout> | null;
  framed: boolean;
}

export function createPosterQueue({
  concurrency = 2,
  timeoutMs = 10_000,
  hasPoster,
  save,
}: Options) {
  const pending = new Map<string, PosterJob>();
  const refs = new Map<string, number>();
  const running = new Map<string, Slot>();
  const failed = new Set<string>();
  const done = new Set<string>();
  const listeners = new Set<() => void>();
  let scope: string | null = null;
  let active = false;
  let frames: PosterJob[] = [];

  const emit = () => {
    frames = [...running.values()].filter((s) => s.framed).map((s) => s.job);
    for (const fn of [...listeners]) fn();
  };

  const stop = (key: string, requeue: boolean) => {
    const slot = running.get(key);
    if (!slot) return;
    if (slot.timer) clearTimeout(slot.timer);
    running.delete(key);
    if (requeue && (refs.get(key) ?? 0) > 0) pending.set(key, slot.job);
  };

  const finish = (key: string, ok: boolean) => {
    if (!running.has(key)) return;
    stop(key, false);
    (ok ? done : failed).add(key);
    pending.delete(key);
    emit();
    pump();
  };

  const start = (key: string, job: PosterJob) => {
    const slot: Slot = { job, timer: null, framed: false };
    running.set(key, slot);
    void hasPoster(job)
      .catch(() => false)
      .then((has) => {
        if (running.get(key) !== slot) return;
        if (has) return finish(key, true);
        slot.framed = true;
        slot.timer = setTimeout(() => finish(key, false), timeoutMs);
        emit();
      });
  };

  function pump() {
    if (!active) return;
    for (const [key, job] of [...pending]) {
      if (running.size >= concurrency) break;
      if (job.scope !== scope) continue;
      pending.delete(key);
      start(key, job);
    }
  }

  return {
    request(job: PosterJob): () => void {
      const key = jobKey(job);
      if (done.has(key) || failed.has(key)) return () => {};
      refs.set(key, (refs.get(key) ?? 0) + 1);
      if (!running.has(key)) pending.set(key, job);
      pump();
      let released = false;
      return () => {
        if (released) return;
        released = true;
        const n = (refs.get(key) ?? 1) - 1;
        if (n > 0) return void refs.set(key, n);
        refs.delete(key);
        pending.delete(key);
        if (running.has(key)) {
          stop(key, false);
          emit();
          pump();
        }
      };
    },

    complete(job: PosterJob, dataUrl: string) {
      const key = jobKey(job);
      if (!running.has(key) || !isSafePosterDataUrl(dataUrl)) return;
      finish(key, true);
      void Promise.resolve()
        .then(() => save(job, dataUrl))
        .catch(() => {});
    },

    fail(job: PosterJob) {
      finish(jobKey(job), false);
    },

    forget(key: string) {
      done.delete(key);
      failed.delete(key);
    },

    setScope(next: string | null) {
      if (next === scope) return;
      scope = next;
      for (const [key, job] of [...pending]) if (job.scope !== next) pending.delete(key);
      for (const [key, slot] of [...running]) if (slot.job.scope !== next) stop(key, false);
      emit();
      pump();
    },

    setActive(next: boolean) {
      if (next === active) return;
      active = next;
      if (!next) {
        for (const key of [...running.keys()]) stop(key, true);
        emit();
      }
      pump();
    },

    subscribe(fn: () => void): () => void {
      listeners.add(fn);
      return () => {
        listeners.delete(fn);
      };
    },

    frames: (): PosterJob[] => frames,
  };
}

export type PosterQueue = ReturnType<typeof createPosterQueue>;

export const posterQueue = createPosterQueue({
  hasPoster: async (j) => !!(await getPoster(j.networkId, j.contract, j.tokenId)),
  save: (j, dataUrl) => savePoster(j.networkId, j.contract, j.tokenId, dataUrl),
});
