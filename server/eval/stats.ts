/**
 * Small statistics helpers for eval reporting.
 */

export interface Rate {
  k: number;
  n: number;
  value: number;
  /** 95% Wilson score interval. */
  ci95: [number, number];
}

const round4 = (x: number) => Math.round(x * 10000) / 10000;

/**
 * k successes out of n, with a 95% Wilson score interval.
 *
 * Wilson rather than the textbook normal approximation (p ± 1.96·√(p(1−p)/n))
 * because the normal interval collapses to [0, 0] when k = 0, which would
 * claim certainty about a 0% hallucination rate measured on a few dozen cases.
 */
export function rate(k: number, n: number, z = 1.96): Rate | null {
  if (n === 0) return null;
  const p = k / n;
  const z2 = z * z;
  const denom = 1 + z2 / n;
  const center = (p + z2 / (2 * n)) / denom;
  const half = (z * Math.sqrt((p * (1 - p)) / n + z2 / (4 * n * n))) / denom;
  return {
    k,
    n,
    value: round4(p),
    ci95: [round4(Math.max(0, center - half)), round4(Math.min(1, center + half))],
  };
}

/** "76.2% [70.0–81.5]" */
export function fmtRate(r: Rate | null, withCi = true): string {
  if (!r) return '  n/a';
  const pc = (x: number) => (x * 100).toFixed(1);
  const head = `${pc(r.value).padStart(5)}%`;
  return withCi ? `${head} [${pc(r.ci95[0])}–${pc(r.ci95[1])}]` : head;
}
