import {
  parsePatchFiles,
  registerCustomCSSVariableTheme,
  type DiffLineAnnotation,
  type SelectedLineRange,
} from "@pierre/diffs";
import { FileDiff } from "@pierre/diffs/react";
import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { CommentStateActions, EvidenceLines, SuggestionBlock } from "#/components/comment-state";
import { postSliceReviewComment, type ReviewCommentDto, type ReviewDiffFileDto } from "#/lib/api";
import { focusWhenShown } from "#/lib/focus-when-shown";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";

/**
 * The workbench diff, rendered by @pierre/diffs (Shiki highlighting, their
 * renderer's performance) and skinned by us. The reading surface is ONE
 * scroll container — the page never grows with the diff — with our own
 * sticky, collapsible file header per file (Pierre's header is disabled).
 * Review comments ride the library's annotation framework; commenting
 * anchors to a single line (click) or a line RANGE (drag across gutter
 * lines), always on the new file — deletions have nothing to anchor to.
 */

type Annotation =
  | { readonly kind: "comment"; readonly comment: ReviewCommentDto }
  | { readonly kind: "composer"; readonly anchor: CommentAnchor };

interface CommentAnchor {
  readonly file: string;
  readonly line: number;
  readonly endLine: number | null;
  readonly oldPath: string | null;
  readonly newPath: string | null;
  readonly side: "new";
  readonly hunkContextHash: string;
}

/**
 * The Evidence Review syntax theme: token colors come from `--diffs-*` CSS
 * variables (defined in styles.css against our tokens), so one registration
 * serves light and dark and the palette lives with the rest of the design
 * system. The defaults below only cover a variable failing to resolve.
 */
registerCustomCSSVariableTheme("evidence-review", {
  foreground: "#3b3b40",
  background: "transparent",
  "token-comment": "#9a9aa2",
  "token-keyword": "#7a4f33",
  "token-string": "#55705e",
  "token-string-expression": "#55705e",
  "token-constant": "#6f5a8e",
  "token-function": "#1b1b1d",
  "token-punctuation": "#6e6e76",
  "token-link": "#3b5a92",
});

/**
 * Injected into their shadow root: the EV edge-mark discipline (2px edge,
 * never a flood) — and a visible ::selection. The page's selection style
 * cannot pierce the shadow DOM, so without this, dragging over code selects
 * invisibly: the worst of both worlds. Text selection (anywhere, for copying)
 * and line selection (gutter drag, for range comments) now both paint.
 */
const EDGE_MARK_CSS = `
[data-line-type="change-addition"] { box-shadow: inset 2px 0 0 var(--sw-add-edge, #2e7d46); }
[data-line-type="change-deletion"] { box-shadow: inset 2px 0 0 var(--sw-del-edge, #c0362c); }
::selection { background: color-mix(in oklab, var(--sw-accent, #2052cc) 30%, transparent); }
/* The library's selection vars style BACKGROUNDS only; the selected-number
   FOREGROUND derives from the (purple) modified ramp — unreadable on our
   cobalt band. Ink, explicitly (matches the source's own selector). */
[data-gutter-buffer][data-selected-line],
[data-column-number][data-selected-line],
[data-column-number][data-editor-active-line] {
  color: var(--sw-ink, #1b1b1d);
}
`;

/**
 * Map a drag to the line range it spans by GEOMETRY — the drag's vertical
 * extent against each row's rectangle. Selection APIs proved unreliable for
 * this: a drag starting on a `user-select: none` region (hunk separators,
 * gutters, padding) never creates a browser selection at all, which is
 * exactly the "sometimes it works" failure mode. Geometry always answers.
 * Rows vote if the drag's y-span touches them; deletions abstain.
 */
const draggedLineSpan = (
  wrapper: HTMLElement,
  fromY: number,
  toY: number,
): { start: number; end: number } | null => {
  const host = wrapper.querySelector("diffs-container");
  const shadowRoot = host?.shadowRoot ?? null;
  if (shadowRoot === null) return null;
  const top = Math.min(fromY, toY);
  const bottom = Math.max(fromY, toY);
  let start = Number.POSITIVE_INFINITY;
  let end = Number.NEGATIVE_INFINITY;
  for (const row of shadowRoot.querySelectorAll("[data-line]")) {
    if (row.getAttribute("data-line-type") === "change-deletion") continue;
    const rect = row.getBoundingClientRect();
    if (rect.bottom < top || rect.top > bottom) continue;
    const line = Number(row.getAttribute("data-line"));
    if (Number.isFinite(line)) {
      start = Math.min(start, line);
      end = Math.max(end, line);
    }
  }
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return { start, end };
};

export interface FileStat {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
}

export type DiffStyle = "unified" | "split";

export function WorkbenchDiff({
  diff,
  changeId,
  comments,
  stats,
  reviewSliceId,
  reviewFiles,
  focus,
  diffStyle = "unified",
  viewed,
  onViewed,
}: {
  readonly diff: string;
  readonly changeId: string;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly stats: ReadonlyArray<FileStat>;
  readonly reviewSliceId: string;
  readonly reviewFiles: ReadonlyArray<ReviewDiffFileDto>;
  /** Sidebar navigation: expand + scroll to this file (nonce re-triggers). */
  readonly focus?: { readonly path: string; readonly nonce: number } | null;
  readonly diffStyle?: DiffStyle;
  /** The files this person marked viewed; a viewed file folds. */
  readonly viewed: ReadonlySet<string>;
  readonly onViewed: (path: string, viewed: boolean) => void;
}) {
  const [composer, setComposer] = useState<CommentAnchor | null>(null);
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [selection, setSelection] = useState<{
    readonly file: string;
    readonly start: number;
    readonly end: number;
  } | null>(null);
  const files = useMemo(() => parsePatchFiles(diff).flatMap((patch) => patch.files), [diff]);
  const statOf = useMemo(() => new Map(stats.map((stat) => [stat.path, stat])), [stats]);
  const reviewFileOf = useMemo(
    () => new Map(reviewFiles.map((file) => [file.newPath ?? file.oldPath ?? "", file])),
    [reviewFiles],
  );
  const anchorFor = useCallback(
    (file: string, line: number, endLine: number | null): CommentAnchor | null => {
      const reviewFile = reviewFileOf.get(file);
      if (reviewFile === undefined) return null;
      const finalLine = endLine ?? line;
      const hunk = reviewFile.hunks.find(
        (candidate) =>
          candidate.newLines > 0 &&
          line >= candidate.newStart &&
          finalLine <= candidate.newStart + candidate.newLines - 1,
      );
      if (hunk === undefined) return null;
      return {
        file,
        line,
        endLine,
        oldPath: reviewFile.oldPath,
        newPath: reviewFile.newPath,
        side: "new",
        hunkContextHash: hunk.contextHash,
      };
    },
    [reviewFileOf],
  );
  const sectionsRef = useRef(new Map<string, HTMLElement>());
  const dragRef = useRef<{
    file: string;
    x: number;
    y: number;
    wrapper: HTMLElement;
  } | null>(null);

  // The release can land anywhere — past the card edge, on the scrollbar, on
  // another panel — so the drag completes at the WINDOW, not the wrapper.
  useEffect(() => {
    const onWindowMouseUp = (event: MouseEvent) => {
      const origin = dragRef.current;
      dragRef.current = null;
      if (origin === null) return;
      if (Math.abs(event.clientY - origin.y) < 5 && Math.abs(event.clientX - origin.x) < 5) {
        return; // a click, not a drag — clicks belong to the gutter handlers
      }
      const span = draggedLineSpan(origin.wrapper, origin.y, event.clientY);
      if (span === null) return;
      const anchor = anchorFor(origin.file, span.start, span.end > span.start ? span.end : null);
      if (anchor === null) return;
      setSelection({ file: origin.file, start: span.start, end: span.end });
      setComposer(anchor);
    };
    window.addEventListener("mouseup", onWindowMouseUp);
    return () => window.removeEventListener("mouseup", onWindowMouseUp);
  }, [anchorFor]);
  // NOTE on consistency: during a TEXT drag nothing re-renders (a mid-drag
  // React render destroys the browser's in-progress selection — learned the
  // hard way), so the drag paints natively; on release the span is computed
  // by INTERSECTING the range with the rows and the wash is pinned through
  // the library's controlled `selectedLines` until the composer closes.
  // Gutter drags carry no native selection, so mirroring them live is safe.

  // Imperative by nature: a file was picked from a list; expand it and bring its header into view.
  useEffect(() => {
    if (focus === undefined || focus === null) return;
    setCollapsed((current) => {
      if (!current.has(focus.path)) return current;
      const next = new Set(current);
      next.delete(focus.path);
      return next;
    });
    const frame = requestAnimationFrame(() => {
      sectionsRef.current.get(focus.path)?.scrollIntoView({ block: "start" });
    });
    return () => cancelAnimationFrame(frame);
  }, [focus]);

  if (diff === "") {
    return (
      <div className="rounded-[22px] bg-panel p-6 shadow-sm">
        <p className="text-sm text-muted-foreground">
          The worktree matches its base. Nothing to review yet.
        </p>
      </div>
    );
  }

  const toggle = (name: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  return (
    <div className="grid gap-3">
      {files.map((file) => {
        const isViewed = viewed.has(file.name);
        // A viewed file folds unless the reviewer opened it again; an unviewed one folds by hand.
        const isCollapsed = collapsed.has(file.name) !== isViewed;
        const stat = statOf.get(file.name);
        const fileComments = comments.filter(
          (comment) => comment.file === file.name && comment.line !== null,
        );
        const annotations: Array<DiffLineAnnotation<Annotation>> = fileComments.map((comment) => ({
          side: "additions",
          // The card renders at the END of its range, under the last line.
          lineNumber: comment.endLine ?? comment.line ?? 0,
          metadata: { kind: "comment", comment },
        }));
        if (composer !== null && composer.file === file.name) {
          annotations.push({
            side: "additions",
            lineNumber: composer.endLine ?? composer.line,
            metadata: { kind: "composer", anchor: composer },
          });
        }
        const bodyId = `diff-${file.name}`;
        return (
          <section
            key={file.name}
            aria-label={file.name}
            ref={(element) => {
              if (element === null) sectionsRef.current.delete(file.name);
              else sectionsRef.current.set(file.name, element);
            }}
            className="scroll-mt-2 overflow-hidden rounded-[22px] bg-panel font-mono text-[12px] shadow-sm"
          >
            <div
              className={`sticky top-0 z-10 flex items-center gap-2.5 bg-secondary px-3.5 py-[9px] text-ink-2 ${isCollapsed ? "" : "border-b border-rule"}`}
            >
              <button
                type="button"
                role="checkbox"
                aria-checked={isViewed}
                aria-label={`Viewed: ${file.name}`}
                title="Viewed"
                onClick={() => onViewed(file.name, !isViewed)}
                className="grid rounded-[4px] outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sw-accent)]"
              >
                <span
                  aria-hidden="true"
                  className={`inline-grid size-[15px] place-items-center rounded-[4px] border-[1.5px] ${isViewed ? "border-primary bg-primary text-primary-foreground" : "border-input"}`}
                >
                  {isViewed ? (
                    <svg
                      width="11"
                      height="11"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.6"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="m5 12 5 5 9-10" />
                    </svg>
                  ) : null}
                </span>
              </button>
              <button
                type="button"
                aria-expanded={!isCollapsed}
                aria-controls={bodyId}
                onClick={() => toggle(file.name)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left outline-none focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--sw-accent)]"
              >
                <span className="min-w-0 flex-1 truncate">{file.name}</span>
                {fileComments.length > 0 && (
                  <span className="text-[11px] text-info">
                    {fileComments.length} comment{fileComments.length === 1 ? "" : "s"}
                  </span>
                )}
                {stat === undefined ? null : (
                  <span className="flex gap-2.5">
                    {stat.additions > 0 ? (
                      <span className="text-success">+{stat.additions}</span>
                    ) : null}
                    {stat.deletions > 0 ? (
                      <span className="text-danger">−{stat.deletions}</span>
                    ) : null}
                  </span>
                )}
              </button>
            </div>
            {!isCollapsed && (
              // Selecting TEXT is also a comment gesture: the wash follows the drag live
              // (controlled `selectedLines`), and on release the spanned lines become the
              // composer's anchor. Copy still works — the selection is left intact.
              <div
                id={bodyId}
                className="ev-diff"
                onMouseDown={(event) => {
                  dragRef.current = {
                    file: file.name,
                    x: event.clientX,
                    y: event.clientY,
                    wrapper: event.currentTarget,
                  };
                }}
              >
                <FileDiff<Annotation>
                  fileDiff={file}
                  lineAnnotations={annotations}
                  selectedLines={
                    selection !== null && selection.file === file.name
                      ? { start: selection.start, end: selection.end }
                      : null
                  }
                  options={{
                    diffStyle,
                    theme: { light: "evidence-review", dark: "evidence-review" },
                    unsafeCSS: EDGE_MARK_CSS,
                    lineHoverHighlight: "line",
                    disableFileHeader: true,
                    enableLineSelection: true,
                    // Controlled selection: the gutter drag's wash renders from state, so it
                    // must be mirrored while dragging.
                    onLineSelectionChange: (range: SelectedLineRange | null) => {
                      if (range === null) return;
                      setSelection({
                        file: file.name,
                        start: Math.min(range.start, range.end),
                        end: Math.max(range.start, range.end),
                      });
                    },
                    // Drag across line numbers → range comment composer.
                    onLineSelectionEnd: (range: SelectedLineRange | null) => {
                      if (range === null) return;
                      const [start, end] =
                        range.start <= range.end
                          ? [range.start, range.end]
                          : [range.end, range.start];
                      const anchor = anchorFor(file.name, start, end > start ? end : null);
                      if (anchor === null) return;
                      setSelection({ file: file.name, start, end });
                      setComposer(anchor);
                    },
                    onLineNumberClick: (props) => {
                      const anchor = anchorFor(file.name, props.lineNumber, null);
                      if (anchor === null) return;
                      setSelection({
                        file: file.name,
                        start: props.lineNumber,
                        end: props.lineNumber,
                      });
                      setComposer(anchor);
                    },
                  }}
                  renderAnnotation={(annotation) =>
                    annotation.metadata.kind === "comment" ? (
                      <InlineComment comment={annotation.metadata.comment} />
                    ) : (
                      <InlineComposer
                        changeId={changeId}
                        reviewSliceId={reviewSliceId}
                        anchor={annotation.metadata.anchor}
                        onDone={() => {
                          setComposer(null);
                          setSelection(null);
                        }}
                      />
                    )
                  }
                />
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

/** "12" or "12–18" — one label for both anchor shapes. */
export const lineLabel = (line: number | null, endLine: number | null) =>
  line === null ? null : endLine === null || endLine === line ? `${line}` : `${line}–${endLine}`;

function InlineComment({ comment }: { readonly comment: ReviewCommentDto }) {
  return (
    <div
      className={`my-1.5 mr-3.5 ml-[50px] rounded-xl border border-rule bg-panel px-3 py-2.5 font-sans shadow-xs ${comment.state === "dismissed" ? "opacity-60" : ""}`}
    >
      <p className="mb-0.5 flex items-baseline gap-2.5">
        <b className="text-[13px] font-semibold text-foreground">
          {comment.authorKind === "mend" ? "Mend" : comment.authorName}
        </b>
        <span className="font-mono text-[11px] text-faint">
          {comment.kind === "suggestion" ? "suggestion · " : ""}
          {lineLabel(comment.line, comment.endLine) === null
            ? ""
            : `line ${lineLabel(comment.line, comment.endLine)} · `}
          {comment.sentToSessionId !== null
            ? "sent"
            : comment.state === "open"
              ? "not sent"
              : comment.state}
        </span>
      </p>
      <p className="text-[13.5px] leading-relaxed text-ink-2">{comment.body}</p>
      <SuggestionBlock comment={comment} />
      <EvidenceLines comment={comment} />
      <CommentStateActions comment={comment} />
    </div>
  );
}

function InlineComposer({
  changeId,
  reviewSliceId,
  anchor,
  onDone,
}: {
  readonly changeId: string;
  readonly reviewSliceId: string;
  readonly anchor: CommentAnchor;
  readonly onDone: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // The diff slots this composer into its shadow root after the commit, where `autoFocus` finds
  // nothing rendered to focus: focus it once it shows.
  const focusOnceShown = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (textarea === null) return;
    return focusWhenShown(textarea);
  }, []);

  const submit = () => {
    if (body.trim() === "") return;
    setPending(true);
    setError(null);
    void postSliceReviewComment(
      changeId,
      reviewSliceId,
      {
        oldPath: anchor.oldPath,
        newPath: anchor.newPath,
        side: anchor.side,
        startLine: anchor.line,
        endLine: anchor.endLine ?? anchor.line,
        hunkContextHash: anchor.hunkContextHash,
      },
      body.trim(),
    )
      .then(() => queryClient.invalidateQueries(trpc.changes.pathFilter()))
      .then(onDone)
      .catch((cause: unknown) =>
        setError(failureWords(cause, "The comment was not saved. It is still here; try again.")),
      )
      .finally(() => setPending(false));
  };

  return (
    <div className="my-1.5 mr-3.5 ml-[50px] rounded-xl border border-[color-mix(in_oklab,var(--sw-accent)_35%,transparent)] bg-panel p-3 font-sans shadow-xs">
      <p className="font-mono text-[10.5px] text-label">
        comment · {anchor.file}:{lineLabel(anchor.line, anchor.endLine)}
      </p>
      <textarea
        ref={focusOnceShown}
        aria-label={`Comment on ${anchor.file}, line ${lineLabel(anchor.line, anchor.endLine) ?? ""}`}
        value={body}
        onChange={(event) => setBody(event.target.value)}
        rows={2}
        className="mt-2 w-full resize-y rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm text-foreground"
      />
      {error === null ? null : (
        <p role="alert" className="mt-2 text-[12.5px] text-danger">
          {error}
        </p>
      )}
      <div className="mt-2 flex justify-end gap-3">
        <button
          type="button"
          onClick={onDone}
          className="font-sans text-sm font-medium text-muted-foreground"
        >
          Cancel
        </button>
        <button
          type="button"
          disabled={pending || body.trim() === ""}
          onClick={submit}
          className="rounded-xl bg-primary px-3.5 py-1.5 font-sans text-sm font-medium text-primary-foreground disabled:opacity-50"
        >
          {pending ? "Saving…" : "Comment"}
        </button>
      </div>
    </div>
  );
}
