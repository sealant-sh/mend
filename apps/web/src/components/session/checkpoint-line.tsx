import { ConversationMarker } from "@mend/ui/components/conversation-marker";
import { Button, buttonVariants } from "@mend/ui/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverHeader,
  PopoverTitle,
  PopoverTrigger,
} from "@mend/ui/components/ui/popover";
import { cn } from "@mend/ui/lib/utils";
import { Link, useNavigate } from "@tanstack/react-router";
import { useState } from "react";

import { setReviewRange } from "#/lib/review-open";
import {
  type CheckpointMark,
  checkpointLabel,
  filesChangedWords,
  pathsShown,
  unconfirmedWords,
} from "#/lib/turn-checkpoints";

import { GoBackDialog } from "./go-back-dialog";

/**
 * The line after a turn that changed files (SLNT-1200): "Checkpoint · 3 files changed", and
 * "Show changes" beside it on a wide screen. Hovering the label, or pressing or tapping it, opens
 * what it is: what Mend saved and when, which files changed, and what the person can do with it.
 * The app lets them read the turn's changes in the Change tab (and comment there), find the
 * checkpoint in the Record, and go back to it (SLNT-1259), which only the change's owner sees.
 */
export function CheckpointLine({
  mark,
  sessionId,
  changeId,
  shared,
  canGoBack,
}: {
  readonly mark: CheckpointMark;
  readonly sessionId: string;
  /** The worktree's change; null when it has none to show yet. */
  readonly changeId: string | null;
  /** Other sessions took checkpoints in this worktree: the turn's files can include theirs. */
  readonly shared: boolean;
  /** The viewer may put this worktree's files back (the change's owner). */
  readonly canGoBack: boolean;
}) {
  const navigate = useNavigate();
  const [details, setDetails] = useState(false);
  const [goingBack, setGoingBack] = useState(false);
  const showChanges =
    changeId === null
      ? null
      : () => {
          setReviewRange(changeId, { from: mark.fromId ?? "base", to: mark.toId });
          void navigate({
            to: "/sessions/$sessionId/$view",
            params: { sessionId, view: "change" },
          });
        };
  const changed = filesChangedWords(mark.files);
  const listed = mark.files === null || changed === null ? null : pathsShown(mark.files);
  const doubt = unconfirmedWords(mark.unconfirmed);
  return (
    <>
      <ConversationMarker
        id={`checkpoint-${mark.ordinal}`}
        className="scroll-mt-6"
        label={
          <span className="flex items-center gap-2">
            <Popover open={details} onOpenChange={setDetails}>
              <PopoverTrigger
                openOnHover
                delay={200}
                className="cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11"
              >
                {checkpointLabel(mark)}
              </PopoverTrigger>
              <PopoverContent side="top" className="w-80 gap-3">
                <PopoverHeader>
                  <PopoverTitle className="flex items-center gap-2">
                    Checkpoint {mark.ordinal}
                    <code className="font-mono text-2xs font-normal text-muted-foreground">
                      {mark.sha}
                    </code>
                  </PopoverTitle>
                  <PopoverDescription className="whitespace-normal">
                    When this turn ended, Mend saved a copy of the files in this worktree. Your
                    branch doesn't change.
                  </PopoverDescription>
                </PopoverHeader>
                <div className="flex flex-col gap-1 whitespace-normal">
                  <p>
                    {changed === null
                      ? "Mend couldn't read which files changed during this turn."
                      : `${changed} during this turn.`}
                  </p>
                  {listed === null ? null : (
                    <ul className="flex flex-col gap-0.5 text-muted-foreground">
                      {listed.paths.map((path) => (
                        <li key={path} className="truncate font-mono text-2xs">
                          {path}
                        </li>
                      ))}
                      {listed.rest === null ? null : <li className="text-meta">{listed.rest}</li>}
                    </ul>
                  )}
                  {shared ? (
                    <p className="text-muted-foreground">
                      Other sessions work in this worktree too, so this can include their changes.
                    </p>
                  ) : null}
                  {doubt === null ? null : <p className="text-muted-foreground">{doubt}</p>}
                </div>
                <p className="text-pretty whitespace-normal text-muted-foreground">
                  Show changes opens what this turn changed in the Change tab, where you can comment
                  on it. The Record lists every checkpoint, including the ones where nothing
                  changed.
                  {canGoBack
                    ? " Go back puts the files in this worktree back to how they were here."
                    : null}
                </p>
                <div className="flex flex-wrap gap-2">
                  {showChanges === null ? null : (
                    <Button type="button" size="sm" className="max-lg:h-11" onClick={showChanges}>
                      Show changes
                    </Button>
                  )}
                  <Link
                    to="/sessions/$sessionId/$view"
                    params={{ sessionId, view: "record" }}
                    hash={`checkpoint-${mark.ordinal}`}
                    className={cn(
                      buttonVariants({ variant: "outline", size: "sm" }),
                      "max-lg:h-11",
                    )}
                  >
                    Open in Record
                  </Link>
                  {canGoBack ? (
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      className="max-lg:h-11"
                      onClick={() => {
                        setDetails(false);
                        setGoingBack(true);
                      }}
                    >
                      Go back to this checkpoint…
                    </Button>
                  ) : null}
                </div>
              </PopoverContent>
            </Popover>
            {showChanges === null ? null : (
              <span className="flex items-center gap-2 max-lg:hidden">
                <span aria-hidden="true">·</span>
                <button
                  type="button"
                  onClick={showChanges}
                  className="cursor-pointer rounded-sm font-medium text-info outline-none hover:underline focus-visible:ring-3 focus-visible:ring-ring/50"
                >
                  Show changes
                </button>
              </span>
            )}
          </span>
        }
      />
      {canGoBack ? (
        <GoBackDialog
          key={goingBack ? "open" : "closed"}
          sessionId={sessionId}
          choices={[
            { id: mark.toId, ordinal: mark.ordinal, words: "Turn ended", createdAt: mark.at },
          ]}
          initial={mark.toId}
          open={goingBack}
          onOpenChange={setGoingBack}
        />
      ) : null}
    </>
  );
}
