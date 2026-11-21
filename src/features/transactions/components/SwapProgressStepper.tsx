import React from 'react';
import { Mascot } from 'src/shared/ui/Mascot';
import type { SwapDirection } from '../swap/types';

type ActiveStep = 'locking' | 'polling' | 'complete';
type NodeStatus = 'done' | 'active' | 'pending' | 'error';

export function SwapProgressStepper({
  step,
  failStage,
  direction,
}: {
  step: ActiveStep;
  failStage: 0 | 1 | null;
  direction: SwapDirection;
}) {
  const labels =
    direction === 'oct_to_eth'
      ? ['Lock OCT', 'Solver fills', 'Deliver ETH']
      : ['Lock ETH', 'Solver fills', 'Deliver OCT'];

  const statusFor = (i: number): NodeStatus => {
    if (failStage != null) {
      if (i < failStage) return 'done';
      if (i === failStage) return 'error';
      return 'pending';
    }
    if (step === 'complete') return 'done';
    if (step === 'locking') return i === 0 ? 'active' : 'pending';
    if (i === 0) return 'done';
    if (i === 1) return 'active';
    return 'pending';
  };

  return (
    <div className="flex! items-start! justify-center! w-full!">
      {[0, 1, 2].map((i) => {
        const s = statusFor(i);
        const connDone = s === 'done' && i < 2;
        return (
          <React.Fragment key={i}>
            <div className="flex! flex-col! items-center! w-[74px]!">
              <div className="w-8! h-8! flex! items-center! justify-center!">
                {s === 'active' ? (
                  <Mascot
                    mood="loading"
                    size={20}
                    hole="var(--bg-main)"
                    className="text-(--primary)!"
                  />
                ) : (
                  <span
                    className={`w-2! h-2! rounded-full! transition-colors! ${
                      s === 'done'
                        ? 'bg-(--primary)!'
                        : s === 'error'
                          ? 'bg-(--error)!'
                          : 'bg-(--border-color)!'
                    }`}
                  />
                )}
              </div>
              <span
                className={`text-[11px]! mt-1.5! text-center! ${
                  s === 'active' || s === 'done'
                    ? 'text-(--text-main)! font-semibold!'
                    : s === 'error'
                      ? 'text-(--error)! font-semibold!'
                      : 'text-content-muted!'
                }`}
              >
                {labels[i]}
              </span>
            </div>
            {i < 2 && (
              <div
                className={`h-[1.5px]! flex-1! mt-4! ${connDone ? 'bg-(--primary)!' : 'bg-(--border-color)!'}`}
              />
            )}
          </React.Fragment>
        );
      })}
    </div>
  );
}
