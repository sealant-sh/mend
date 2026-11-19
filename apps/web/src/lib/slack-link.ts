import { type Account, failureOf } from "./authorize.ts";

/**
 * The Slack link page (`/slack/link#<code>`, opened from Slack's "Link your Mend account" button,
 * docs/adr/0006-slack.md): what it reads and what it says. The code rides the fragment, so it
 * never reaches a server log, and only the browser can read it.
 */

/** A link code as the API previews it (`SlackLinkPreview`). */
export interface SlackLinkPreview {
  readonly teamName: string;
  readonly slackUserId: string;
  readonly slackUserName: string | null;
  readonly slackRealName: string | null;
  readonly requestText: string;
  readonly expiresAt: Date;
  readonly replacesSlackUserId: string | null;
}

/**
 * What the page shows: the link to confirm, a code that can't be used (spent, expired, unknown,
 * or for another organization), sign-in first, or a server that didn't answer.
 */
export type SlackLinkState =
  | { readonly kind: "link"; readonly account: Account; readonly preview: SlackLinkPreview }
  | { readonly kind: "unusable" }
  | { readonly kind: "sign-in" }
  | { readonly kind: "unreachable" };

/** Reads the page's state: no code is unusable at once; then who is signed in; then the code. */
export const readSlackLink = async (
  code: string | null,
  read: {
    readonly account: () => Promise<Account | null>;
    readonly preview: (code: string) => Promise<SlackLinkPreview>;
  },
): Promise<SlackLinkState> => {
  if (code === null || code.trim() === "") return { kind: "unusable" };
  let account: Account | null;
  try {
    account = await read.account();
  } catch {
    return { kind: "unreachable" };
  }
  if (account === null) return { kind: "sign-in" };
  try {
    return { kind: "link", account, preview: await read.preview(code) };
  } catch (error) {
    return { kind: failureOf(error) };
  }
};

/** The Slack person a code is for: "Ada Lovelace (@ada)", "@ada", or their id when Slack didn't say. */
export const slackPersonLabel = (
  preview: Pick<SlackLinkPreview, "slackUserId" | "slackUserName" | "slackRealName">,
): string => {
  if (preview.slackUserName === null) return preview.slackUserId;
  if (preview.slackRealName !== null && preview.slackRealName !== preview.slackUserName) {
    return `${preview.slackRealName} (@${preview.slackUserName})`;
  }
  return `@${preview.slackUserName}`;
};

/** What the page says once the link is made: whether the waiting mention was handed on. */
export const linkedLead = (requestQueued: boolean): string =>
  requestQueued
    ? "You can go back to Slack. Mend runs your request and answers in the thread."
    : "You can go back to Slack. Mend didn't start your request: mention @mend in the thread again.";
