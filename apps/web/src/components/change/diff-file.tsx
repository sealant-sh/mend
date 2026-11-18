import { Button } from "@mend/ui/components/ui/button";
import { Checkbox } from "@mend/ui/components/ui/checkbox";
import { Label } from "@mend/ui/components/ui/label";
import { toast } from "@mend/ui/components/ui/toast";
import { cn } from "@mend/ui/lib/utils";
import { ChevronDownIcon, ChevronRightIcon, CopyIcon } from "lucide-react";
import { type ReactNode, useId } from "react";

import { addedWords, type ChangeFile, fileNote, removedWords } from "#/lib/change-files";
import { copyTextChecked } from "#/lib/clipboard";

const copyPath = async (path: string) => {
  const copied = await copyTextChecked(path);
  toast.add(
    copied
      ? { description: `Copied ${path}.`, priority: "low" }
      : { description: "This browser didn't let Mend copy the path.", priority: "high" },
  );
};

/**
 * One file's change (Doop "Diff"): a header with the fold chevron, the path in mono with its
 * folder muted, Copy path, the counts, and the tools on the right (the file's note and Viewed),
 * over the file's lines, which `children` draws. Folded, only the header shows. The header stays
 * at the top of the diffs while its lines scroll under it.
 *
 * `tools` is where a file's own actions go beside Viewed (a "…" menu, a tour stop's place).
 */
export function DiffFile({
  file,
  folded,
  onFoldedChange,
  viewed,
  onViewedChange,
  tools,
  size = "default",
  children,
}: {
  readonly file: ChangeFile;
  readonly folded: boolean;
  readonly onFoldedChange: (folded: boolean) => void;
  readonly viewed: boolean;
  readonly onViewedChange: (viewed: boolean) => void;
  readonly tools?: ReactNode;
  /** Compact on a phone or in a narrow tile: a shorter header, and the counts beside the name. */
  readonly size?: "default" | "compact";
  readonly children: ReactNode;
}) {
  const bodyId = useId();
  const said = fileNote(file);
  const compact = size === "compact";
  return (
    <section aria-label={file.path} data-file={file.path} className="min-w-0 bg-background">
      <div
        className={cn(
          "sticky top-0 z-10 flex items-center gap-2.5 border-b bg-background",
          compact ? "h-10 pr-2 pl-3" : "h-[38px] pr-2.5 pl-4",
        )}
      >
        <button
          type="button"
          aria-expanded={!folded}
          aria-controls={bodyId}
          onClick={() => onFoldedChange(!folded)}
          className="flex min-w-0 items-center gap-2.5 rounded-md text-left outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
        >
          {folded ? (
            <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          ) : (
            <ChevronDownIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
          )}
          <span className="min-w-0 truncate font-mono text-meta font-medium">
            {file.from === null ? null : (
              <span className="font-normal text-muted-foreground">{file.from} → </span>
            )}
            <span className="font-normal text-muted-foreground">{file.dir}</span>
            {file.name}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={`Copy path: ${file.path}`}
          onClick={() => void copyPath(file.path)}
          className="-ml-1.5 text-muted-foreground"
        >
          <CopyIcon aria-hidden />
        </Button>
        <span className="flex shrink-0 gap-1.5 font-mono text-2xs">
          {file.additions > 0 ? (
            <span className="text-success">{addedWords(file.additions)}</span>
          ) : null}
          {file.deletions > 0 ? (
            <span className="text-destructive">{removedWords(file.deletions)}</span>
          ) : null}
        </span>
        <span className="ml-auto flex min-w-0 items-center gap-2.5 text-meta text-muted-foreground">
          {said === null ? null : (
            <span className={cn("truncate", compact && "max-sm:hidden")}>{said}</span>
          )}
          <Label className="shrink-0 cursor-pointer text-meta font-normal text-muted-foreground max-lg:min-h-11">
            <Checkbox
              checked={viewed}
              onCheckedChange={(checked) => onViewedChange(checked)}
              aria-label={`Viewed: ${file.path}`}
            />
            <span aria-hidden className={cn(compact && "max-sm:hidden")}>
              Viewed
            </span>
          </Label>
          {tools}
        </span>
      </div>
      <div id={bodyId} hidden={folded}>
        {folded ? null : children}
      </div>
    </section>
  );
}
