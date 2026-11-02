import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { CopyButton } from "./copy-button";

/**
 * `.codebox`: a machine value to read or copy (a public key, a command). `copy` adds a
 * `CopyButton`, which announces whether the copy happened.
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
        <CopyButton text={copy} {...(label === undefined ? {} : { label })} />
      )}
    </div>
  );
}
