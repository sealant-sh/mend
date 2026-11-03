import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

/**
 * `.page`: the scrolling content column of a rail page (Projects, a project, Skills, Settings).
 * Render it as the `AppShell`'s child with `layout="bare"`. Its content stops at the page width
 * and sits centred, so a wide screen gets margins on both sides while the scrollbar stays at the
 * window's edge. A `head` (the page header and its tab line) stays put while the content below it
 * scrolls; on a phone the whole page scrolls inside the shell's column, above the bar, with
 * narrower margins.
 */
export function Page({
  head,
  children,
  className,
}: {
  readonly head?: ReactNode;
  readonly children: ReactNode;
  readonly className?: string;
}) {
  if (head === undefined)
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
  return (
    <main className="flex h-dvh min-h-0 min-w-0 flex-1 flex-col max-md:h-auto max-md:overflow-y-auto">
      <div className={cn("shrink-0 px-11 pt-3.5 max-md:px-4 max-md:pt-2", className)}>
        <div className="mx-auto w-full max-w-page min-w-0">{head}</div>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-11 pb-9 max-md:flex-none max-md:overflow-visible max-md:px-4 max-md:pb-6">
        <div className="mx-auto w-full max-w-page min-w-0">{children}</div>
      </div>
    </main>
  );
}

/**
 * `.ph`: the page header, one compact row like a session's: the Space Grotesk title, its details
 * beside it, and the page's actions on the right. The details give way first when the row is
 * narrow; on a phone they take a line of their own.
 *
 * ```tsx
 * <PageHeader title="mend" description={<span className="font-mono text-[12px]">github.com/sealant-sh/mend · main</span>}
 *   actions={<Button>Open a shell</Button>} />
 * ```
 */
export function PageHeader({
  title,
  description,
  actions,
  className,
}: {
  readonly title: ReactNode;
  readonly description?: ReactNode;
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      className={cn(
        "mb-3 flex min-h-9 min-w-0 items-center gap-x-3 gap-y-1 max-md:flex-wrap",
        className,
      )}
    >
      <h1 className="min-w-0 truncate font-display text-[18px] leading-tight font-semibold tracking-[-0.02em]">
        {title}
      </h1>
      {description === undefined ? null : (
        <div className="min-w-0 flex-[1_1_0] truncate text-[13px] text-muted-foreground max-md:basis-full">
          {description}
        </div>
      )}
      {actions === undefined ? null : (
        <div className="ml-auto flex shrink-0 items-center gap-2 max-md:ml-0 max-md:shrink max-md:flex-wrap">
          {actions}
        </div>
      )}
    </header>
  );
}
