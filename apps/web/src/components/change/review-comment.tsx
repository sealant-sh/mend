import { Button } from "@mend/ui/components/ui/button";
import { Textarea } from "@mend/ui/components/ui/textarea";
import { cn } from "@mend/ui/lib/utils";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ScanSearchIcon } from "lucide-react";
import { type ReactNode, useCallback, useState } from "react";

import { RichText } from "#/components/session/rich-text";
import type { ReviewCommentDto } from "#/lib/api";
import { clearSentDraft, useDraft } from "#/lib/drafts";
import { focusWhenShown } from "#/lib/focus-when-shown";
import { failureWords } from "#/lib/refusal";
import { linesWords, stateActions, stateWords } from "#/lib/review-comments";
import { useTRPC, useTRPCClient } from "#/lib/trpc";

/** "AL" for Ada Lovelace. */
const initialsOf = (name: string): string =>
  name
    .split(/\s+/)
    .filter((part) => part !== "")
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("");

/** The round mark before an author: a person's initials, or Mend's lens on its drafts. */
function Mark({ comment }: { readonly comment: ReviewCommentDto }) {
  return (
    <span
      aria-hidden
      className="grid size-[22px] flex-none place-items-center rounded-full bg-muted text-2xs font-semibold text-muted-foreground"
    >
      {comment.authorKind === "mend" ? (
        <ScanSearchIcon className="size-3" />
      ) : (
        initialsOf(comment.authorName)
      )}
    </span>
  );
}

/** "Not sent · line 31", "lines 37–40", "Not sent · lines 37–40 · from Mend's draft". */
const metaWords = (comment: ReviewCommentDto, withPlace: boolean): string => {
  const lines = withPlace ? linesWords(comment.line, comment.endLine) : null;
  if (comment.state === "draft") return lines ?? "";
  return [
    stateWords(comment),
    lines,
    comment.authorKind === "mend" ? "from Mend's draft" : null,
    comment.kind === "suggestion" && comment.authorKind !== "mend" ? "suggestion" : null,
  ]
    .filter((part) => part !== null)
    .join(" · ");
};

/** The lines a suggestion would put in place, as they are; none means deleting the lines. */
function Suggestion({ comment }: { readonly comment: ReviewCommentDto }) {
  if (comment.kind !== "suggestion") return null;
  if (comment.suggestion === null)
    return <p className="mt-2 text-meta text-muted-foreground">Suggested: delete these lines.</p>;
  return (
    <div className="mt-2.5 grid gap-1.5">
      <p className="text-meta text-muted-foreground">Suggested replacement</p>
      <pre className="grid grid-cols-[auto_1fr] overflow-x-auto rounded-lg border bg-success/5 px-3 py-2 font-mono text-2xs leading-[1.75] text-foreground">
        <span aria-hidden className="pr-3 text-success select-none">
          {comment.suggestion
            .split("\n")
            .map(() => "+")
            .join("\n")}
        </span>
        <code>{comment.suggestion}</code>
      </pre>
    </div>
  );
}

/** Where a finding was seen in the session's record: the reason it was allowed to exist. */
function Evidence({ comment }: { readonly comment: ReviewCommentDto }) {
  if (comment.evidence.length === 0) return null;
  return (
    <ul className="mt-2 grid gap-0.5 text-meta text-muted-foreground">
      {comment.evidence.map((link) => (
        <li key={`${link.sequence}:${link.excerpt}`} className="truncate">
          <span className="font-mono text-2xs text-faint">record #{link.sequence}</span>{" "}
          {link.excerpt}
        </li>
      ))}
    </ul>
  );
}

/**
 * A comment's buttons: Add to comments and Dismiss on Mend's draft, Resolve and Dismiss (Remove
 * for one added from a draft) on an open one, Reopen on one resolved or dismissed. Each says it
 * is working on itself, and a failure is said under the comment.
 */
export function useCommentActions(comment: ReviewCommentDto, touch: boolean) {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const queryClient = useQueryClient();
  const [failure, setFailure] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (state: "open" | "addressed" | "dismissed") =>
      client.changes.setCommentState.mutate({
        id: comment.changeId,
        commentId: comment.id,
        request: { state },
      }),
    onMutate: () => setFailure(null),
    onError: (cause) =>
      setFailure(`Mend couldn't change this comment. ${failureWords(cause, "Try again.")}`),
    onSettled: () =>
      queryClient.invalidateQueries(trpc.changes.comments.queryFilter({ id: comment.changeId })),
  });
  const buttons = stateActions(comment).map((action, index) => (
    <Button
      key={action.state}
      variant={comment.state === "draft" && index === 0 ? "outline" : "ghost"}
      size={touch ? "touch" : "sm"}
      disabled={change.isPending}
      onClick={() => change.mutate(action.state)}
      className={cn(
        comment.state === "draft" && index === 0 ? "" : "text-muted-foreground",
        action.label === "Reopen" && "text-info",
      )}
    >
      {change.isPending && change.variables === action.state ? `${action.label}…` : action.label}
    </Button>
  ));
  const said =
    failure === null ? null : (
      <p role="alert" className="mt-2 text-meta text-destructive">
        {failure}
      </p>
    );
  return { buttons, said };
}

/**
 * One comment (Doop "Review comment"): on a line, between the diff's rows on the band and indented
 * past the line numbers; or in a list. The mark, the author in bold, a muted line saying where it
 * stands, its actions on the right, then the words (Markdown), a suggestion's replacement and the
 * record it came from. Resolved or dismissed, it folds to its header line.
 */
export function ReviewComment({
  comment,
  place,
  touch = false,
}: {
  readonly comment: ReviewCommentDto;
  readonly place: "line" | "change";
  readonly touch?: boolean;
}) {
  const { buttons, said } = useCommentActions(comment, touch);
  const folded = comment.state === "addressed" || comment.state === "dismissed";
  const author =
    comment.state === "draft"
      ? "Draft from Mend"
      : comment.authorKind === "mend"
        ? "Mend"
        : comment.authorName;
  const draft = comment.state === "draft";
  return (
    <article
      aria-label={`${author}: ${comment.body.slice(0, 80)}`}
      data-comment={comment.id}
      className={cn(
        // Between diff rows it sits in the renderer's monospace: set the comment's own face.
        "bg-band text-left font-sans text-prose leading-[1.45] tracking-normal whitespace-normal text-foreground",
        place === "line" ? "border-y py-3 pr-6 pl-4" : "px-6 py-3",
      )}
    >
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-control">
        <Mark comment={comment} />
        <b className="font-semibold">{author}</b>
        <span className="text-meta text-muted-foreground">
          {metaWords(comment, place === "line")}
        </span>
        {folded ? (
          <span className="min-w-0 flex-1 truncate text-meta text-muted-foreground">
            {comment.body}
          </span>
        ) : null}
        {draft && touch ? null : <span className="ml-auto flex items-center gap-1">{buttons}</span>}
      </div>
      {folded ? null : (
        <>
          <RichText text={comment.body} className="mt-1.5 text-prose" />
          <Suggestion comment={comment} />
          <Evidence comment={comment} />
          {draft && touch ? <div className="mt-3 flex gap-2 *:flex-1">{buttons}</div> : null}
        </>
      )}
      {said}
    </article>
  );
}

/**
 * Writing a comment: a box with the person's words, kept as a draft until saved (`draftKey`), with
 * Cancel and Add comment. Escape puts it away and keeps the words; Cancel drops them. ⌘↵ or
 * Ctrl+↵ adds it. `onSave` sends the words; a refusal is said in the box and the words stay.
 */
export function CommentComposer({
  label,
  heading,
  draftKey,
  agent,
  onSave,
  onClose,
  compact = false,
  touch = false,
}: {
  /** The box's name for screen readers: "Comment on retry.ts, line 31". */
  readonly label: string;
  /** What goes over the box: the author and the lines. */
  readonly heading?: ReactNode;
  readonly draftKey: string;
  readonly agent: string;
  readonly onSave: (body: string) => Promise<unknown>;
  readonly onClose: () => void;
  /** In the file column: a short box, its note under it. */
  readonly compact?: boolean;
  readonly touch?: boolean;
}) {
  const [body, setBody] = useDraft(draftKey);
  const [failure, setFailure] = useState<string | null>(null);
  const save = useMutation({
    mutationFn: (text: string) => onSave(text),
    onMutate: () => setFailure(null),
    onSuccess: (_, text) => {
      clearSentDraft(draftKey, text);
      onClose();
    },
    onError: (cause) =>
      setFailure(
        `Mend didn't save the comment. ${failureWords(cause, "Your words are still here; try again.")}`,
      ),
  });
  // The diff slots this box into its rows after React's commit, where `autoFocus` finds nothing
  // drawn yet to focus: focus it once it shows.
  const focusOnceShown = useCallback((textarea: HTMLTextAreaElement | null) => {
    if (textarea === null) return;
    return focusWhenShown(textarea);
  }, []);
  const submit = () => {
    const text = body.trim();
    if (text !== "" && !save.isPending) save.mutate(text);
  };
  return (
    <div className="grid gap-2">
      {heading}
      <div className="grid rounded-lg border border-info bg-background shadow-[0_0_0_3px_color-mix(in_oklab,var(--color-info)_15%,transparent)]">
        <Textarea
          ref={focusOnceShown}
          aria-label={label}
          value={body}
          rows={compact ? 3 : 2}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              onClose();
            }
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-h-16 resize-y border-0 bg-transparent px-3.5 pt-3 text-prose shadow-none focus-visible:ring-0"
        />
        <div className="flex flex-wrap items-center justify-end gap-2 px-3 pb-2.5">
          {compact ? null : (
            <p className="mr-auto text-meta text-muted-foreground">
              You can use Markdown. {agent} gets this when you send your comments.
            </p>
          )}
          <Button
            variant="ghost"
            size={touch ? "touch" : "sm"}
            onClick={() => {
              // Cancelling puts the words away: they don't come back with the next comment.
              setBody("");
              onClose();
            }}
          >
            Cancel
          </Button>
          <Button
            variant="outline"
            size={touch ? "touch" : "sm"}
            disabled={save.isPending || body.trim() === ""}
            onClick={submit}
          >
            {save.isPending ? "Adding…" : "Add comment"}
          </Button>
        </div>
      </div>
      {failure === null ? null : (
        <p role="alert" className="text-meta text-destructive">
          {failure}
        </p>
      )}
    </div>
  );
}
