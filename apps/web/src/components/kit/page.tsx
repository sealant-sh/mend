import { cn } from "@mend/ui/lib/utils";
import type { ReactNode } from "react";

import { Eyebrow } from "./button";

/**
 * `.page`: the scrolling content column of a rail page (Projects, a project, Skills, Settings).
 * Render it as the `AppShell`'s child with `layout="bare"`.
 */
export function Page({
  children,
  className,
}: {
  readonly children: ReactNode;
  readonly className?: string;
}) {
  return (
    <main className={cn("min-w-0 flex-1 overflow-y-auto px-11 pt-8 pb-9", className)}>
      {children}
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
    <header className={cn("mb-5 flex items-end gap-6", className)}>
      <div className="min-w-0">
        <Eyebrow>{eyebrow}</Eyebrow>
        <h1 className="mt-1.5 truncate font-display text-[32px] leading-[1.1] font-semibold tracking-[-0.02em]">
          {title}
        </h1>
        {description === undefined ? null : (
          <div className="mt-1.5 text-[13.5px] text-muted-foreground">{description}</div>
        )}
      </div>
      {actions === undefined ? null : (
        <div className="ml-auto flex shrink-0 items-center gap-2">{actions}</div>
      )}
    </header>
  );
}
