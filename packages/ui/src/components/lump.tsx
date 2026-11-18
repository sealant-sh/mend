import { cn } from "@mend/ui/lib/utils";
import * as React from "react";

/** The session's state, drawn as the lump's shape. */
type LumpStatus = "run" | "wait" | "done" | "fail" | "stop" | "idle";
/** The session's pull request, drawn as the lump's colour. */
type LumpPr = "none" | "open" | "merged" | "conflict";

// One path per status, on a 16px grid, as the canvas draws them.
const paths: Record<LumpStatus, { d: string; evenOdd?: boolean }> = {
  run: { d: "M2.5 13.5V9.2a2.75 2.75 0 0 1 5.5 0a2.75 2.75 0 0 1 5.5 0V13.5Z" },
  wait: {
    d: "M2.5 13.5V10.2C2.5 8.2 5.6 5.2 7.1 3.1a1.1 1.1 0 0 1 1.8 0C10.4 5.2 13.5 8.2 13.5 10.2V13.5Z",
  },
  done: {
    d: "M2.5 13.5V8.5a5.5 5.5 0 0 1 11 0V13.5ZM4.61 9.92L7.23 12.4L11.52 7.89L10.28 6.72L7.17 10L5.79 8.68Z",
    evenOdd: true,
  },
  idle: { d: "M2.5 13.5V8.5a5.5 5.5 0 0 1 11 0V13.5Z" },
  fail: { d: "M2.5 13.5V6.2a2.2 2.2 0 0 1 3.3-1.9L12.2 8.4a2.6 2.6 0 0 1 1.3 2.3V13.5Z" },
  stop: { d: "M1.5 13.5C1.5 10.8 3 9.3 5.2 9.3H10.8C13 9.3 14.5 10.8 14.5 13.5Z" },
};

/**
 * The session glyph in tile tabs and the sidebar rail. Its shape is the session's status and its
 * colour the pull request's state, except that a session waiting on you is always amber.
 *
 * It is decorative beside a title. Give it a `label` ("Waiting on you, pull request open") where
 * it stands alone, as in the rail, and screen readers read that instead.
 */
function Lump({
  status = "run",
  pr = "none",
  label,
  className,
  ...props
}: Omit<React.ComponentProps<"svg">, "children"> & {
  status?: LumpStatus;
  pr?: LumpPr;
  label?: string;
}) {
  const path = paths[status];
  return (
    <svg
      data-slot="lump"
      data-status={status}
      data-pr={pr}
      viewBox="0 0 16 16"
      role={label === undefined ? undefined : "img"}
      aria-label={label}
      aria-hidden={label === undefined ? true : undefined}
      className={cn(
        "size-3.5 shrink-0 overflow-visible text-pr-none data-[pr=conflict]:text-pr-conflict data-[pr=merged]:text-pr-merged data-[pr=open]:text-pr-open data-[status=wait]:text-warning",
        className,
      )}
      {...props}
    >
      <path
        d={path.d}
        fill="currentColor"
        fillRule={path.evenOdd === true ? "evenodd" : undefined}
      />
    </svg>
  );
}

export { Lump, type LumpPr, type LumpStatus };
