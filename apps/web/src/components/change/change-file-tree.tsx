import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { InputGroup, InputGroupAddon, InputGroupInput } from "@mend/ui/components/ui/input-group";
import { cn } from "@mend/ui/lib/utils";
import { CheckIcon, FolderOpenIcon, SearchIcon } from "lucide-react";

import {
  addedWords,
  type ChangeFile,
  type FileGroup,
  fileNote,
  removedWords,
} from "#/lib/change-files";

/** From this many files the list offers a filter. */
export const FILTER_FROM = 12;

/** The filter over a change's files, by any part of a path. */
export function FileFilter({
  value,
  onChange,
  size = "default",
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly size?: "default" | "touch";
}) {
  return (
    <InputGroup className={cn(size === "touch" && "h-11")}>
      <InputGroupAddon>
        <SearchIcon aria-hidden />
      </InputGroupAddon>
      <InputGroupInput
        type="search"
        aria-label="Filter files"
        placeholder="Filter files"
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className={cn(size === "touch" && "text-lead")}
      />
    </InputGroup>
  );
}

/** A file's counts in green and red, or its note in their place (Generated, Binary, Renamed). */
function RowCounts({
  file,
  countsOnly,
}: {
  readonly file: ChangeFile;
  /** The phone's picker says the note on a line of its own. */
  readonly countsOnly: boolean;
}) {
  const note =
    !countsOnly && (file.generated || file.binary || file.from !== null) ? fileNote(file) : null;
  if (note !== null)
    return <span className="shrink-0 font-sans text-meta text-muted-foreground">{note}</span>;
  return (
    <span className="flex shrink-0 gap-2 text-right">
      {file.additions > 0 ? (
        <span className="min-w-[30px] text-success">{addedWords(file.additions)}</span>
      ) : null}
      {file.deletions > 0 ? (
        <span className="min-w-6 text-destructive">{removedWords(file.deletions)}</span>
      ) : null}
    </span>
  );
}

/**
 * The Change view's file list (Doop "Change file row", one per file): a tick once viewed, the file
 * name in mono, its counts. Files that share a folder sit under that folder's muted line. A row
 * jumps to its file's diff; `selected` is the file the diffs are showing.
 *
 * `size="touch"` is the phone's picker: 44px rows, a box to tick in place of the tick mark, and
 * the note on a line of its own.
 */
export function ChangeFileTree({
  groups,
  selected,
  viewed,
  onSelect,
  onViewed,
  size = "default",
}: {
  readonly groups: ReadonlyArray<FileGroup>;
  readonly selected: string | null;
  readonly viewed: (file: ChangeFile) => boolean;
  readonly onSelect: (path: string) => void;
  /** Ticks a file viewed from the list; the phone's picker offers it. */
  readonly onViewed?: (file: ChangeFile, viewed: boolean) => void;
  readonly size?: "default" | "touch";
}) {
  const touch = size === "touch";
  return (
    <ul aria-label="Changed files" className="grid gap-px">
      {groups.map((group) => (
        <li key={group.folder ?? ""}>
          {group.folder === null ? null : (
            <p
              className={cn(
                "flex items-center gap-1.5 font-mono text-2xs text-muted-foreground",
                touch ? "h-11 border-y bg-band px-4" : "h-7 px-2",
              )}
            >
              <FolderOpenIcon aria-hidden className="size-3.5 shrink-0" />
              <span className="truncate">{group.folder}</span>
            </p>
          )}
          <ul className="grid gap-px">
            {group.files.map((file) => {
              const isViewed = viewed(file);
              const label = group.folder === null ? file.path : file.name;
              return (
                <li
                  key={file.path}
                  className={cn("flex items-center", touch && "border-b", touch && "px-4")}
                >
                  {touch && onViewed !== undefined ? (
                    <Checkbox
                      aria-label={`Viewed: ${file.path}`}
                      checked={isViewed}
                      onCheckedChange={(checked) => onViewed(file, checked)}
                      className="mr-3 size-5"
                    />
                  ) : null}
                  <button
                    type="button"
                    aria-current={selected === file.path ? "true" : undefined}
                    onClick={() => onSelect(file.path)}
                    className={cn(
                      "flex min-w-0 flex-1 items-center gap-1.5 rounded-chip text-left font-mono text-2xs text-foreground outline-none hover:bg-muted/60 focus-visible:ring-3 focus-visible:ring-ring/50 aria-[current]:bg-muted aria-[current]:font-medium",
                      touch ? "min-h-12 py-1.5 text-control" : "h-7 px-2",
                      !touch && group.folder !== null && "pl-[22px]",
                    )}
                  >
                    {touch ? null : (
                      <CheckIcon
                        aria-hidden
                        className={cn(
                          "size-3.5 shrink-0 text-muted-foreground",
                          !isViewed && "invisible",
                        )}
                      />
                    )}
                    <span className="grid min-w-0 flex-1">
                      <span className="truncate">
                        {label}
                        {isViewed && !touch ? <span className="sr-only"> (viewed)</span> : null}
                      </span>
                      {touch && fileNote(file) !== null ? (
                        <span className="truncate font-sans text-meta text-muted-foreground">
                          {file.from === null ? fileNote(file) : `Renamed from ${file.from}`}
                          {file.generated ? " · folded" : ""}
                        </span>
                      ) : null}
                    </span>
                    <RowCounts file={file} countsOnly={touch} />
                  </button>
                </li>
              );
            })}
          </ul>
        </li>
      ))}
    </ul>
  );
}
