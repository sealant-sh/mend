import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { Eyebrow } from "./button";

/**
 * `.page`: the scrolling content column of a rail page (Projects, a project, Skills, Settings).
 * Render it as the `AppShell`'s child with `layout="bare"`. Its content stops at the page width
 * and sits centred, so a wide screen gets margins on both sides while the scrollbar stays at the
 * window's edge. On a phone it scrolls inside the shell's column, above the bar, with narrower
 * margins.
 */
export function Page({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <main
      className={cn(
        "min-w-0 flex-1 overflow-y-auto px-11 pt-8 pb-9 max-md:min-h-0 max-md:px-4 max-md:pt-5 max-md:pb-6",
        className,
      )}
    >
      <div className="mx-auto w-full max-w-page min-w-0">{children}</div>
    </main>
  );
}

/**
 * `.ph`: the page header. An eyebrow, the Space Grotesk title, one line under it, and the page's
 * actions on the right (DESIGN.md §5).
 *
 * ```tsx
 * <PageHeader eyebrow="project" title="mend" description={<span className="font-mono text-[12px]">github.com/sealant-sh/mend · main</span>}
 *   actions={<Button>Open a shell</Button>} />
 * ```
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
  className,
}: {
  readonly eyebrow: string;
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-5 flex items-end gap-6 max-md:flex-wrap max-md:items-start max-md:gap-3",
        className,
      )}
    >
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1.5 truncate font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.02em] max-md:text-[24px]">
          {title}
        </h1>
        {description === undefined ? null : (
          <div className="mt-1.5 text-[13.5px] text-muted-foreground">{description}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="ml-auto flex shrink-0 items-center gap-2 max-md:ml-0 max-md:shrink max-md:flex-wrap">
          {actions}
        </div>
      )}
    </header>
  );
}
