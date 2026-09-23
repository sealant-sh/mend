import type { ProjectDto, SlackLinkPreviewDto, SlackMeDto, SlackSettingsDto } from "./api.ts";

/**
 * Pure view logic for Slack (docs/adr/0006-slack.md): Settings → Slack and the link page read
 * these, so every sentence is testable. Copy states what is set and what was observed, never a
 * verdict.
 */

type DisplaySetting = keyof Omit<SlackSettingsDto, "defaultHarness">;

/** The owner's display settings, with what each side of the switch means ("What Mend posts"). */
export const SLACK_DISPLAY_SETTINGS: ReadonlyArray<{
  readonly key: DisplaySetting;
  readonly label: string;
  readonly off: string;
  readonly on: string;
}> = [
  {
    key: "showAgentMessages",
    label: "Agent messages",
    off: "Status, reactions and links only.",
    on: "Also the plan, closing messages and questions.",
  },
  {
    key: "showDiffs",
    label: "Diffs",
    off: "Changed files and line counts only.",
    on: "Also the diff of each changed file, up to 3,000 characters.",
  },
  {
    key: "externalChannels",
    label: "Slack Connect channels",
    off: "Only status and links there.",
    on: "The two settings above apply there too.",
  },
];

/** What removing the app does, stated before it happens. */
export const SLACK_REMOVAL_FACTS = [
  "Both tokens are deleted, and Mend stops reading mentions.",
  "Every Slack link and every channel's default project go with them.",
  "Sessions started from Slack stay, with their record and their origin.",
] as const;

/** The person's link, in one line. */
export const slackLinkLine = (me: SlackMeDto): string => {
  if (me.workspace === null) return "Slack is not connected to this organization.";
  if (me.link === null) {
    return `Not linked in ${me.workspace.teamName}. Mention @mend there; Mend answers with a link only you see.`;
  }
  return `Linked as Slack user ${me.link.slackUserId} in ${me.workspace.teamName}.`;
};

/**
 * The projects a person's default can name: those they can see. A private one only ever answers
 * in a direct message with the bot, since a channel is read by people who cannot see it.
 */
export const defaultProjectOptions = (
  projects: ReadonlyArray<Pick<ProjectDto, "id" | "name" | "visibility">>,
): ReadonlyArray<{ readonly id: ProjectDto["id"]; readonly label: string }> =>
  projects
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .map((project) => ({
      id: project.id,
      label:
        project.visibility === "private"
          ? `${project.name} · private, direct messages only`
          : project.name,
    }));

/** The Slack person a link code is for, as the link page names them. */
export const slackPersonLabel = (
  preview: Pick<SlackLinkPreviewDto, "slackUserId" | "slackUserName" | "slackRealName">,
): string => {
  if (preview.slackUserName === null) return preview.slackUserId;
  if (preview.slackRealName !== null && preview.slackRealName !== preview.slackUserName) {
    return `${preview.slackUserName} (${preview.slackRealName})`;
  }
  return preview.slackUserName;
};

/** What the link page says once the link is made. */
export const linkedLine = (teamName: string, requestQueued: boolean): string =>
  requestQueued
    ? `Linked in ${teamName}. Mend runs your request and answers in the thread.`
    : `Linked in ${teamName}. Your request was not queued; mention @mend in the thread again.`;
