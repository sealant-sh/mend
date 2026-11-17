import { Link, useRouter } from "@tanstack/react-router";
import { useState } from "react";

import { StatusDot } from "#/components/status";
import {
  postBriefComment,
  type BriefCommentDto,
  type BriefDocumentDto,
  type RoutedActionDto,
} from "#/lib/api";

// The review conversation (docs/archive/PRODUCT.md, Iteration): reviewer comments thread
// onto the brief; Mend reads each one and routes it — a follow-up run, a
// verification pass, or a question back — with the routed decision shown on
// the comment itself, as evidence.

const ROUTED_COPY: Record<
  RoutedActionDto,
  { readonly word: string; readonly tone: "accent" | "amber" }
> = {
  "follow-up-run": { word: "Routed · follow-up run", tone: "accent" },
  "verification-run": { word: "Routed · verification pass", tone: "accent" },
  "question-back": { word: "Routed · asked back", tone: "amber" },
};

const threadLabel = (thread: string, document: BriefDocumentDto) => {
  if (thread === "general") return "The brief";
  const index = Number(thread.slice(1));
  const question = document.questions.find((entry) => entry.index === index);
  return question === undefined ? `Question ${index}` : `Q${index} — ${question.question}`;
};

export function ReviewConversation({
  issueId,
  document,
  comments,
}: {
  readonly issueId: string;
  readonly document: BriefDocumentDto;
  readonly comments: ReadonlyArray<BriefCommentDto>;
}) {
  const threads = new Map<string, Array<BriefCommentDto>>();
  for (const comment of comments) {
    const entries = threads.get(comment.thread) ?? [];
    entries.push(comment);
    threads.set(comment.thread, entries);
  }

  return (
    <section className="rounded-2xl bg-panel p-6 shadow-[var(--shadow-sm)]">
      <div className="flex items-baseline justify-between">
        <h2 className="font-sans text-sm font-semibold">Review</h2>
        <span className="font-mono text-xs text-faint">{comments.length}</span>
      </div>
      <p className="mt-1 text-[13px] leading-relaxed text-muted-foreground">
        Comment on the brief — Mend reads it and routes the next action: a follow-up run, a
        verification pass, or a question back. Code only changes through a recorded run.
      </p>

      {threads.size === 0 ? null : (
        <div className="mt-5 space-y-5">
          {[...threads.entries()].map(([thread, entries]) => (
            <div key={thread}>
              <p className="ev-eyebrow truncate" title={threadLabel(thread, document)}>
                {threadLabel(thread, document)}
              </p>
              <ul className="mt-2 space-y-3">
                {entries.map((comment) => (
                  <CommentCard key={comment.id} comment={comment} />
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}

      <Composer issueId={issueId} document={document} />
    </section>
  );
}

function CommentCard({ comment }: { readonly comment: BriefCommentDto }) {
  const mend = comment.authorKind === "mend";
  return (
    <li
      className={`rounded-xl px-4 py-3 ${
        mend ? "bg-[var(--sw-wash)]" : "border border-[var(--sw-faint-rule)] bg-background"
      }`}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="font-sans text-[13px] font-semibold">
          {mend ? "Mend" : comment.authorName}
        </span>
        <span className="font-mono text-[11px] text-faint">
          {new Date(comment.createdAt).toLocaleString()}
        </span>
      </div>
      <p className="mt-1.5 whitespace-pre-wrap text-[13px] leading-relaxed text-ink-2">
        {comment.body}
      </p>
      {comment.authorKind === "reviewer" ? <RoutedLine comment={comment} /> : null}
    </li>
  );
}

function RoutedLine({ comment }: { readonly comment: BriefCommentDto }) {
  if (comment.routedAction === null) {
    return (
      <div className="mt-2.5 border-t border-[var(--sw-faint-rule)] pt-2">
        <StatusDot tone="hollow" word="Mend is reading this" pulse />
      </div>
    );
  }
  const copy = ROUTED_COPY[comment.routedAction];
  return (
    <div className="mt-2.5 flex items-center justify-between gap-3 border-t border-[var(--sw-faint-rule)] pt-2">
      <StatusDot tone={copy.tone} word={copy.word} />
      {comment.routedRunId === null ? null : (
        <Link
          to="/runs/$runId"
          params={{ runId: comment.routedRunId }}
          className="font-mono text-[11.5px] text-[var(--sw-accent)] no-underline hover:underline"
        >
          run {comment.routedRunId.slice(0, 8)}
        </Link>
      )}
    </div>
  );
}

function Composer({
  issueId,
  document,
}: {
  readonly issueId: string;
  readonly document: BriefDocumentDto;
}) {
  const router = useRouter();
  const [thread, setThread] = useState("general");
  const [body, setBody] = useState("");
  const [pending, setPending] = useState(false);

  const submit = async () => {
    setPending(true);
    await postBriefComment(issueId, thread, body);
    setPending(false);
    setBody("");
    await router.invalidate();
  };

  return (
    <form
      className="mt-5 border-t border-[var(--sw-faint-rule)] pt-5"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-2">
        <label className="font-mono text-[11px] uppercase tracking-[0.06em] text-label">on</label>
        <select
          className="rounded-lg border border-input bg-background px-2 py-1.5 font-sans text-[13px] outline-none focus:border-[var(--sw-accent)]"
          value={thread}
          onChange={(event) => setThread(event.target.value)}
        >
          <option value="general">The brief</option>
          {document.questions.map((question) => (
            <option key={question.index} value={`q${question.index}`}>
              Q{question.index} — {question.question.slice(0, 60)}
            </option>
          ))}
        </select>
      </div>
      <textarea
        className="mt-3 min-h-20 w-full rounded-lg border border-input bg-background px-3 py-2 font-sans text-sm outline-none transition-colors duration-150 focus:border-[var(--sw-accent)]"
        placeholder="Ask for a change, ask to see something exercised, or ask a question."
        value={body}
        onChange={(event) => setBody(event.target.value)}
        required
      />
      <button
        type="submit"
        disabled={pending || body.trim() === ""}
        className="mt-3 inline-flex min-h-9 items-center justify-center rounded-xl bg-primary px-4 font-sans text-[13px] font-medium text-primary-foreground shadow-[var(--shadow-cobalt)] transition-[transform,background-color] duration-200 hover:-translate-y-0.5 hover:bg-[var(--primary-hover)] disabled:pointer-events-none disabled:opacity-60"
      >
        {pending ? "Posting…" : "Comment"}
      </button>
    </form>
  );
}
