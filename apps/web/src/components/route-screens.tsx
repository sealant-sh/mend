import { Alert, AlertAction, AlertDescription, AlertTitle } from "@mend/ui/components/ui/alert";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "@mend/ui/components/ui/empty";
import { Separator } from "@mend/ui/components/ui/separator";
import { Skeleton } from "@mend/ui/components/ui/skeleton";
import { cn } from "@mend/ui/lib/utils";
import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import { CircleX, SearchX } from "lucide-react";
import type { ReactNode } from "react";

/**
 * The router's default screens (pending, error, not found) and a query's default pending and error
 * states (`QueryView`). Each says what happened and gives a way out. A whole page sits as Sheet's
 * pages do (DESIGN.md): the desk, the sheet inset on it, and one centred 560px column.
 */

/** What went wrong, in the words the API or the browser gave. */
const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";

/** On a phone, a page's actions are 44px touch targets (DESIGN.md). */
const TOUCH = "max-md:h-11 max-md:px-4 max-md:text-lead";

/** Home, as a link that looks like a button: a full load, so a broken page leaves nothing behind. */
function GoHome({ variant }: { readonly variant: "default" | "outline" }) {
  return (
    <a href="/" className={cn(buttonVariants({ variant }), TOUCH)}>
      Go home
    </a>
  );
}

/** The desk with Mend's name on it, and the sheet a page sits on, holding one column. */
function SheetPage({ children }: { readonly children: ReactNode }) {
  return (
    <div className="flex min-h-dvh flex-col bg-canvas p-sheet-inset md:flex-row">
      <div className="px-3 pt-2 pb-3 text-lead font-semibold text-foreground md:w-sidebar md:shrink-0 md:px-3 md:pt-3">
        Mend
      </div>
      <main className="flex-1 rounded-xl border border-sheet-border bg-background shadow-sheet">
        <div className="mx-auto w-full max-w-140 px-5 pt-10 pb-10 md:pt-16">{children}</div>
      </main>
    </div>
  );
}

export function PendingScreen() {
  return (
    <SheetPage>
      <div role="status" className="flex flex-col gap-3">
        <span className="sr-only">Loading…</span>
        <Skeleton className="h-7 w-48" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-2/3" />
      </div>
    </SheetPage>
  );
}

export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const retry = () => {
    reset();
    void router.invalidate();
  };
  return (
    <SheetPage>
      <h1 className="text-2xl font-semibold tracking-tight text-foreground">
        This page didn't load
      </h1>
      <Alert tone="error" className="mt-6">
        <CircleX aria-hidden />
        <AlertTitle>{messageOf(error)}</AlertTitle>
      </Alert>
      <Separator className="my-8" />
      <div className="flex flex-wrap justify-end gap-2">
        <GoHome variant="outline" />
        <Button type="button" className={TOUCH} onClick={retry}>
          Try again
        </Button>
      </div>
    </SheetPage>
  );
}

export function NotFoundScreen() {
  return (
    <SheetPage>
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden />
          </EmptyMedia>
          <EmptyTitle>
            <h1>Page not found</h1>
          </EmptyTitle>
          <EmptyDescription>
            Nothing is at this address. Check the link, or start again from home.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <GoHome variant="default" />
        </EmptyContent>
      </Empty>
    </SheetPage>
  );
}

export function QueryPending() {
  return (
    <Empty kind="inline" role="status">
      Loading…
    </Empty>
  );
}

export function QueryError({
  error,
  retry,
  retrying,
}: {
  readonly error: unknown;
  readonly retry: () => void;
  readonly retrying: boolean;
}) {
  return (
    <Alert tone="error">
      <CircleX aria-hidden />
      <AlertTitle>This didn't load.</AlertTitle>
      <AlertDescription>{messageOf(error)}</AlertDescription>
      <AlertAction>
        <Button type="button" variant="outline" size="sm" onClick={retry} disabled={retrying}>
          {retrying ? "Trying again…" : "Try again"}
        </Button>
      </AlertAction>
    </Alert>
  );
}
