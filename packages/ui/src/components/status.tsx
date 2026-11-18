import { cn } from "@mend/ui/lib/utils";
import * as React from "react";

/**
 * What state something is in, as one sentence-case word: Running, Waiting on you, Completed,
 * Failed, Stopped. A word, not a badge: muted, except waiting (amber, the one loud state) and bad
 * (red). Sessions, services and resources use the same words.
 */
type StatusTone = "run" | "wait" | "ok" | "bad" | "idle";

function Status({
  tone = "run",
  className,
  ...props
}: React.ComponentProps<"span"> & { tone?: StatusTone }) {
  return (
    <span
      data-slot="status"
      data-tone={tone}
      className={cn(
        "inline-flex items-center gap-1.5 text-xs whitespace-nowrap text-muted-foreground data-[tone=bad]:text-destructive data-[tone=wait]:text-warning",
        className,
      )}
      {...props}
    />
  );
}

export { Status, type StatusTone };
