import { cn } from "@mend/ui/lib/utils";
import { useState, type ReactNode } from "react";

import { Button } from "./button";

/**
 * `.codebox`: a machine value to read or copy (a public key, a command). `copy` adds a Copy
 * button that says "Copied" for a moment, announced through a status region.
 */
export function CodeBox({
  children,
  copy,
  label,
  wrap = true,
  className,
}: {
  readonly children: ReactNode;
  /** The text the Copy button copies; no button without it. */
  readonly copy?: string;
  /** What the value is, for the Copy button's accessible name ("Copy Mend's public key"). */
  readonly label?: string;
  readonly wrap?: boolean;
  readonly className?: string;
}) {
  const [copied, setCopied] = useState(false);
  return (
    <div
      className={cn(
        "flex items-start gap-3 rounded-[10px] border border-input bg-panel px-3 py-2 font-mono text-[12.5px] leading-[1.8] text-ink-2",
        className,
      )}
    >
      <code className={cn("min-w-0 flex-1", wrap ? "break-all whitespace-normal" : "truncate")}>
        {children}
      </code>
      {copy === undefined ? null : (
        <Button
          size="sm"
          variant="ghost"
          aria-label={label === undefined ? "Copy" : `Copy ${label}`}
          onClick={() =>
            void navigator.clipboard.writeText(copy).then(() => {
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1500);
              return undefined;
            })
          }
        >
          {copied ? "Copied" : "Copy"}
        </Button>
      )}
      <span role="status" className="sr-only">
        {copied ? "Copied" : ""}
      </span>
    </div>
  );
}
