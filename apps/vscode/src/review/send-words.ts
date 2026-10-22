import type { LiveAgent, Notice, SendPhase, SendRecord, StopReason } from "./delivery.js";
import type { ReviewPlace } from "./kept-reviews.js";
import type { FailOptions } from "./send-driver.js";

/** What VS Code did when a drive stopped. */
export const stopWords = (why: StopReason): string => {
  switch (why.kind) {
    case "closed":
      return "VS Code closed";
    case "switched":
      return "VS Code connected to another Mend server or account";
    case "signed-out":
      return "VS Code was signed out of Mend";
    case "error":
      return why.words;
  }
};

/** What VS Code did when a drive stopped, before `when`; a failure says itself in its own words. */
export const stopClause = (why: StopReason, when: string): string =>
  why.kind === "error" ? why.words : `${stopWords(why)} ${when}`;

/** A paste that may have reached the agent's input, in part or whole, and why it stopped. */
const cutShortWords = (why: string, agent: string): string =>
  `${why}, so some or all of it may be in ${agent}'s input. Mend holds the follow-up pending: check ${agent}'s input before Retry delivery pastes it again.`;

/** A paste that went nowhere, and why. */
const notPastedWords = (why: "agent-gone" | "not-attached", agent: string): string =>
  why === "agent-gone"
    ? `${agent} exited before the review was pasted, so nothing was pasted. Mend holds the follow-up pending: Retry delivery sends it to the stopped session.`
    : `VS Code could not attach ${agent}'s terminal here, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it again.`;

/** A paste that failed: she checks the terminal and retries. */
const pasteFailed = (words: string): Notice => ({
  kind: "paste",
  words,
  tone: "error",
  retry: true,
  text: false,
});

/** A paste into `agent` that went nowhere, or that the paste's own failure, in `words`, cut short. */
export const pasteFailedNotice = (
  failed:
    | { readonly why: "agent-gone" | "not-attached" }
    | { readonly why: "interrupted"; readonly words: string },
  agent: string,
): Notice =>
  pasteFailed(
    failed.why === "interrupted"
      ? cutShortWords(
          `VS Code could not finish pasting the review into ${agent}'s terminal: ${failed.words}`,
          agent,
        )
      : notPastedWords(failed.why, agent),
  );

/** A review whose drive stopped, for `why`, before or during its paste into `agent`. */
export const stoppedPasteNotice = (
  agent: string,
  why: StopReason,
  mayHaveLanded: boolean,
): Notice => {
  const terminal = `the review into ${agent}'s terminal`;
  return pasteFailed(
    mayHaveLanded
      ? cutShortWords(stopClause(why, `while it pasted ${terminal}`), agent)
      : `${stopClause(why, `before it pasted ${terminal}`)}, so nothing was pasted. Mend holds the follow-up pending: Retry delivery pastes it.`,
  );
};

/** Nothing was pasted, and `words` say why: a warning, with nothing to retry. */
export const skippedNotice = (words: string): Notice => ({
  kind: "paste",
  words,
  tone: "warning",
  retry: false,
  text: false,
});

/** Mend sent the review, and the drafts her words replace are still on Mend, `left` saying why. */
export const draftLeftNotice = (left: ReadonlyArray<string>): Notice => ({
  kind: "draft-left",
  words: `Mend sent the review. The Mend draft your words replace is still on Mend, because VS Code could not dismiss it: ${left.join(" ")}`,
  tone: "warning",
  retry: false,
  text: false,
});

/** Mend refused the review, in its `words`. */
export const refusedNotice = (words: string): Notice => ({
  kind: "refused",
  words: `Mend could not deliver the review: ${words}`,
  tone: "error",
  retry: false,
  text: false,
});

/** What a thread of a comment in this record reads, as Mend observed it. */
export const recordLabel = (phase: SendPhase): string => {
  switch (phase.kind) {
    case "sending":
      return "sending";
    case "delivering":
      return "delivery in progress";
    case "in-terminal":
      switch (phase.paste.kind) {
        case "done":
          return `follow-up pending · pasted into ${phase.agent}'s terminal`;
        case "failed":
          return phase.paste.mayHaveLanded
            ? `follow-up pending · paste into ${phase.agent}'s terminal cut short`
            : `follow-up pending · not pasted into ${phase.agent}'s terminal`;
        case "pasting":
          return `follow-up pending · pasting into ${phase.agent}'s terminal`;
        case "due":
          return "follow-up pending";
      }
    case "pending":
      return "follow-up pending";
    case "delivered":
      return "sent";
    case "failed":
      return "delivery failed · retryable";
    case "refused":
      return "not sent";
  }
};

/**
 * What the thread of a comment in this record reads (`commentId` null for one not on Mend yet): in
 * her terminal, whether VS Code pasted its words, and into which agent process. Only what VS Code
 * did: Enter, a reload or her own edits since are not observed.
 */
export const commentLabel = (
  record: SendRecord,
  commentId: string | null,
  agent: LiveAgent | null,
): string => {
  const { phase } = record;
  if (phase.kind !== "in-terminal" || phase.paste.kind !== "done") return recordLabel(phase);
  if (commentId !== null && !phase.paste.input.ids.includes(commentId))
    return `follow-up pending · not pasted into ${phase.agent}'s terminal`;
  return agent?.kind === "terminal" && agent.processId === phase.processId
    ? recordLabel(phase)
    : `follow-up pending · pasted into an earlier ${phase.agent}`;
};

export const NOT_LISTED =
  "Mend no longer lists this follow-up, and it does not read its comments as sent to the session";

export const DRAFT_GONE =
  "A Mend draft in this review was dismissed before it was sent, and the review's text still asks for it, so nothing was sent";

/** A draft in the review was dismissed: Send review composes it again, from her own words. */
export const DRAFT_GONE_NOTICE: Notice = {
  kind: "draft-gone",
  words: `${DRAFT_GONE}. Send review composes it again without that draft, from your comments as they are now.`,
  tone: "warning",
  retry: false,
  text: true,
};

/** A toast a kept send says: the same in every window, so the one she looks at shows it once. */
export interface Told {
  readonly what: string;
  readonly words: string;
  readonly options: FailOptions;
}

/**
 * What a kept send leaves her to know: its failed delivery, named by when it failed, and every
 * notice a step kept with it, named by its kind and when it was kept.
 */
export const toldOf = (place: ReviewPlace, record: SendRecord): ReadonlyArray<Told> => {
  const retry = { place, key: record.key };
  const failed: ReadonlyArray<Told> =
    record.phase.kind === "failed"
      ? [
          {
            what: `delivery:${record.key}`,
            words: `Mend could not deliver the review: ${record.phase.words}`,
            options: { retry, at: record.phase.at },
          },
        ]
      : [];
  return [
    ...failed,
    ...record.notices.map(
      (notice): Told => ({
        what: `${notice.kind}:${record.key}`,
        words: notice.words,
        options: {
          at: notice.at,
          tone: notice.tone,
          retry: notice.retry ? retry : null,
          ...(notice.text ? { text: record.instruction } : {}),
        },
      }),
    ),
  ];
};
