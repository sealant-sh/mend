import { Schema } from "effect";

import { OrganizationId } from "../ids.ts";

/**
 * Slack (docs/adr/0006-slack.md): what Mend keeps about an organization's Slack app and the
 * sessions started from it. Tokens never appear here. The database holds them sealed, and no API
 * returns them.
 */

/**
 * What an organization owner decides goes into Slack ("What Mend posts, and where"), and the
 * harness a mention runs when it names none.
 */
export const SlackInstallSettings = Schema.Struct({
  defaultHarness: Schema.String,
  /** The plan, closing messages and questions, as well as status, reactions and links. */
  showAgentMessages: Schema.Boolean,
  /** The diff of each changed file, as well as the file list and line counts. */
  showDiffs: Schema.Boolean,
  /** Whether the two settings above also apply in Slack Connect channels. */
  externalChannels: Schema.Boolean,
});
export type SlackInstallSettings = typeof SlackInstallSettings.Type;

/**
 * How a Slack-started session's project was chosen ("Which project a mention runs in"). The status
 * message says it, and the audit log records it.
 *
 * - `message`: `project=` or `in <project>` in the mention.
 * - `thread-session`: the thread already had a session in that project.
 * - `thread-link`: a repository link in the thread matched the project's `originUrl`.
 * - `thread-inference`: inference over the thread's text picked it.
 * - `channel-default`, `personal-default`: the channel's default, or the person's.
 * - `picked`: the person chose it from Mend's buttons, or with "Switch project".
 */
export const SlackProjectSource = Schema.Literals([
  "message",
  "thread-session",
  "thread-link",
  "thread-inference",
  "channel-default",
  "personal-default",
  "picked",
]);
export type SlackProjectSource = typeof SlackProjectSource.Type;

/**
 * A Slack-started session as its thread hears it ("What Mend posts, and where"): the reporter folds
 * session, process and turn state into this, and the status message and the reaction show it.
 * `completed` and `failed` also cover a protocol turn that ended while the agent stays live.
 */
export const SlackSessionState = Schema.Literals([
  "starting",
  "running",
  "waiting",
  "completed",
  "failed",
  "stopped",
]);
export type SlackSessionState = typeof SlackSessionState.Type;

/**
 * A file on a mention, as Slack described it (`files:read`): enough to fetch it with the bot token
 * when the mention runs, so a screenshot sent before linking still reaches the session.
 */
export const SlackPendingFile = Schema.Struct({
  id: Schema.String,
  name: Schema.NullOr(Schema.String),
  mimetype: Schema.NullOr(Schema.String),
  urlPrivate: Schema.NullOr(Schema.String),
  size: Schema.NullOr(Schema.Number),
});
export type SlackPendingFile = typeof SlackPendingFile.Type;

/**
 * The mention a link code carries ("A Slack user acts only once they have linked their account"):
 * enough to run the original request once the person has linked, so linking does not mean asking
 * twice. The thread is read again when the request runs.
 */
export const SlackPendingMention = Schema.Struct({
  channelId: Schema.String,
  /** The mention itself: the message Mend reacts to. */
  messageTs: Schema.String,
  /** The thread it was written in; null when the mention is the thread's first message. */
  threadTs: Schema.NullOr(Schema.String),
  text: Schema.String,
  /**
   * Whether the channel is a Slack Connect channel, as the event said. Absent on codes minted
   * before Mend recorded it, which the reporter treats as external.
   */
  external: Schema.optional(Schema.Boolean),
  /** The files on the mention itself. Absent on codes minted before Mend recorded them. */
  files: Schema.optional(Schema.Array(SlackPendingFile)),
});
export type SlackPendingMention = typeof SlackPendingMention.Type;

/**
 * The pg-boss queue a confirmed link feeds ("Mend then runs the request they originally made").
 * Confirming a link enqueues one `SlackLinkedMentionJob`, once per code, and the Slack runner in
 * the worker takes it from there, as if the mention had just arrived from a linked user.
 */
export const SLACK_LINKED_MENTION_JOB = "slack-linked-mention";

/** A mention that waited for its author to link, and the account it now runs as. */
export const SlackLinkedMentionJob = Schema.Struct({
  organizationId: OrganizationId,
  teamId: Schema.String,
  /** The mention's author in Slack. */
  slackUserId: Schema.String,
  /** The Mend account they linked, the session's owner. */
  userId: Schema.String,
  request: SlackPendingMention,
  /** ISO time of the link, so the runner can leave a stale request alone. */
  linkedAt: Schema.String,
});
export type SlackLinkedMentionJob = typeof SlackLinkedMentionJob.Type;
