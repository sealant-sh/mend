import { CommandPaletteMatch } from "@mend/ui/components/command-palette";
import { Status } from "@mend/ui/components/status";
import { Button } from "@mend/ui/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@mend/ui/components/ui/dialog";
import { cn } from "@mend/ui/lib/utils";
import { CircleXIcon, SearchIcon } from "lucide-react";
import { useRef } from "react";

import { allHits, countWords, type SearchHit, sessionStatus } from "#/lib/search";

import {
  hitContext,
  hitIcon,
  hitName,
  NoResults,
  type SearchModel,
  SearchNotes,
} from "./search-parts.tsx";

/**
 * Search as its own screen under 1024px (frames "Phone · search · empty", "· results", "· no
 * results", with the "Phone search header"): the field with the keyboard up and Cancel, then the
 * same groups as the palette, each result on two lines. The keyboard's search key opens the first
 * result, which is shaded.
 */
export function PhoneSearch({
  model,
  organizationName,
  onClose,
}: {
  readonly model: SearchModel;
  readonly organizationName: string;
  readonly onClose: () => void;
}) {
  const { query, setQuery, results, notes, choose } = model;
  const field = useRef<HTMLInputElement>(null);
  const first = allHits(results)[0];
  const typed = query.trim() !== "";
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent
        showCloseButton={false}
        initialFocus={field}
        className="inset-0 top-0 left-0 flex h-dvh max-w-none translate-x-0 translate-y-0 flex-col gap-0 rounded-none bg-background p-0 text-lead text-foreground shadow-none ring-0 data-open:zoom-in-100 data-closed:zoom-out-100 data-[size=md]:sm:max-w-none"
      >
        <DialogTitle className="sr-only">Search</DialogTitle>
        <div className="flex h-14 shrink-0 items-center gap-2 border-b pr-1 pl-4">
          <div className="flex h-10 min-w-0 flex-1 items-center gap-2 rounded-pop bg-muted pl-3">
            <SearchIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
            <input
              ref={field}
              type="search"
              enterKeyHint="search"
              autoComplete="off"
              aria-label="Search"
              placeholder={`Search ${organizationName}`}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !typed || first === undefined) return;
                event.preventDefault();
                choose(first);
              }}
              className="h-full min-w-0 flex-1 bg-transparent caret-primary outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
            />
            {query === "" ? null : (
              <button
                type="button"
                aria-label="Clear"
                onClick={() => {
                  setQuery("");
                  field.current?.focus();
                }}
                className="grid size-10 shrink-0 place-items-center text-muted-foreground outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
              >
                <CircleXIcon aria-hidden className="size-4" />
              </button>
            )}
          </div>
          <Button
            type="button"
            variant="ghost"
            size="touch"
            onClick={onClose}
            className="px-3 text-lead font-medium text-primary hover:bg-transparent hover:text-primary/80"
          >
            Cancel
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain pb-[env(safe-area-inset-bottom)]">
          {results.count === 0 ? (
            <NoResults query={query} className="h-full justify-center px-10" />
          ) : (
            results.groups.map((group) => (
              <section key={group.heading} aria-label={group.heading} className="pt-3 pb-1">
                <h2 aria-hidden className="px-4 pb-1.5 text-meta font-medium text-muted-foreground">
                  {group.heading}
                </h2>
                <ul>
                  {group.hits.map((hit) => (
                    <li key={hit.key}>
                      <PhoneResult
                        hit={hit}
                        shaded={typed && hit.key === first?.key}
                        onChoose={() => choose(hit)}
                      />
                    </li>
                  ))}
                </ul>
              </section>
            ))
          )}
          <div className="px-2">
            <SearchNotes notes={notes} touch />
          </div>
        </div>
        <p aria-live="polite" className="sr-only">
          {results.count === null ? "" : countWords(results.count)}
        </p>
      </DialogContent>
    </Dialog>
  );
}

/** One result: its icon, its name with the typed letters bold, and a line under it. */
function PhoneResult({
  hit,
  shaded,
  onChoose,
}: {
  readonly hit: SearchHit;
  readonly shaded: boolean;
  readonly onChoose: () => void;
}) {
  const context = hitContext(hit);
  const status = hit.kind === "session" ? sessionStatus(hit.row) : undefined;
  const second = context !== undefined || status !== undefined;
  return (
    <button
      type="button"
      onClick={onChoose}
      className={cn(
        "flex w-full items-center gap-3.5 px-4 py-2 text-left outline-none focus-visible:bg-muted active:bg-muted",
        second ? "min-h-13" : "min-h-12",
        shaded && "bg-muted",
      )}
    >
      <span aria-hidden className="flex shrink-0 text-muted-foreground [&_svg]:size-5">
        {hitIcon(hit)}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate">
          <CommandPaletteMatch text={hitName(hit)} indices={hit.indices} />
        </span>
        {second ? (
          <span className="truncate text-meta text-muted-foreground">
            {context}
            {context !== undefined && status !== undefined ? " · " : ""}
            {status === undefined ? null : (
              <Status tone={status.tone} className="text-meta">
                {status.word}
              </Status>
            )}
          </span>
        ) : null}
      </span>
    </button>
  );
}
