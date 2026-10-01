import type { SlackThreadReach } from "@mend/domain/workbench";

import type { SlackMessage } from "./blocks.ts";

/**
 * A direct message with the bot. Only there are private projects candidates: everyone in a
 * channel, a private channel or a group DM reads what Mend posts (docs/adr/0006-slack.md, "Which
 * project a mention runs in").
 */
export const isDirectMessage = (channelId: string): boolean => channelId.startsWith("D");

/**
 * Whether a thread gets replies about its session: everyone in a channel reads the thread, so a
 * project that is not `shared` is shown there by its status message and reaction only. A direct
 * message with the bot is the requester's own.
 */
export const threadShowsReplies = (channelId: string, visibility: string): boolean =>
  isDirectMessage(channelId) || visibility === "shared";

/**
 * How far a session's thread reaches the person who asked, as the reporter writes it: nothing
 * without the install of the organization that owns the project, the status message and reaction
 * alone where replies are withheld, and replies as well otherwise.
 */
export const slackThreadReach = (input: {
  readonly installOrganizationId: string | null;
  readonly projectOrganizationId: string;
  readonly channelId: string;
  readonly visibility: string;
}): SlackThreadReach => {
  if (input.installOrganizationId !== input.projectOrganizationId) return "none";
  return threadShowsReplies(input.channelId, input.visibility) ? "replies" : "status";
};

/** What a channel's status message says once its project is private: it names nothing. */
export const PRIVATE_PROJECT_STATUS = "not shown · the project is private";

/**
 * The status message for a channel thread whose project was made private while its session ran.
 * It replaces the project, the branch and the link, so the edit takes them off the message too.
 */
export const privateProjectStatusMessage = (): SlackMessage => ({
  text: PRIVATE_PROJECT_STATUS,
  blocks: [{ type: "section", text: { type: "mrkdwn", text: PRIVATE_PROJECT_STATUS } }],
});
