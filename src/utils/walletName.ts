const NUMBERED = /^(.*\S)\s+(\d+)$/;

export const uniqueWalletName = (
  base: string,
  existing: readonly string[],
  max = Infinity
): string => {
  const name = base.trim().slice(0, max).trimEnd();
  const taken = new Set(existing.map((n) => n.trim().toLowerCase()));
  if (!name || !taken.has(name.toLowerCase())) return name;
  const stem = NUMBERED.exec(name)?.[1] ?? name;
  const key = stem.toLowerCase();
  let n = 1;
  for (const t of taken) {
    const m = NUMBERED.exec(t);
    if (m && m[1] === key) n = Math.max(n, Number(m[2]));
  }
  for (;;) {
    const suffix = ` ${++n}`;
    const candidate = `${stem.slice(0, max - suffix.length).trimEnd()}${suffix}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
};
