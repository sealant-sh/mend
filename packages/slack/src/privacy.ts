import type { SlackMessage } from "./blocks.ts";

/**
 * A direct message with the bot. Only there are private projects candidates: everyone in a
 * channel, a private channel or a group DM reads what Mend posts (docs/adr/0006-slack.md, "Which
 * project a mention runs in").
 */
export const isDirectMessage = (channelId: string): boolean => channelId.startsWith("D");

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
