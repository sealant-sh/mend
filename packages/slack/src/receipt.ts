import { SlackStatusKey } from "@mend/domain/workbench";
import { Schema } from "effect";

import { NO_PREVIEWS, WorktreePreviews } from "./previews.ts";

/**
 * What a status message shows, as far as Mend knows.
 *
 * - `Unknown`: nothing is recorded, or Slack did not answer the last edit in time.
 * - `Legacy`: the line a release before receipts wrote, compared by its text, so an upgrade
 *   edits no message whose line is unchanged.
 * - `Rendered`: the key of its whole rendering (`statusKey`), and `base`, the key of the
 *   rendering without its previews, which tells a move of the previews alone.
 * - `Gone`: Slack said the message or its channel no longer exists. It is never edited again.
 */
export const StatusShown = Schema.Union([
  Schema.TaggedStruct("Unknown", {}),
  Schema.TaggedStruct("Legacy", { text: Schema.String }),
  Schema.TaggedStruct("Rendered", { key: SlackStatusKey, base: SlackStatusKey }),
  Schema.TaggedStruct("Gone", {}),
]);
export type StatusShown = typeof StatusShown.Type;

/**
 * What Mend keeps about a thread's status message (`slack_threads.reported_status`), so every
 * worker edits it by the same rules: what it shows, when Slack last took an edit (epoch ms), the
 * time before which no edit is sent (Slack's Retry-After, or the backoff after a refusal), how many
 * edits in a row Slack refused, and the previews and change counts last read for it, for a look
 * that cannot read them.
 */
const MessageReceipt = Schema.Struct({
  shown: StatusShown,
  editedAt: Schema.NullOr(Schema.Number),
  holdUntil: Schema.NullOr(Schema.Number),
  refusals: Schema.Int,
  previews: WorktreePreviews,
  counts: Schema.NullOr(
    Schema.Struct({ files: Schema.Int, additions: Schema.Int, deletions: Schema.Int }),
  ),
});
// The blocks the reporter retains are its generated review and landing offer, never Slack input.
const ReplyText = Schema.Struct({ type: Schema.Literal("mrkdwn"), text: Schema.String });
const ReplyButton = Schema.Struct({
  type: Schema.Literal("button"),
  action_id: Schema.String,
  text: Schema.Struct({
    type: Schema.Literal("plain_text"),
    text: Schema.String,
    emoji: Schema.optionalKey(Schema.Boolean),
  }),
  value: Schema.optionalKey(Schema.String),
  url: Schema.optionalKey(Schema.String),
  style: Schema.optionalKey(Schema.Literals(["primary", "danger"])),
});

/** The latest landing-offer reply, retained so the reporter can edit its preview buttons. */
export const SlackReplyReceipt = Schema.Struct({
  ts: Schema.String,
  base: Schema.Struct({
    text: Schema.String,
    blocks: Schema.Array(
      Schema.Union([
        Schema.Struct({ type: Schema.Literal("markdown"), text: Schema.String }),
        Schema.Struct({
          type: Schema.Literal("section"),
          text: ReplyText,
          accessory: Schema.optionalKey(ReplyButton),
        }),
        Schema.Struct({ type: Schema.Literal("context"), elements: Schema.Array(ReplyText) }),
        Schema.Struct({ type: Schema.Literal("actions"), elements: Schema.Array(ReplyButton) }),
      ]),
    ),
  }),
  edit: MessageReceipt,
});
export type SlackReplyReceipt = typeof SlackReplyReceipt.Type;

export const SlackStatusReceipt = Schema.Struct({
  ...MessageReceipt.fields,
  reply: Schema.optionalKey(SlackReplyReceipt),
});
export type SlackStatusReceipt = typeof SlackStatusReceipt.Type;

const NOTHING_RECORDED: SlackStatusReceipt = {
  shown: { _tag: "Unknown" },
  editedAt: null,
  holdUntil: null,
  refusals: 0,
  previews: NO_PREVIEWS,
  counts: null,
};

const Stored = Schema.fromJsonString(SlackStatusReceipt);
const decodeStored = Schema.decodeUnknownOption(Stored);
const encodeStored = Schema.encodeSync(Stored);

/** The receipt a stored value holds: none yet, a receipt, or the line an earlier release wrote. */
export const receiptOf = (stored: string | null): SlackStatusReceipt => {
  if (stored === null) return NOTHING_RECORDED;
  const decoded = decodeStored(stored);
  return decoded._tag === "Some"
    ? decoded.value
    : { ...NOTHING_RECORDED, shown: { _tag: "Legacy", text: stored } };
};

export const storedReceipt = (receipt: SlackStatusReceipt): string => encodeStored(receipt);

/** Whether the message shows a rendering keyed `key` whose fallback text is `text`. */
export const showsRendering = (shown: StatusShown, key: SlackStatusKey, text: string): boolean => {
  switch (shown._tag) {
    case "Unknown":
    case "Gone":
      return false;
    case "Legacy":
      return shown.text === text;
    case "Rendered":
      return shown.key === key;
  }
};

/** A rendering of the status message: what its receipt records once Slack shows it. */
export interface StatusRendering {
  readonly key: SlackStatusKey;
  readonly base: SlackStatusKey;
  readonly previews: WorktreePreviews;
  readonly counts: SlackStatusReceipt["counts"];
}

/** The receipt of a status message just posted: it shows `rendering`, and was never edited. */
export const postedReceipt = (rendering: StatusRendering): SlackStatusReceipt => ({
  ...NOTHING_RECORDED,
  shown: { _tag: "Rendered", key: rendering.key, base: rendering.base },
  previews: rendering.previews,
  counts: rendering.counts,
});

/**
 * The receipt claimed before an edit is sent: the message shows `rendering` from `at`. A failed
 * edit goes back from it (`receiptAfter`).
 */
export const editedReceipt = (rendering: StatusRendering, at: number): SlackStatusReceipt => ({
  shown: { _tag: "Rendered", key: rendering.key, base: rendering.base },
  editedAt: at,
  holdUntil: null,
  refusals: 0,
  previews: rendering.previews,
  counts: rendering.counts,
});

/**
 * Why an edit did not land. `MessageGone` and `Refused` are Slack's answers (`updateRefusalOf`):
 * a refused edit changed nothing. `Unanswered` is no answer in time: the request may still land,
 * so what the message shows is unknown.
 */
export type EditFailure =
  | { readonly _tag: "MessageGone" }
  | { readonly _tag: "Refused"; readonly retryAfterMs: number | null }
  | { readonly _tag: "Unanswered" };

/** The first wait after a refusal that named no Retry-After; each refusal in a row doubles it. */
export const EDIT_BACKOFF_MS = 5_000;
/** The longest wait between two tries at an edit Slack keeps refusing. */
export const EDIT_BACKOFF_MAX_MS = 15 * 60_000;
/**
 * How long an edit that got no answer holds the next one: longer than the Slack client's own three
 * tries of 10 s take, so a late answer to it is overwritten. A Retry-After Slack gave the client
 * inside that request can outlast it.
 */
export const UNANSWERED_HOLD_MS = 60_000;

const backoffMs = (refusals: number) =>
  Math.min(EDIT_BACKOFF_MS * 2 ** Math.max(refusals - 1, 0), EDIT_BACKOFF_MAX_MS);

/** The receipt after an edit claimed over `previous` failed at `at`. */
export const receiptAfter = (
  previous: SlackStatusReceipt,
  failure: EditFailure,
  at: number,
): SlackStatusReceipt => {
  const refusals = previous.refusals + 1;
  switch (failure._tag) {
    case "MessageGone":
      return { ...previous, shown: { _tag: "Gone" }, holdUntil: null };
    case "Refused":
      return {
        ...previous,
        holdUntil: at + (failure.retryAfterMs ?? backoffMs(refusals)),
        refusals,
      };
    case "Unanswered":
      return {
        ...previous,
        shown: { _tag: "Unknown" },
        holdUntil: at + Math.max(UNANSWERED_HOLD_MS, backoffMs(refusals)),
        refusals,
      };
  }
};
