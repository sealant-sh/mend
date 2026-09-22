import { Schema } from "effect";

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
});
export type SlackPendingMention = typeof SlackPendingMention.Type;
