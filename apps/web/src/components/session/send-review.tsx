import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { Button } from "#/components/kit/button";
import { CheckBox } from "#/components/kit/menu";
import { ModalDialog } from "#/components/kit/modal";
import {
  deliverFollowUp,
  type ReviewCommentDto,
  type ReviewDiffDto,
  type SessionChangeDto,
} from "#/lib/api";
import { failureWords } from "#/lib/refusal";
import { useTRPC } from "#/lib/trpc";
import { uuidV4 } from "#/lib/uuid";

/** The follow-up the agent receives: the selected comments, anchored, and how to treat them. */
export const assembleInstruction = (
  change: SessionChangeDto,
  comments: ReadonlyArray<ReviewCommentDto>,
) => {
  const points = comments
    .map((comment, index) => {
      const anchor =
        comment.file === null
          ? "the change as a whole"
          : `${comment.file}${comment.line === null ? "" : `:${comment.line}${comment.endLine === null || comment.endLine === comment.line ? "" : `-${comment.endLine}`}`}`;
      const proposal =
        comment.suggestion === null
          ? ""
          : `\n   Proposed replacement:\n${comment.suggestion
              .split("\n")
              .map((line) => `   ${line}`)
              .join("\n")}`;
      return `${index + 1}. ${anchor} — ${comment.body}${proposal}`;
    })
    .join("\n");
  return `This is a follow-up on your earlier work in this worktree, responding to review feedback. The branch ${change.branch} is already checked out with your work on it: keep working there, and do not start a new branch or reset it.

Review comments:
${points}

Address each point using your own judgment about how. Check your work with the repository's own build, tests, or typecheck; a check that still fails is something to report, not to force green. Report honestly what you changed and what you did not — if a point cannot or should not be done, say so plainly.`;
};

type Delivery = "delivering" | "delivered" | "pending" | "delivery_failed" | null;

/**
 * Send N to the agent (plan §7.3): the person picks the comments and edits the instruction before
 * it goes. What is sent is persisted before launch, under a key kept until the words change, so a
 * retry after an uncertain answer is the same follow-up, never a second one.
 */
export function SendReviewDialog({
  change,
  sessionId,
  agent,
  review,
  comments,
  onClose,
}: {
  readonly change: SessionChangeDto;
  /** The conversation the follow-up is delivered to (the change's last contributor). */
  readonly sessionId: string;
  readonly agent: string;
  readonly review: ReviewDiffDto;
  readonly comments: ReadonlyArray<ReviewCommentDto>;
  readonly onClose: () => void;
}) {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const [selected, setSelected] = useState<ReadonlySet<string>>(
    () => new Set(comments.map((comment) => comment.id)),
  );
  const [instruction, setInstruction] = useState(() => assembleInstruction(change, comments));
  const [idempotencyKey, setIdempotencyKey] = useState(
    () => `web-follow-up:${change.id}:${uuidV4()}`,
  );
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Delivery>(null);
  const [error, setError] = useState<string | null>(null);

  const resetDeliveryKey = () => {
    setIdempotencyKey(`web-follow-up:${change.id}:${uuidV4()}`);
    setResult(null);
    setError(null);
  };

  const select = (commentId: string, checked: boolean) => {
    const next = new Set(selected);
    if (checked) next.add(commentId);
    else next.delete(commentId);
    setSelected(next);
    resetDeliveryKey();
    setInstruction(
      assembleInstruction(
        change,
        comments.filter((comment) => next.has(comment.id)),
      ),
    );
  };

  const send = () => {
    setPending(true);
    setError(null);
    void deliverFollowUp(sessionId, {
      reviewSliceId: review.slice.id,
      checkpointAId: review.checkpointA.id,
      checkpointBId: review.checkpointB.id,
      diffDigest: review.slice.diffDigest,
      commentIds: comments
        .filter((comment) => selected.has(comment.id))
        .map((comment) => comment.id),
      instruction,
      idempotencyKey,
    })
      .then((followUp) => {
        setResult(followUp.status === "superseded" ? "delivery_failed" : followUp.status);
        return Promise.all([
          queryClient.invalidateQueries(trpc.changes.pathFilter()),
          queryClient.invalidateQueries(trpc.sessions.pathFilter()),
        ]);
      })
      .catch((cause: unknown) => setError(failureWords(cause, "The follow-up was not sent.")))
      .finally(() => setPending(false));
  };

  const done = result === "delivered" || result === "pending";
  return (
    <ModalDialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={
        done
          ? result === "delivered"
            ? `Sent to ${agent}`
            : "Saved, not sent yet"
          : `Send ${selected.size} to ${agent}`
      }
      width={640}
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Done
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              variant="primary"
              disabled={pending || selected.size === 0 || instruction.trim() === ""}
              onClick={send}
            >
              {pending
                ? "Sending…"
                : result === "delivering"
                  ? "Check delivery"
                  : result === "delivery_failed"
                    ? "Retry"
                    : `Send ${selected.size} to ${agent}`}
            </Button>
          </>
        )
      }
    >
      {done ? (
        <p role="status" className="text-sm leading-relaxed text-muted-foreground">
          {result === "delivered"
            ? "Mend recorded the new turn and marked only the selected comments sent."
            : "The session became active before the turn could start. The same follow-up stays saved; send it again once the session settles."}
        </p>
      ) : (
        <>
          <p className="font-mono text-[11px] text-faint">
            {selected.size} of {comments.length} comments · continues {change.branch}
          </p>
          <fieldset className="grid max-h-40 gap-2 overflow-auto border-y border-rule-faint py-2">
            <legend className="sr-only">Comments to send</legend>
            {comments.map((comment) => (
              <label key={comment.id} className="flex cursor-pointer items-start gap-2 text-xs">
                <input
                  type="checkbox"
                  checked={selected.has(comment.id)}
                  onChange={(event) => select(comment.id, event.target.checked)}
                  className="peer sr-only"
                />
                <span className="mt-0.5 rounded-[4px] peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--sw-accent)]">
                  <CheckBox checked={selected.has(comment.id)} />
                </span>
                <span className="leading-relaxed text-ink-2">
                  <span className="font-mono text-[10.5px] text-label">
                    {comment.file ?? "whole change"}
                    {comment.line === null ? "" : `:${comment.line}`}
                  </span>{" "}
                  · {comment.body}
                </span>
              </label>
            ))}
          </fieldset>
          <label className="grid gap-2">
            <span className="text-xs font-medium text-label">
              What {agent} receives · edit before sending
            </span>
            <textarea
              value={instruction}
              onChange={(event) => {
                resetDeliveryKey();
                setInstruction(event.target.value);
              }}
              rows={12}
              className="w-full resize-y rounded-xl border border-input bg-panel px-4 py-3 font-sans text-[13.5px] leading-relaxed text-ink-2 outline-none focus-visible:border-primary"
            />
          </label>
          <p className="font-mono text-[10.5px] text-faint">
            saved before it is sent; the agent receives these words as they are
          </p>
          {result === "delivering" ? (
            <p role="status" className="font-mono text-xs text-warning">
              Accepted, still being delivered. Check delivery to see where it stands.
            </p>
          ) : null}
          {result === "delivery_failed" ? (
            <p role="alert" className="font-mono text-xs text-warning">
              Delivery failed before it finished. Retry sends the same follow-up unless you edit it.
            </p>
          ) : null}
          {error === null ? null : (
            <p role="alert" className="font-mono text-xs text-danger">
              {error}
            </p>
          )}
        </>
      )}
    </ModalDialog>
  );
}
