import { useQueryClient } from "@tanstack/react-query";
import { CatchBoundary, type ErrorComponentProps } from "@tanstack/react-router";
import { Suspense } from "react";

import type { FitsNames } from "#/lib/how-mend-fits";
import type { FitsScreen as Screen } from "#/lib/how-mend-fits-screen";
import { reportCaught } from "#/lib/telemetry";

import { QueryError } from "./route-screens.tsx";
import { lazyBody, ViewLoadError } from "./workspace/lazy-body.tsx";

/**
 * One screen of How Mend fits together, fetched when it first shows. Its pictures draw the
 * sidebar, a session's tiles and the phone inbox, so their code stays out of what the app's first
 * page loads (every route's file loads there, and the step's route and the signed-in layout would
 * otherwise list it all). A fetch that fails says so, with Try again.
 */
const screens = lazyBody("How Mend fits together", () =>
  import("./how-mend-fits.tsx").then((module) => module.FitsScreenBody),
);

export function FitsScreenView({
  screen,
  names,
  phone,
  place,
}: {
  readonly screen: Screen;
  readonly names: FitsNames;
  readonly phone: boolean;
  readonly place: "step" | "dialog";
}) {
  return (
    <CatchBoundary getResetKey={() => screen} errorComponent={ScreenFailed} onCatch={reportCaught}>
      <Suspense
        fallback={
          <p role="status" className="text-row text-muted-foreground">
            Loading the pictures…
          </p>
        }
      >
        <screens.Body screen={screen} names={names} phone={phone} place={place} />
      </Suspense>
    </CatchBoundary>
  );
}

function ScreenFailed({ error, reset }: ErrorComponentProps) {
  const queryClient = useQueryClient();
  return (
    <QueryError
      error={error}
      retrying={false}
      retry={() => {
        if (error instanceof ViewLoadError) error.retry();
        void queryClient.resetQueries({ predicate: (query) => query.state.status === "error" });
        reset();
      }}
    />
  );
}
