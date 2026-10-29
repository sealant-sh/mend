const DURATION_UNIT_MS: Readonly<Record<string, number>> = { s: 1000, m: 60_000, h: 3_600_000 };

/**
 * A duration in milliseconds, or null when it is not one: `90` and `90s` are seconds, `5m`
 * minutes, `1h` hours, fractions allowed (`.5`, `1.5m`), above 0. `mend wait`, `mend service run
 * --wait` and a recipe's `ready.timeout` read it the same way.
 */
export const parseDuration = (text: string): number | null => {
  const trimmed = text.trim();
  const unit = DURATION_UNIT_MS[trimmed.slice(-1)];
  // A bare number is seconds, read as `mend wait` always read it (`.5`, `1e2`).
  const amount =
    unit === undefined
      ? trimmed === ""
        ? Number.NaN
        : Number(trimmed)
      : /^(?:\d+\.?\d*|\.\d+)$/u.test(trimmed.slice(0, -1))
        ? Number(trimmed.slice(0, -1))
        : Number.NaN;
  const ms = Math.ceil(amount * (unit ?? 1000));
  return Number.isFinite(ms) && ms > 0 ? ms : null;
};

/** `10 min`, `90 s`, `1 h 30 min`: a duration as Mend says it. */
export const durationLine = (ms: number): string => {
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  if (minutes < 60) return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours} h` : `${hours} h ${minutes % 60} min`;
};
