import type { ReactElement } from "react";

/** Explain incomplete project history without exposing sessions that cannot be resumed or handed off. */
export function HiddenEndedSessionsNotice({
  count,
}: {
  readonly count: number;
}): ReactElement | null {
  if (count === 0) return null;

  return (
    <p className="mb-4 border-l-2 border-[var(--sw-amber)] px-3 py-1.5 text-[13px] leading-relaxed text-warning">
      {count} ended session{count === 1 ? "" : "s"} hidden because Mend did not capture a
      transcript.
    </p>
  );
}
