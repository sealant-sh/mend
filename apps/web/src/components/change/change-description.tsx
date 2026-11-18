import { InlineAlert } from "@mend/ui/components/banner";
import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import { type UseQueryResult, useMutation, useQueryClient } from "@tanstack/react-query";
import { HistoryIcon, RouteIcon } from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";

import type { ChangePassDto, ChangeTourDto, ReviewDiffDto } from "#/lib/api";
import { composeTour } from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import {
  descriptionState,
  narrationParts,
  paragraphs,
  passFailureWords,
  tourDigestTexts,
  tourPass,
} from "#/lib/tour";
import { useTRPC } from "#/lib/trpc";

/** sha256 of `text` as hex. */
const sha256 = async (text: string): Promise<string> => {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
};

/** Whether one of `texts` hashes to `digest`; null where the browser has no digest (http). */
const hashesTo = async (texts: ReadonlyArray<string>, digest: string): Promise<boolean | null> => {
  if (globalThis.crypto?.subtle === undefined) return null;
  for (const text of texts) if ((await sha256(text)) === digest) return true;
  return false;
};

/**
 * Whether the tour was written from the change as this review shows it: true or false once known,
 * null while the browser works it out or can't. The review's own digest settles most changes at
 * once; the rest are hashed in the browser (`tourDigestTexts` says why).
 */
export const useTourCurrent = (
  tour: ChangeTourDto | null,
  review: ReviewDiffDto,
): boolean | null => {
  const quick = tour === null || tour.diffDigest === review.slice.diffDigest;
  const asked = tour === null ? "" : `${tour.diffDigest}:${review.slice.diffDigest}`;
  const [hashed, setHashed] = useState<{
    readonly asked: string;
    readonly current: boolean | null;
  }>({ asked: "", current: null });
  // Hashing is the browser's, and asynchronous: its answer lands after the render that asked.
  useEffect(() => {
    if (quick || tour === null) return;
    let live = true;
    const check = async () => {
      const current = await hashesTo(tourDigestTexts(review.patch), tour.diffDigest);
      if (live) setHashed({ asked, current });
    };
    void check();
    return () => {
      live = false;
    };
  }, [quick, tour, review.patch, asked]);
  if (quick) return true;
  return hashed.asked === asked ? hashed.current : null;
};

/** The block's frame: the heading, an optional muted fact beside it, and what goes under it. */
function Block({ fact, children }: { readonly fact?: ReactNode; readonly children: ReactNode }) {
  const heading = useId();
  return (
    <section
      aria-labelledby={heading}
      className="grid gap-2.5 border-b px-8 pt-6 pb-5 @max-3xl/change:px-4 @max-3xl/change:pt-4"
    >
      <h2
        id="change-description"
        className="flex flex-wrap items-baseline gap-x-2.5 text-lead font-semibold"
      >
        Description
        {fact === undefined ? null : (
          <span className="text-meta font-normal text-muted-foreground">{fact}</span>
        )}
      </h2>
      {children}
    </section>
  );
}

/** Ask Mend to write the description and tour again; the pass list says how it goes. */
const useWrite = (changeId: string) => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => composeTour(changeId),
    onSettled: () => queryClient.invalidateQueries(trpc.changes.passes.pathFilter()),
  });
};

/** A button that queues the pass, with its failure under it. */
function WriteButton({
  changeId,
  label,
  touch,
  className,
}: {
  readonly changeId: string;
  readonly label: string;
  readonly touch: boolean;
  readonly className?: string;
}) {
  const write = useWrite(changeId);
  return (
    <>
      <Button
        variant="outline"
        size={touch ? "touch" : "default"}
        disabled={write.isPending}
        onClick={() => write.mutate()}
        className={cn("w-fit", className)}
      >
        {label}
      </Button>
      {write.isError ? (
        <InlineAlert size={touch ? "touch" : "default"} className="basis-full">
          {failureWords(write.error, "Mend couldn't ask for the description. Try again.")}
        </InlineAlert>
      ) : null}
    </>
  );
}

/** Words with `code` in them, the code in mono: "Run `mend connect claude`…". */
export const withCode = (words: string): ReactNode =>
  narrationParts(words).map((part) =>
    part.code ? <code key={part.start}>{part.text}</code> : part.text,
  );

/**
 * Mend's description of the change (Doop page 4, "Change · first look"), above the diffs on the
 * whole change: what the change is, how the session got there, and the tour's line with Start
 * tour. While Mend writes it, when there is none, when writing failed, and when the change has
 * moved since, the block says so with its action. Open on a first look; folded with Show more on
 * a later look, in a narrow tile and on a phone.
 */
export function ChangeDescription({
  changeId,
  review,
  tour,
  passes,
  current,
  folded: foldedAtFirst,
  touch,
  touring,
  onStartTour,
}: {
  readonly changeId: string;
  readonly review: ReviewDiffDto;
  readonly tour: UseQueryResult<ChangeTourDto | null, unknown>;
  readonly passes: UseQueryResult<ReadonlyArray<ChangePassDto>, unknown>;
  /** Whether the tour was written from this change; null while unknown. */
  readonly current: boolean | null;
  readonly folded: boolean;
  readonly touch: boolean;
  readonly touring: boolean;
  readonly onStartTour: () => void;
}) {
  const [unfolded, setUnfolded] = useState(false);

  if (tour.isPending || passes.isPending)
    return (
      <Block>
        <p role="status" className="text-row text-muted-foreground">
          Reading Mend's description…
        </p>
      </Block>
    );
  if (tour.isError || passes.isError)
    return (
      <Block>
        <InlineAlert
          size={touch ? "touch" : "default"}
          title="Mend's description didn't load."
          actions={
            <Button
              variant="outline"
              size={touch ? "touch" : "sm"}
              disabled={tour.isFetching || passes.isFetching}
              onClick={() => {
                if (tour.isError) void tour.refetch();
                if (passes.isError) void passes.refetch();
              }}
            >
              Try again
            </Button>
          }
        >
          {failureWords(tour.error ?? passes.error, "Try again.")}
        </InlineAlert>
      </Block>
    );

  const state = descriptionState(tour.data, tourPass(passes.data));
  const at = review.checkpointB.ordinal;
  switch (state.kind) {
    case "writing":
      return (
        <Block>
          <p role="status" className="text-row text-muted-foreground">
            Mend is writing the description and tour.
          </p>
        </Block>
      );
    case "none":
      return (
        <Block>
          <p className="text-row text-muted-foreground">No description yet.</p>
          <WriteButton changeId={changeId} label="Write description and tour" touch={touch} />
        </Block>
      );
    case "failed":
      return (
        <Block>
          <InlineAlert
            size={touch ? "touch" : "default"}
            title="Mend couldn't write the description."
            actions={<WriteButton changeId={changeId} label="Try again" touch={touch} />}
          >
            {withCode(passFailureWords(state.detail))}
          </InlineAlert>
        </Block>
      );
    case "ready": {
      const written = state.tour;
      const stale = current === false;
      const folded = foldedAtFirst && !unfolded;
      const stops = written.stops.length;
      return (
        <Block fact={stale ? undefined : `Mend wrote this from checkpoint ${at}`}>
          {stale ? (
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2.5">
              <p className="flex min-w-0 items-start gap-2 text-row text-muted-foreground @max-3xl/change:basis-full">
                <HistoryIcon aria-hidden className="mt-0.5 size-4 shrink-0" />
                Mend wrote this from an earlier checkpoint. The change is now at checkpoint {at}.
              </p>
              <WriteButton
                changeId={changeId}
                label="Write again"
                touch={touch}
                className="@max-3xl/change:w-full"
              />
            </div>
          ) : null}
          <div className={cn("text-prose", folded ? "line-clamp-3" : "grid gap-2.5")}>
            {paragraphs(written.summary).map((paragraph) => (
              <p key={paragraph} className={folded ? "inline" : undefined}>
                {paragraph}
                {folded ? " " : null}
              </p>
            ))}
          </div>
          {folded ? (
            <Button
              variant="link"
              size={touch ? "touch" : "default"}
              className="w-fit"
              onClick={() => setUnfolded(true)}
            >
              Show more
            </Button>
          ) : written.approach === null ? null : (
            <div className="mt-1.5 grid gap-0.5">
              <h3 className="text-row font-semibold">How the session got there</h3>
              <p className="text-row text-pretty text-muted-foreground">{written.approach}</p>
            </div>
          )}
          {touring || stops === 0 ? null : (
            <div className="mt-1.5 flex items-center gap-2.5">
              <RouteIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
              <p className="min-w-0 text-row max-lg:flex-1">
                <span className="font-semibold">Tour</span>
                <span className="text-muted-foreground">
                  {" · "}
                  {stops === 1 ? "1 stop" : `${stops} stops`}
                  {stale ? ", from an earlier checkpoint" : ""}
                </span>
              </p>
              <Button variant="outline" size={touch ? "touch" : "default"} onClick={onStartTour}>
                Start tour
              </Button>
            </div>
          )}
        </Block>
      );
    }
  }
}
