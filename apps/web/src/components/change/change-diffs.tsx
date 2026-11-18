import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import {
  type DiffLineAnnotation,
  type FileDiffMetadata,
  parsePatchFiles,
  registerCustomCSSVariableTheme,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

/**
 * Which files the person folded or opened by hand. A viewed file folds by itself; flipping it
 * opens it, and flipping any other file folds it. Picking a file from a list opens it.
 */
export const useFolds = () => {
  const [flipped, setFlipped] = useState<ReadonlySet<string>>(new Set());
  const set = (path: string, flip: boolean) =>
    setFlipped((current) => {
      if (current.has(path) === flip) return current;
      const next = new Set(current);
      if (flip) next.add(path);
      else next.delete(path);
      return next;
    });
  return {
    isFolded: (path: string, viewed: boolean) => flipped.has(path) !== viewed,
    fold: (path: string, folded: boolean, viewed: boolean) => set(path, folded !== viewed),
    /** Back to what the file does by itself: after a Viewed mark changes. */
    reset: (path: string) => set(path, false),
  };
};

export type Folds = ReturnType<typeof useFolds>;

import type { ChangeFile } from "#/lib/change-files";
import type { DiffLayout } from "#/lib/ui-prefs";

import { DiffFile } from "./diff-file.tsx";

/**
 * Sheet's syntax theme for the diff renderer: every colour is a `--diffs-*` variable the
 * `.change-diff` rule in styles.css sets from the kit's tokens, so one theme serves light and
 * dark. The values here only cover a variable that fails to resolve. Like the canvas's Diff, code
 * is one ink; the tints and the signs carry the change.
 */
registerCustomCSSVariableTheme("mend-sheet", {
  foreground: "var(--color-foreground)",
  background: "transparent",
  "token-comment": "var(--color-faint)",
  "token-keyword": "var(--color-foreground)",
  "token-string": "var(--color-foreground)",
  "token-string-expression": "var(--color-foreground)",
  "token-constant": "var(--color-foreground)",
  "token-function": "var(--color-foreground)",
  "token-punctuation": "var(--color-foreground)",
  "token-link": "var(--color-foreground)",
});

const THEME = { light: "mend-sheet", dark: "mend-sheet" } as const;

/** Row metrics the virtualizer plans with before a line is measured: the canvas's 21px lines. */
const METRICS: VirtualFileMetrics = {
  hunkLineCount: 50,
  lineHeight: 21,
  diffHeaderHeight: 0,
  spacing: 0,
};

/** One file's lines, read from its own patch only once it shows. */
const parsedFile = (patch: string): FileDiffMetadata | null =>
  parsePatchFiles(patch).flatMap((parsed) => parsed.files)[0] ?? null;

/** `set` with `path` in it or not. */
const toggled = (set: ReadonlySet<string>, path: string, on: boolean): ReadonlySet<string> => {
  if (set.has(path) === on) return set;
  const next = new Set(set);
  if (on) next.add(path);
  else next.delete(path);
  return next;
};

/** A muted line in place of lines: a folded generated file, a binary one, a rename alone. */
function BodyNote({ children }: { readonly children: ReactNode }) {
  return (
    <p className="flex flex-wrap items-baseline gap-x-3 gap-y-1 border-b bg-band px-4 py-3 text-row text-muted-foreground lg:px-[46px]">
      {children}
    </p>
  );
}

/** Where a pinned review's two sides were taken, over split columns. */
export interface DiffSides {
  readonly old: string;
  readonly new: string;
}

/** What the comments (PR 24) and the tour (PR 25) put between a file's lines. */
export interface BetweenLines<A> {
  readonly annotations: (file: ChangeFile) => ReadonlyArray<DiffLineAnnotation<A>>;
  readonly render: (annotation: DiffLineAnnotation<A>) => ReactNode;
}

function FileLines<A>({
  file,
  layout,
  compact,
  sides,
  between,
}: {
  readonly file: ChangeFile;
  readonly layout: DiffLayout;
  readonly compact: boolean;
  readonly sides: DiffSides;
  readonly between: BetweenLines<A> | undefined;
}) {
  const parsed = useMemo(() => parsedFile(file.file.patch), [file.file.patch]);
  const split = layout === "split" && !compact;
  // The renderer draws again when these change: keep them the same object while they hold.
  const options = useMemo(
    () => ({
      theme: THEME,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      diffIndicators: "classic" as const,
      lineDiffType: "none" as const,
      hunkSeparators: "metadata" as const,
      overflow: compact ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
      lineHoverHighlight: "line" as const,
    }),
    [split, compact],
  );
  const annotations = useMemo(
    () => (between === undefined ? [] : [...between.annotations(file)]),
    [between, file],
  );
  if (parsed === null || parsed.hunks.length === 0)
    return (
      <BodyNote>
        {file.from !== null
          ? "Renamed, with no lines changed."
          : file.binary
            ? "A binary file: Mend shows no lines for it."
            : "No lines changed."}
      </BodyNote>
    );
  return (
    <>
      {split ? (
        <div className="grid grid-cols-2 border-b bg-band font-mono text-2xs text-muted-foreground">
          <span className="truncate px-4 py-1.5">{sides.old}</span>
          <span className="truncate border-l px-4 py-1.5">{sides.new}</span>
        </div>
      ) : null}
      <FileDiff<A>
        fileDiff={parsed}
        metrics={METRICS}
        className="change-diff block border-b"
        lineAnnotations={annotations}
        {...(between === undefined ? {} : { renderAnnotation: between.render })}
        options={options}
      />
    </>
  );
}

/**
 * Every changed file's diff, one under the other, in one scroll of their own. The diff renderer
 * (@pierre/diffs, the old app's) draws inside its virtualizer, so a big change stays quick: only
 * the lines near the view are in the page. Generated files show a line in place of their diff
 * until asked; viewed files fold to their header.
 *
 * `above` is the place over the diffs (Mend's description, PR 25); `after` sits under the last
 * file (proof artifacts). `between` puts rows between a file's lines (comments, PR 24; tour stops,
 * PR 25). `focus` brings a file to the top (its nonce asks again); `onShowing` says which file is
 * at the top as the person scrolls.
 */
export function ChangeDiffs<A = undefined>({
  files,
  layout,
  compact,
  sides,
  isViewed,
  onViewed,
  folds,
  focus,
  onShowing,
  above,
  after,
  between,
}: {
  readonly files: ReadonlyArray<ChangeFile>;
  readonly layout: DiffLayout;
  readonly compact: boolean;
  readonly sides: DiffSides;
  readonly isViewed: (file: ChangeFile) => boolean;
  readonly onViewed: (file: ChangeFile, viewed: boolean) => void;
  readonly folds: Folds;
  readonly focus: { readonly path: string; readonly nonce: number } | null;
  readonly onShowing: (path: string) => void;
  readonly above?: ReactNode;
  readonly after?: ReactNode;
  readonly between?: BetweenLines<A>;
}) {
  // Generated files whose diff the person asked to see.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const content = useRef<HTMLDivElement>(null);

  // A file picked from a list: unfold it and bring its header to the top of the scroll. Scrolling
  // is the browser's, after layout; the nonce lets the same file be asked for twice.
  useEffect(() => {
    if (focus === null) return;
    const frame = requestAnimationFrame(() => {
      const section = content.current?.querySelector<HTMLElement>(
        `[data-file="${CSS.escape(focus.path)}"]`,
      );
      const scroller = content.current?.parentElement?.parentElement;
      if (section === undefined || section === null || scroller == null) return;
      scroller.scrollTop = section.offsetTop;
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  // Which file is at the top while the person scrolls, read once per frame.
  useEffect(() => {
    // The virtualizer's own element scrolls: it holds a content element, which holds this.
    const scroller = content.current?.parentElement?.parentElement;
    if (scroller == null) return;
    let frame = 0;
    const read = () => {
      frame = 0;
      const sections = content.current?.querySelectorAll<HTMLElement>("[data-file]") ?? [];
      let top: string | null = null;
      for (const section of sections) {
        if (section.offsetTop - scroller.scrollTop > 8) break;
        top = section.dataset["file"] ?? top;
      }
      const first = sections[0]?.dataset["file"];
      const path = top ?? first;
      if (path !== undefined) onShowing(path);
    };
    const onScroll = () => {
      if (frame === 0) frame = requestAnimationFrame(read);
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      scroller.removeEventListener("scroll", onScroll);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [onShowing]);

  return (
    <Virtualizer
      className="min-h-0 flex-1 overflow-y-auto overscroll-contain"
      contentClassName="relative"
      config={{ overscrollSize: 600 }}
    >
      <div ref={content}>
        {above}
        {files.map((file) => {
          const viewed = isViewed(file);
          const asked = shown.has(file.path);
          return (
            <DiffFile
              key={file.path}
              file={file}
              folded={folds.isFolded(file.path, viewed)}
              onFoldedChange={(folded) => folds.fold(file.path, folded, viewed)}
              viewed={viewed}
              onViewedChange={(mark) => {
                onViewed(file, mark);
                // Marking folds the file; unmarking opens it. A hand fold starts over.
                folds.reset(file.path);
              }}
              size={compact ? "compact" : "default"}
            >
              {file.generated && !asked ? (
                <BodyNote>
                  <span>
                    Mend folded this file because a tool generated it. You rarely need to read it.
                  </span>
                  <Button
                    variant="link"
                    className={cn("ml-auto text-info", compact && "ml-0")}
                    onClick={() => setShown((current) => toggled(current, file.path, true))}
                  >
                    Show diff
                  </Button>
                </BodyNote>
              ) : (
                <FileLines
                  file={file}
                  layout={layout}
                  compact={compact}
                  sides={sides}
                  between={between}
                />
              )}
            </DiffFile>
          );
        })}
        {after}
      </div>
    </Virtualizer>
  );
}
