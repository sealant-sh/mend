/**
 * Settings → Account → Connected apps (docs/adr/0025: your own links to Slack and Executor, and
 * your Doppler token, ADR 0014): what each row says, from what the server answers. No part of a
 * Doppler token is ever shown, not even its last characters.
 */

const day = (at: Date): string =>
  at.toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** The Slack row's line. */
export const slackLine = (
  me: {
    readonly workspace: { readonly teamName: string } | null;
    readonly link: { readonly slackUserId: string; readonly createdAt: Date } | null;
  },
  organization: string,
): string => {
  if (me.workspace === null) {
    return `${organization} hasn't connected Slack. An owner connects it in Integrations.`;
  }
  if (me.link === null) {
    return `Not linked. Mention @mend in ${me.workspace.teamName}'s Slack, and Mend sends you a link only you see.`;
  }
  return `Linked as Slack user ${me.link.slackUserId} in ${me.workspace.teamName} on ${day(me.link.createdAt)}. You can start sessions from Slack, and your Slack sessions use your logins and Your automation.`;
};

/** The Executor row's line, for an organization whose Executor is set up. */
export const executorLine = (
  state: "unlinked" | "active" | "refused",
  organization: string,
): string => {
  switch (state) {
    case "active":
      return "Linked. Executor's tools act as you, and sessions ask you before a tool call that needs approval.";
    case "refused":
      return "Executor refused your link. Link again to use Executor's tools as you.";
    case "unlinked":
      return `Not linked. Until you link, your sessions use ${organization}'s shared Executor account.`;
  }
};

/** The Doppler row's line: when the token was saved, and whether any project has a config yet. */
export const dopplerLine = (status: {
  readonly connected: boolean;
  readonly updatedAt: Date | null;
  readonly mappings: ReadonlyArray<unknown>;
}): string => {
  if (!status.connected)
    return "Not connected. Connect it to use your Doppler secrets in sessions.";
  const when = status.updatedAt === null ? "Connected." : `Connected on ${day(status.updatedAt)}.`;
  return status.mappings.length === 0
    ? `${when} You haven't picked a config in any project yet.`
    : `${when} Your sessions can run doppler run in the projects where you've picked a config.`;
};

/** What disconnecting deletes, counted from the configs the server says are picked. */
export const disconnectDopplerWords = (picked: number): string => {
  const configs =
    picked === 0
      ? "You haven't picked a config in any project."
      : `Mend deletes your token and the config you picked in ${picked === 1 ? "1 project" : `${picked} projects`}.`;
  return picked === 0
    ? `Mend deletes your token. ${configs} Sessions that are already running keep working until they stop.`
    : `${configs} Sessions that are already running keep working until they stop.`;
};
