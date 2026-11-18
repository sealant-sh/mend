import { buttonVariants } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { Link, type LinkProps } from "@tanstack/react-router";
import { ChevronLeftIcon } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The top of a pushed screen under 1024px (Doop "Phone header", kind=pushed): a 44px back control,
 * the title with a muted line under it, and the screen's own 44px buttons on the right. The space
 * on the right is kept even when there are none, so the title stays centred.
 *
 * Still to come on a session: the "…" with the session's actions (PR 13), in `actions`.
 */
export function PhoneHeader({
  title,
  sub,
  back,
  actions,
  className,
}: {
  readonly title: string;
  readonly sub?: string;
  /** Where Back goes, and what it says to a screen reader. */
  readonly back: { readonly link: LinkProps; readonly label: string };
  readonly actions?: ReactNode;
  readonly className?: string;
}) {
  return (
    <header
      data-slot="phone-header"
      className={cn("flex h-14 shrink-0 items-center gap-1 border-b bg-background px-1", className)}
    >
      <Link
        {...back.link}
        aria-label={back.label}
        className={cn(buttonVariants({ variant: "ghost", size: "icon-touch" }), "shrink-0")}
      >
        <ChevronLeftIcon aria-hidden className="size-5.5" />
      </Link>
      <div className="min-w-0 flex-1 text-center">
        <h1 className="truncate text-title font-semibold">{title}</h1>
        {sub === undefined || sub === "" ? null : (
          <p className="truncate text-2xs text-muted-foreground">{sub}</p>
        )}
      </div>
      <div className="flex min-w-11 shrink-0 items-center justify-end">{actions}</div>
    </header>
  );
}
