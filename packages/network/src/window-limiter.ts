/**
 * A sliding window per subject (docs/adr/0004, "Budgets"). `take` spends one unit when the subject
 * is under its limit and answers the seconds until the oldest unit leaves the window when it is
 * not. A refused `take` spends nothing, so a caller that keeps knocking is not pushed further out.
 *
 * In memory and per process on purpose: it costs nothing and survives nothing. With N API
 * processes a subject reaches N times the rate (decision 8).
 */
export interface WindowLimiter {
  /** Null when admitted; otherwise whole seconds to wait. A `limit` of 0 or less admits everything. */
  readonly take: (subject: string, limit: number, now: number) => number | null;
  /** Subjects remembered right now. */
  readonly subjects: () => number;
}

/** Rotating subjects would otherwise grow the map without bound: past this many, idle ones go. */
const SWEEP_AT = 5_000;
/** The most subjects one window remembers. Past it, every new subject shares one window. */
export const MAX_SUBJECTS = 50_000;
const OVERFLOW = "\u0000overflow";

export const makeWindowLimiter = (windowMs = 60_000, maxSubjects = MAX_SUBJECTS): WindowLimiter => {
  const spent = new Map<string, Array<number>>();
  // Doubled after a sweep that frees little, so a map of live subjects is not walked per request.
  let sweepAt = Math.min(SWEEP_AT, maxSubjects);
  let sweptAt = 0;
  const floor = Math.min(SWEEP_AT, maxSubjects);
  const sweep = (now: number) => {
    sweptAt = now;
    // Deleting during iteration is defined behaviour for a Map.
    for (const [key, times] of spent) {
      const newest = times[times.length - 1];
      if (newest === undefined || now - newest >= windowMs) spent.delete(key);
    }
    sweepAt = Math.min(maxSubjects, Math.max(SWEEP_AT, spent.size * 2));
  };
  return {
    take: (subject, limit, now) => {
      if (limit <= 0) return null;
      // At the threshold, and at most once a window after that: everything idle is gone by then.
      const due = spent.size >= sweepAt || (spent.size >= floor && now - sweptAt >= windowMs);
      if (!spent.has(subject) && due) sweep(now);
      // Still full of live subjects: a new one shares the overflow window, so memory stays bounded
      // and a flood of made-up subjects limits itself, not the subjects already counted.
      const key = !spent.has(subject) && spent.size >= maxSubjects ? OVERFLOW : subject;
      const times = spent.get(key) ?? [];
      while (times.length > 0 && now - (times[0] ?? now) >= windowMs) times.shift();
      const oldest = times[0];
      if (times.length >= limit && oldest !== undefined) {
        spent.set(key, times);
        return Math.max(1, Math.ceil((windowMs - (now - oldest)) / 1000));
      }
      times.push(now);
      spent.set(key, times);
      return null;
    },
    subjects: () => spent.size,
  };
};
