/**
 * Phone notifications (Settings → Account → Notifications; `NotificationSettings` in
 * `@mend/domain/workbench`): the switches, in the frame's order, and what a saved switch says.
 * `PUT /me/notifications` saves the whole setting, so a switch sends every value with its own
 * changed.
 */

export interface NotificationValues {
  readonly needsInput: boolean;
  readonly turnFinished: boolean;
  readonly failed: boolean;
  readonly slackSessions: boolean;
}

export type NotificationKey = keyof NotificationValues;

export interface NotificationSwitch {
  readonly key: NotificationKey;
  readonly label: string;
  readonly description: string;
}

export const NOTIFICATION_SWITCHES: ReadonlyArray<NotificationSwitch> = [
  {
    key: "needsInput",
    label: "A session is waiting on you",
    description: "The agent asked you a question or wants your approval.",
  },
  {
    key: "turnFinished",
    label: "A turn finishes",
    description:
      "The agent finished a turn and is waiting for your next message. A terminal session that goes quiet doesn't send one.",
  },
  {
    key: "failed",
    label: "A session fails",
    description: "A turn or a command the agent ran failed.",
  },
  {
    key: "slackSessions",
    label: "Sessions started from Slack",
    description:
      "Also send these for sessions you started in Slack. Slack already posts their status in the thread.",
  },
];

/** What the toast says once a switch is saved. */
export const savedWords = (key: NotificationKey, on: boolean): string => {
  switch (key) {
    case "needsInput":
      return on
        ? "You'll get a notification when a session is waiting on you."
        : "You won't get a notification when a session is waiting on you.";
    case "turnFinished":
      return on
        ? "You'll get a notification when a turn finishes."
        : "You won't get a notification when a turn finishes.";
    case "failed":
      return on
        ? "You'll get a notification when a session fails."
        : "You won't get a notification when a session fails.";
    case "slackSessions":
      return on
        ? "Sessions you started in Slack send notifications too."
        : "Sessions you started in Slack don't send notifications. Slack's thread shows their status.";
  }
};

/** The whole setting to save: what the server holds, with one switch changed. */
export const withSwitch = (
  current: NotificationValues,
  key: NotificationKey,
  on: boolean,
): NotificationValues => ({
  needsInput: current.needsInput,
  turnFinished: current.turnFinished,
  failed: current.failed,
  slackSessions: current.slackSessions,
  [key]: on,
});

/** A paired device the Mend app runs on: a phone gets notifications, a desktop or browser doesn't. */
export const isPhone = (platform: string): boolean => platform === "ios" || platform === "android";
