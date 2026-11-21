import { Button } from "@mend/ui/components/ui/button";
import { cn } from "@mend/ui/lib/utils";
import {
  type DiffLineAnnotation,
  type FileDiffMetadata,
  parsePatchFiles,
  registerCustomCSSVariableTheme,
  type SelectedLineRange,
  type VirtualFileMetrics,
} from "@pierre/diffs";
import { FileDiff, Virtualizer } from "@pierre/diffs/react";
import {
  type ReactNode,
  type RefObject,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";

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
    /** The folds as they are, to put back later (the tour does, when it ends). */
    saved: flipped,
    restore: (saved: ReadonlySet<string>) => setFlipped(saved),
  };
};

export type Folds = ReturnType<typeof useFolds>;

import type { ChangeFile } from "#/lib/change-files";
import type { DiffLayout } from "#/lib/ui-prefs";

import { DiffFile } from "./diff-file.tsx";

/**
 * Sheet's syntax theme for the diff renderer: every colour is a `--diffs-*` variable the
 * `.change-diff` rule in styles.css sets from the kit's tokens (`syntax-keyword`, `syntax-string`,
 * `syntax-constant`, `syntax-link`), so one theme serves light and dark. The values here only cover
 * a variable that fails to resolve. The tints and the signs carry the change; the hues only help
 * read the code.
 */
registerCustomCSSVariableTheme("mend-sheet", {
  foreground: "var(--color-foreground)",
  background: "transparent",
  "token-comment": "var(--color-muted-foreground)",
  "token-keyword": "var(--color-syntax-keyword)",
  "token-string": "var(--color-syntax-string)",
  "token-string-expression": "var(--color-syntax-string)",
  "token-constant": "var(--color-syntax-constant)",
  "token-parameter": "var(--color-foreground)",
  "token-function": "var(--color-foreground)",
  "token-punctuation": "var(--color-muted-foreground)",
  "token-link": "var(--color-syntax-link)",
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

/**
 * Picking lines to comment on (PR 24): a click on a line number picks that line, a drag across
 * line numbers picks a range, always on the new side. `selected` keeps the picked lines washed
 * while their comment is being written.
 */
export interface LinePicking {
  readonly onPick: (file: ChangeFile, start: number, end: number) => void;
  readonly selected: (file: ChangeFile) => { readonly start: number; readonly end: number } | null;
}

/**
 * Lines of a file marked with the cobalt bar on their left edge (a tour stop's): new-side lines
 * `from` to `to`, and the removed lines between them by their old-side numbers.
 */
export interface MarkedLines {
  readonly from: number;
  readonly to: number;
  readonly removed: ReadonlyArray<number>;
}

/**
 * Where to bring the diffs' scroll to: a file's header (`path`), or the top of the diffs
 * (`path: null`), then, when `target` names an element under it, that element just under the
 * file headers. The nonce lets the same place be asked for twice.
 */
export interface DiffsFocus {
  readonly path: string | null;
  readonly nonce: number;
  readonly target?: string;
  /** How much of the diff to leave showing between the file's header and `target`, in px. */
  readonly above?: number;
}

/**
 * The renderer's own rows live in a shadow root: what Mend adds there. The number column beside a
 * row put between the lines (a comment, a tour stop) takes that row's band.
 */
const BETWEEN_CSS = `[data-gutter-buffer="annotation"] {
  background-color: var(--color-band);
  box-shadow: inset 0 1px 0 var(--color-border), inset 0 -1px 0 var(--color-border);
}`;

/** The renderer's stylesheet for the bar on `marked`'s lines. */
const markedCss = (marked: MarkedLines | null): string | undefined => {
  if (marked === null) return undefined;
  // A row's number cell carries its number: the new side's for added and unchanged lines, the
  // old side's for removed ones.
  const cells: Array<string> = [];
  for (let line = marked.from; line <= marked.to; line += 1)
    cells.push(`[data-column-number="${line}"]:not([data-line-type="change-deletion"])`);
  for (const line of marked.removed)
    cells.push(`[data-column-number="${line}"][data-line-type="change-deletion"]`);
  return `${cells.join(",\n")} { box-shadow: inset 2px 0 0 var(--color-info); }`;
};

function FileLines<A>({
  file,
  layout,
  compact,
  sides,
  between,
  marked,
  picking,
}: {
  readonly file: ChangeFile;
  readonly layout: DiffLayout;
  readonly compact: boolean;
  readonly sides: DiffSides;
  readonly between: BetweenLines<A> | undefined;
  readonly marked: MarkedLines | null;
  readonly picking: LinePicking | undefined;
}) {
  const parsed = useMemo(() => parsedFile(file.file.patch), [file.file.patch]);
  const split = layout === "split" && !compact;
  // The renderer draws again when these change: keep them the same object while they hold.
  const css = [BETWEEN_CSS, markedCss(marked)].filter((part) => part !== undefined).join("\n");
  // The renderer keeps the handlers it was given first: they read the newest `picking` through a
  // ref, kept current after each render.
  const pickRef = useRef(picking);
  useLayoutEffect(() => {
    pickRef.current = picking;
  });
  // A drag across line numbers, washed as it goes; the renderer's selection is controlled.
  const [dragging, setDragging] = useState<SelectedLineRange | null>(null);
  const picks = picking !== undefined;
  const options = useMemo(
    () => ({
      unsafeCSS: css,
      theme: THEME,
      diffStyle: split ? ("split" as const) : ("unified" as const),
      diffIndicators: "classic" as const,
      lineDiffType: "none" as const,
      hunkSeparators: "metadata" as const,
      overflow: compact ? ("wrap" as const) : ("scroll" as const),
      disableFileHeader: true,
      lineHoverHighlight: "line" as const,
      ...(picks
        ? {
            enableLineSelection: true,
            // Comments go on the new side: a removed line has nothing there to anchor to.
            onLineNumberClick: (line: {
              readonly lineNumber: number;
              readonly annotationSide?: string;
            }) => {
              if (line.annotationSide === "deletions") return;
              pickRef.current?.onPick(file, line.lineNumber, line.lineNumber);
            },
            onLineSelectionChange: (range: SelectedLineRange | null) => setDragging(range),
            onLineSelectionEnd: (range: SelectedLineRange | null) => {
              setDragging(null);
              if (range === null || range.side === "deletions" || range.endSide === "deletions")
                return;
              const start = Math.min(range.start, range.end);
              const end = Math.max(range.start, range.end);
              // A click ends a selection of one line too; the click itself picks it.
              if (start !== end) pickRef.current?.onPick(file, start, end);
            },
          }
        : {}),
    }),
    [split, compact, css, picks, file],
  );
  const picked = picking?.selected(file) ?? null;
  const selected = dragging ?? (picked === null ? null : { start: picked.start, end: picked.end });
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
        {...(picks ? { selectedLines: selected } : {})}
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
 * PR 25); `under` puts one under a file's header, and `marked` gives a file's header or lines the
 * cobalt bar (a tour stop). `picking` turns clicks and drags on line numbers into a comment's
 * lines, and `tools` adds a file's own actions to its header. `focus` brings a file, or the top, into view (its nonce asks again);
 * `onShowing` says which file is at the top as the person scrolls. `scrollRef` is given the element
 * that scrolls, for a caller that keeps its place.
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
  under,
  marked,
  picking,
  tools,
  scrollRef,
}: {
  readonly files: ReadonlyArray<ChangeFile>;
  readonly layout: DiffLayout;
  readonly compact: boolean;
  readonly sides: DiffSides;
  readonly isViewed: (file: ChangeFile) => boolean;
  readonly onViewed: (file: ChangeFile, viewed: boolean) => void;
  readonly folds: Folds;
  readonly focus: DiffsFocus | null;
  readonly onShowing: (path: string) => void;
  readonly above?: ReactNode;
  readonly after?: ReactNode;
  readonly between?: BetweenLines<A>;
  readonly under?: (file: ChangeFile) => ReactNode;
  /** The file's header (`"header"`) or some of its lines carry the bar; null for neither. */
  readonly marked?: (file: ChangeFile) => "header" | MarkedLines | null;
  /** Clicking or dragging line numbers to comment on them (PR 24). */
  readonly picking?: LinePicking;
  /** A file's own actions in its header, beside Viewed. */
  readonly tools?: (file: ChangeFile) => ReactNode;
  readonly scrollRef?: RefObject<HTMLElement | null>;
}) {
  // Generated files whose diff the person asked to see.
  const [shown, setShown] = useState<ReadonlySet<string>>(new Set());
  const content = useRef<HTMLDivElement>(null);

  // The element that scrolls, for a caller that keeps its place. The virtualizer's own element
  // scrolls: it holds a content element, which holds this.
  useEffect(() => {
    if (scrollRef === undefined) return;
    scrollRef.current = content.current?.parentElement?.parentElement ?? null;
  }, [scrollRef]);

  // A file picked from a list: unfold it and bring its header to the top of the scroll; or the
  // top of the diffs. Then a `target` under it, once the virtualizer has drawn it, just under the
  // file's header. Scrolling is the browser's, after layout; the nonce lets the same place be
  // asked for twice.
  useEffect(() => {
    if (focus === null) return;
    let frame = 0;
    let tries = 0;
    const toTarget = () => {
      frame = 0;
      const scroll = content.current?.parentElement?.parentElement;
      if (scroll == null || focus.target === undefined) return;
      const target = content.current?.querySelector<HTMLElement>(focus.target);
      if (target == null) {
        // Rows near the view are drawn a frame or two after it moves.
        tries += 1;
        if (tries < 30) frame = requestAnimationFrame(toTarget);
        return;
      }
      const header = target.closest("[data-file]")?.querySelector<HTMLElement>(".sticky");
      const gap = (header?.offsetHeight ?? 0) + (focus.above ?? 0);
      scroll.scrollTop +=
        target.getBoundingClientRect().top - scroll.getBoundingClientRect().top - gap;
    };
    frame = requestAnimationFrame(() => {
      const scroll = content.current?.parentElement?.parentElement;
      if (scroll == null) return;
      if (focus.path === null) scroll.scrollTop = 0;
      else {
        const section = content.current?.querySelector<HTMLElement>(
          `[data-file="${CSS.escape(focus.path)}"]`,
        );
        if (section == null) return;
        scroll.scrollTop = section.offsetTop;
      }
      frame = requestAnimationFrame(toTarget);
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
          const bar = marked?.(file) ?? null;
          return (
            <DiffFile
              key={file.path}
              file={file}
              marked={bar === "header"}
              folded={folds.isFolded(file.path, viewed)}
              onFoldedChange={(folded) => folds.fold(file.path, folded, viewed)}
              viewed={viewed}
              onViewedChange={(mark) => {
                onViewed(file, mark);
                // Marking folds the file; unmarking opens it. A hand fold starts over.
                folds.reset(file.path);
              }}
              size={compact ? "compact" : "default"}
              tools={tools?.(file)}
            >
              {under?.(file)}
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
                  marked={bar === null || bar === "header" ? null : bar}
                  picking={picking}
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
