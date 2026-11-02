import { cn } from "@mend/ui/lib/utils";
import { createLink } from "@tanstack/react-router";
import { forwardRef, type AnchorHTMLAttributes, type ReactNode } from "react";

import { focusRing } from "./button";

/**
 * `.vtabs`: a vertical list of links, such as a skill's files. Each entry is a link with its own
 * URL, so the list is navigation: the current one carries `aria-current="page"` (pass
 * `activeOptions` and `search` so only the shown entry matches).
 *
 * ```tsx
 * <VerticalTabs label="Files">
 *   {files.map((file) => <VerticalTabLink key={file.path} to="." search={{ file: file.path }} …>{file.path}</VerticalTabLink>)}
 * </VerticalTabs>
 * ```
 */
export function VerticalTabs({
  label,
  children,
  className,
}: {
  readonly label: string;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <nav aria-label={label} className={cn("flex min-w-0 flex-col gap-0.5", className)}>
      {children}
    </nav>
  );
}

/** The `.vtabs a` look, for a link or a button that sits in the list. */
export const verticalTabClass =
  "block min-w-0 truncate rounded-[10px] px-2.5 py-[7px] text-left font-sans text-[13px] leading-[1.3] font-medium text-ink-2 no-underline transition-colors hover:text-foreground aria-[current=page]:bg-panel aria-[current=page]:text-foreground aria-[current=page]:shadow-xs";

const VerticalTabAnchor = forwardRef<HTMLAnchorElement, AnchorHTMLAttributes<HTMLAnchorElement>>(
  function VerticalTabAnchor({ className, ...props }, ref) {
    return <a ref={ref} className={cn(verticalTabClass, focusRing, className)} {...props} />;
  },
);

/** One entry: a typed router link. */
export const VerticalTabLink = createLink(VerticalTabAnchor);
