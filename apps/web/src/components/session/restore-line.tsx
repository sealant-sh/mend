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
import { Link } from "@tanstack/react-router";
import { useState } from "react";

import { type RestoreMark, restoreDetailWords, restoreLabel } from "#/lib/checkpoint-restores";

import { GoBackDialog } from "./go-back-dialog";

/**
 * The line where someone put the worktree's files back to a checkpoint (SLNT-1259): "Went back to
 * checkpoint 3". Its details say who did it and which checkpoint holds the files from before, and
 * offer going back to that one, which undoes it.
 */
export function RestoreLine({
  mark,
  sessionId,
  canGoBack,
}: {
  readonly mark: RestoreMark;
  readonly sessionId: string;
  /** The viewer may put this worktree's files back (the change's owner). */
  readonly canGoBack: boolean;
}) {
  const [details, setDetails] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const savedId = mark.saved.id;
  return (
    <>
      <ConversationMarker
        id={mark.key}
        className="scroll-mt-6"
        label={
          <Popover open={details} onOpenChange={setDetails}>
            <PopoverTrigger
              openOnHover
              delay={200}
              className="cursor-pointer rounded-sm outline-none hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11"
            >
              {restoreLabel(mark)}
            </PopoverTrigger>
            <PopoverContent side="top" className="w-80 gap-3">
              <PopoverHeader>
                <PopoverTitle>{restoreLabel(mark)}</PopoverTitle>
                <PopoverDescription className="whitespace-normal">
                  {restoreDetailWords(mark)}
                </PopoverDescription>
              </PopoverHeader>
              <p className="text-pretty whitespace-normal text-muted-foreground">
                The branch and its commits didn't change. Each agent in this worktree is told on its
                next message.
              </p>
              <div className="flex flex-wrap gap-2">
                {canGoBack && savedId !== null ? (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-lg:h-11"
                    onClick={() => {
                      setDetails(false);
                      setUndoing(true);
                    }}
                  >
                    Go back to checkpoint {mark.saved.ordinal}…
                  </Button>
                ) : null}
                <Link
                  to="/sessions/$sessionId/$view"
                  params={{ sessionId, view: "record" }}
                  hash={`checkpoint-${mark.saved.ordinal}`}
                  className={cn(buttonVariants({ variant: "outline", size: "sm" }), "max-lg:h-11")}
                >
                  Open in Record
                </Link>
              </div>
            </PopoverContent>
          </Popover>
        }
      />
      {savedId === null ? null : (
        <GoBackDialog
          key={undoing ? "open" : "closed"}
          sessionId={sessionId}
          choices={[
            {
              id: savedId,
              ordinal: mark.saved.ordinal,
              words: "Saved before going back",
              createdAt: mark.at,
            },
          ]}
          initial={savedId}
          open={undoing}
          onOpenChange={setUndoing}
        />
      )}
    </>
  );
}
