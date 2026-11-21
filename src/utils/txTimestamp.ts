export const txTimestamp = (now: number = Date.now()): number =>
  (now % 1000 === 0 ? now + 1 : now) / 1000;
