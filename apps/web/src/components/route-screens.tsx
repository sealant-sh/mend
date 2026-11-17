import { type ErrorComponentProps, useRouter } from "@tanstack/react-router";
import type { ReactNode } from "react";

/**
 * The router's default screens (pending, error, not found) and the default pending and error
 * states of a query (`QueryView`). Each says what happened and gives a way out.
 */

/** What went wrong, in the words the API or the browser gave. */
const messageOf = (error: unknown): string =>
  error instanceof Error && error.message !== "" ? error.message : "Something went wrong.";

/** The sheet a whole-page state sits on, centred on the desk. */
function Sheet({ children }: { readonly children: ReactNode }) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-4">
      <div className="w-full max-w-md bg-background px-6 py-10 text-center">{children}</div>
    </main>
  );
}

export function PendingScreen() {
  return (
    <Sheet>
      <p role="status" className="text-sm text-muted-foreground">
        Loading…
      </p>
    </Sheet>
  );
}

export function RouteErrorScreen({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  const retry = () => {
    reset();
    void router.invalidate();
  };
  return (
    <Sheet>
      <h1 className="text-base font-medium text-foreground">This page didn't load</h1>
      <p className="mt-2 text-sm break-words text-muted-foreground">{messageOf(error)}</p>
      <div className="mt-6 flex justify-center gap-2">
        <button type="button" onClick={retry}>
          Try again
        </button>
        <a href="/">Go home</a>
      </div>
    </Sheet>
  );
}

export function NotFoundScreen() {
  return (
    <Sheet>
      <h1 className="text-base font-medium text-foreground">Page not found</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        Nothing is at this address. Check the link, or start again from home.
      </p>
      <div className="mt-6 flex justify-center">
        <a href="/">Go home</a>
      </div>
    </Sheet>
  );
}

export function QueryPending() {
  return (
    <p role="status" className="text-sm text-muted-foreground">
      Loading…
    </p>
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
    <div role="alert">
      <p className="text-sm font-medium text-foreground">This didn't load</p>
      <p className="mt-1 text-sm break-words text-muted-foreground">{messageOf(error)}</p>
      <button type="button" onClick={retry} disabled={retrying}>
        {retrying ? "Trying again…" : "Try again"}
      </button>
    </div>
  );
}
