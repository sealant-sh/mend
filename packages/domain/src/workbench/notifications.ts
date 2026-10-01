import { Schema } from "effect";

/**
 * Phone notifications (`SessionNotifierLive`, packages/jobs/src/session-notifier.ts): which news
 * about a session reaches a person's phones. A person's own setting, never an instance's or an
 * organization's.
 *
 * - `finished`: a turn the agent answered, or the session completed.
 * - `needs-input`: the agent asked a question or an approval and waits on a person.
 * - `failed`: a turn or the session failed.
 *
 * A stop is never news: the person's own stop is their own hand, and the idle stop
 * (`idle · stopped after 15 min`) is Mend's housekeeping, which the next message undoes.
 */
export const NotificationKind = Schema.Literals(["finished", "needs-input", "failed"]);
export type NotificationKind = typeof NotificationKind.Type;

/** What a person hears about on their phones. No saved row means the defaults. */
export class NotificationSettings extends Schema.Class<NotificationSettings>(
  "NotificationSettings",
)({
  /**
   * Sessions started from Slack push what their thread already shows. Off by default: the thread
   * says it, and the phone would say it twice. A failure pushes either way, because the thread
   * marks it only by editing its status line and reacting ❌, which Slack does not notify.
   */
  slackSessions: Schema.Boolean,
  turnFinished: Schema.Boolean,
  needsInput: Schema.Boolean,
  failed: Schema.Boolean,
}) {}

export const DEFAULT_NOTIFICATION_SETTINGS = new NotificationSettings({
  slackSessions: false,
  turnFinished: true,
  needsInput: true,
  failed: true,
});

/**
 * How far a session's Slack thread reaches the person who asked (docs/adr/0006-slack.md, "What
 * Mend posts, and where"):
 *
 * - `replies`: the status message, the reaction on the request, and replies (closing messages,
 *   a question naming the owner, an approval line).
 * - `status`: the status message and the reaction only. A channel thread whose project is not
 *   `shared` gets no replies.
 * - `none`: nothing is written. The app was removed, or it belongs to another organization.
 */
export const SlackThreadReach = Schema.Literals(["replies", "status", "none"]);
export type SlackThreadReach = typeof SlackThreadReach.Type;

/**
 * Whether the Slack thread already tells the person who asked. A finished turn moves the status
 * line and the reaction (✅) and, with agent messages shown, posts the closing message. A
 * question or an approval is a reply of its own. A failure is only an edit and a ❌ reaction, and
 * Slack notifies neither.
 */
export const slackThreadCarries = (reach: SlackThreadReach, kind: NotificationKind): boolean => {
  switch (kind) {
    case "finished":
      return reach !== "none";
    case "needs-input":
      return reach === "replies";
    case "failed":
      return false;
  }
};

/**
 * Whether one person's phones hear about `kind`. `slackThread` is the reach of the session's
 * Slack thread, or null for a session with none.
 */
export const notificationPushes = (input: {
  readonly kind: NotificationKind;
  readonly settings: NotificationSettings;
  readonly slackThread: SlackThreadReach | null;
}): boolean => {
  const { kind, settings, slackThread } = input;
  const wanted =
    kind === "finished"
      ? settings.turnFinished
      : kind === "needs-input"
        ? settings.needsInput
        : settings.failed;
  if (!wanted) return false;
  if (slackThread === null || settings.slackSessions) return true;
  return !slackThreadCarries(slackThread, kind);
};
