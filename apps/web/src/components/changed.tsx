import { cn } from "@mend/ui/lib/utils";
import { type ReactNode, useRef } from "react";

/**
 * A glyph or word that changes in place (frame "Session states · moving between groups", step 1):
 * once its value differs from the one it first showed, each new value fades and settles in over
 * 160 ms. What a row first shows doesn't move. Reduced motion skips it.
 */
export function Changed({
  value,
  children,
  className,
}: {
  /** What identifies the shown state: the glyph's shape, the word. */
  readonly value: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  const first = useRef(value);
  return (
    <span
      key={value}
      className={cn(
        "inline-flex",
        first.current !== value && "motion-safe:animate-glyph-change",
        className,
      )}
    >
      {children}
    </span>
  );
}
