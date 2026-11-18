import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { Label } from "@mend/ui/components/ui/label";
import { Popover, PopoverContent, PopoverTrigger } from "@mend/ui/components/ui/popover";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@mend/ui/components/ui/sheet";
import { ChevronDownIcon } from "lucide-react";
import { useState } from "react";

import { SheetHandle } from "#/components/sheet-item";
import {
  addedWords,
  type ChangeFile,
  filterGroups,
  type FileGroup,
  removedWords,
} from "#/lib/change-files";
import { usePhone } from "#/lib/phone";

import { ChangeFileTree, FILTER_FROM, FileFilter } from "./change-file-tree.tsx";

/**
 * The narrow Change view's file picker (a tile beside a conversation, or a phone): the file the
 * diffs are showing, "2 of 38", its counts and Viewed, over the diffs. It opens the file list, as a
 * popover beside the tile, or as a sheet from the bottom on a phone.
 */
export function FilePicker({
  groups,
  files,
  current,
  viewedCount,
  isViewed,
  onViewed,
  onSelect,
}: {
  readonly groups: ReadonlyArray<FileGroup>;
  readonly files: ReadonlyArray<ChangeFile>;
  readonly current: ChangeFile;
  readonly viewedCount: number;
  readonly isViewed: (file: ChangeFile) => boolean;
  readonly onViewed: (file: ChangeFile, viewed: boolean) => void;
  readonly onSelect: (path: string) => void;
}) {
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const shown = filterGroups(groups, filter);
  const place = files.indexOf(current) + 1;
  const pick = (path: string) => {
    setOpen(false);
    onSelect(path);
  };
  const trigger = (
    <button
      type="button"
      aria-haspopup="dialog"
      {...(phone ? { onClick: () => setOpen(true) } : {})}
      aria-label={`File ${place} of ${files.length}: ${current.path}. Show every file`}
      className="flex min-w-0 items-center gap-1.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50 max-lg:min-h-11"
    >
      <span className="truncate font-mono text-control font-medium">{current.name}</span>
      <span className="shrink-0 text-meta text-muted-foreground">
        · {place} of {files.length}
      </span>
      <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
    </button>
  );
  const list = (
    <div className="grid gap-2">
      {files.length >= FILTER_FROM ? (
        <FileFilter value={filter} onChange={setFilter} size={phone ? "touch" : "default"} />
      ) : null}
      <ChangeFileTree
        groups={shown}
        selected={current.path}
        viewed={isViewed}
        onSelect={pick}
        onViewed={onViewed}
        size={phone ? "touch" : "default"}
      />
    </div>
  );
  return (
    <div className="flex h-12 shrink-0 items-center gap-3 border-b bg-background px-4 max-lg:h-14">
      {phone ? (
        <>
          {trigger}
          <Sheet open={open} onOpenChange={setOpen}>
            <SheetContent
              side="bottom"
              className="max-h-[92dvh] gap-0 rounded-t-pop-touch pb-[env(safe-area-inset-bottom)]"
            >
              <SheetHandle />
              <SheetHeader className="border-b px-5 pt-2 pb-3">
                <SheetTitle className="text-title font-semibold">Files</SheetTitle>
                <SheetDescription className="text-prose">
                  {viewedCount} of {files.length} viewed
                </SheetDescription>
              </SheetHeader>
              <div className="min-h-0 overflow-y-auto py-3 [&>div>div:first-child]:mx-4">
                {list}
              </div>
            </SheetContent>
          </Sheet>
        </>
      ) : (
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger render={trigger} />
          <PopoverContent align="start" className="max-h-[60vh] w-80 overflow-y-auto p-2">
            <p className="flex items-baseline justify-between px-2 pb-1.5 text-control font-semibold">
              Files
              <span className="text-meta font-normal text-muted-foreground">
                {viewedCount} of {files.length} viewed
              </span>
            </p>
            {list}
          </PopoverContent>
        </Popover>
      )}
      <span className="flex shrink-0 gap-1.5 font-mono text-2xs">
        {current.additions > 0 ? (
          <span className="text-success">{addedWords(current.additions)}</span>
        ) : null}
        {current.deletions > 0 ? (
          <span className="text-destructive">{removedWords(current.deletions)}</span>
        ) : null}
      </span>
      <Label className="ml-auto shrink-0 cursor-pointer text-meta font-normal text-muted-foreground max-lg:min-h-11">
        <Checkbox
          checked={isViewed(current)}
          onCheckedChange={(checked) => onViewed(current, checked)}
          aria-label={`Viewed: ${current.path}`}
        />
        <span aria-hidden>Viewed</span>
      </Label>
    </div>
  );
}
