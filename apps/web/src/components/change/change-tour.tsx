import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { Link } from "@tanstack/react-router";
import { useId } from "react";

import type { ChangeTourDto } from "#/lib/api";
import { type StopPlace, stopPlaceWords } from "#/lib/tour";

import { withCode } from "./change-description.tsx";
import { TourStop } from "./tour-stop.tsx";

/** What moves the tour: to a stop, and out of it. */
export interface TourMoves {
  readonly go: (index: number) => void;
  readonly end: () => void;
}

/**
 * The note of the stop the tour is on, at its place in the diffs. A stop the session backs links
 * each of its claims into the session's conversation; one it doesn't says it is Mend's reading.
 * The record has no view of its own yet, so a link opens the session's conversation tab.
 */
export function TourNote({
  tour,
  index,
  place,
  touch,
  moves,
}: {
  readonly tour: ChangeTourDto;
  readonly index: number;
  readonly place: StopPlace;
  readonly touch: boolean;
  readonly moves: TourMoves;
}) {
  const stop = tour.stops[index];
  if (stop === undefined) return null;
  const count = tour.stops.length;
  const last = index === count - 1;
  const sessionId = tour.sessionId;
  const size = touch ? "touch" : "default";
  return (
    <TourStop
      data-tour-note
      kind={stop.grounded ? "session" : "reading"}
      place={place.kind}
      size={size}
      step={`Tour · ${index + 1} of ${count}`}
      title={stop.title}
      onEnd={moves.end}
      links={stop.evidence.map((link) =>
        sessionId === null ? (
          // The session that wrote the record is gone: the claim stays, with nowhere to open.
          <span key={String(link.sequence)} className="text-row">
            {link.excerpt}
          </span>
        ) : (
          <Button
            key={String(link.sequence)}
            variant="link"
            className={cn("text-left text-row whitespace-normal", touch && "text-lead")}
            render={<Link to="/sessions/$sessionId" params={{ sessionId }} />}
          >
            {link.excerpt}
          </Button>
        ),
      )}
      actions={
        <>
          <Button
            variant="outline"
            size={size}
            disabled={index === 0}
            onClick={() => moves.go(index - 1)}
          >
            Previous
          </Button>
          <Button size={size} onClick={() => (last ? moves.end() : moves.go(index + 1))}>
            {last ? "Finish tour" : "Next"}
          </Button>
        </>
      }
    >
      {withCode(stop.narration)}
    </TourStop>
  );
}

/**
 * The tour's stops above the file list while the tour is on: numbered, each with its title and
 * its place in mono, the current one highlighted. Picking one goes to it.
 */
export function TourRail({
  tour,
  index,
  moves,
}: {
  readonly tour: ChangeTourDto;
  readonly index: number;
  readonly moves: TourMoves;
}) {
  const heading = useId();
  return (
    <section aria-labelledby={heading} className="grid gap-2 border-b px-3 py-4">
      <h3
        id="tour-rail"
        className="flex items-baseline justify-between gap-3 px-2 text-row font-semibold"
      >
        Tour
        <span className="text-meta font-normal text-muted-foreground">
          {index + 1} of {tour.stops.length}
        </span>
      </h3>
      <ol className="grid gap-0.5">
        {tour.stops.map((stop, at) => {
          const here = at === index;
          return (
            <li key={`${stop.title}:${stopPlaceWords(stop)}`}>
              <button
                type="button"
                aria-current={here ? "step" : undefined}
                onClick={() => moves.go(at)}
                className={cn(
                  "grid w-full grid-cols-[auto_1fr] gap-x-2.5 rounded-chip px-2 py-1.5 text-left outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50",
                  here && "bg-muted hover:bg-muted",
                )}
              >
                <span
                  aria-hidden
                  className={cn(
                    "mt-0.5 flex size-4.5 items-center justify-center rounded-full border text-2xs",
                    here
                      ? "border-primary bg-primary text-primary-foreground"
                      : "text-muted-foreground",
                  )}
                >
                  {at + 1}
                </span>
                <span className="min-w-0 text-row">{stop.title}</span>
                <span
                  className={cn(
                    "col-start-2 truncate text-meta text-muted-foreground",
                    stop.file !== null && "font-mono",
                  )}
                >
                  {stopPlaceWords(stop)}
                </span>
              </button>
            </li>
          );
        })}
      </ol>
    </section>
  );
}
