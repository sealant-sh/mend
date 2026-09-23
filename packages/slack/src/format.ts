import { EFFORT_LEVELS, type SlackProjectSource } from "@mend/domain/workbench";

import type { ActionsBlock, ButtonElement, PlainText, SlackMessage } from "./blocks.ts";
import { escapeSlack } from "./markup.ts";

/**
 * What Mend posts into a thread (docs/adr/0006-slack.md, "What Mend posts, and where"). The copy
 * states what was observed and gives no verdict: `completed · observed`, never "done" or "looks
 * good".
 */

/** The `action_id`s of Mend's interactive elements, which the runner routes on. */
export const SLACK_ACTIONS = {
  openSession: "mend_open_session",
  pickProject: "mend_pick_project",
  otherProject: "mend_other_project",
  linkAccount: "mend_link_account",
} as const;

/** A project button's `action_id`: unique within its block, and starts with `pickProject`. */
export const pickProjectActionId = (index: number): string =>
  `${SLACK_ACTIONS.pickProject}_${index}`;

const PICKER_BLOCK_PREFIX = "mend_pick:";

/**
 * The picker's `block_id`, which carries the request the choice answers: Slack sends the block id
 * back with the interaction, and an option's own value holds only 75 characters.
 */
export const projectPickerBlockId = (requestKey: string): string =>
  `${PICKER_BLOCK_PREFIX}${requestKey}`;

/** The request key in a picker's `block_id`; null for any other block. */
export const requestKeyOfPicker = (blockId: string): string | null =>
  blockId.startsWith(PICKER_BLOCK_PREFIX) ? blockId.slice(PICKER_BLOCK_PREFIX.length) : null;

const plain = (text: string): PlainText => ({ type: "plain_text", text, emoji: true });

/** Up to `limit` characters, with an ellipsis when cut; never splits a surrogate pair. */
const clip = (text: string, limit: number): string => {
  if (text.length <= limit) return text;
  let end = limit - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return `${text.slice(0, end)}…`;
};

// ---------------------------------------------------------------------------
// Links. Mend builds every link from the web origin the install recorded.
// ---------------------------------------------------------------------------

const origin = (webOrigin: string): string => webOrigin.replace(/\/+$/, "");

export const sessionUrl = (webOrigin: string, sessionId: string): string =>
  `${origin(webOrigin)}/sessions/${encodeURIComponent(sessionId)}`;

export const linkUrl = (webOrigin: string, code: string): string =>
  `${origin(webOrigin)}/slack/link/${encodeURIComponent(code)}`;

// ---------------------------------------------------------------------------
// The status message and the reaction.
// ---------------------------------------------------------------------------

/** Why the status message names its project. */
export const PROJECT_SOURCE_WORDS: Readonly<Record<SlackProjectSource, string>> = {
  message: "named in the request",
  "thread-session": "the thread's session",
  "thread-link": "from a link in the thread",
  "thread-inference": "from the thread",
  "channel-default": "channel default",
  "personal-default": "personal default",
  picked: "picked",
};

/** The session as the thread hears it; the reporter folds session and turn state into this. */
export type SlackSessionState =
  | "starting"
  | "running"
  | "waiting"
  | "completed"
  | "failed"
  | "stopped";

/**
 * The state as the status message words it. `recorded` keeps "observed" honest: it is claimed
 * only when a Sealant run stands behind the session.
 */
export const stateWords = (state: SlackSessionState, recorded: boolean): string => {
  switch (state) {
    case "starting":
      return "starting";
    case "running":
      return "running";
    case "waiting":
      return "waiting for input";
    case "completed":
      return recorded ? "completed · observed" : "completed";
    case "failed":
      return recorded ? "failed · observed" : "failed";
    case "stopped":
      return "stopped";
  }
};

export interface ChangeCounts {
  readonly files: number;
  readonly additions: number;
  readonly deletions: number;
}

/** `4 files · +120 −30`. */
export const changeWords = (change: ChangeCounts): string =>
  `${change.files} ${change.files === 1 ? "file" : "files"} · +${change.additions} −${change.deletions}`;

export interface StatusInput {
  readonly project: string;
  readonly source: SlackProjectSource;
  readonly harness: string;
  /** The session's worktree branch. */
  readonly branch: string;
  readonly state: SlackSessionState;
  readonly recorded: boolean;
  /** The change against its base, once there is one. */
  readonly change: ChangeCounts | null;
  /** The session in Mend. */
  readonly url: string;
}

/** `billing-api · from the thread · claude · running · mend/flaky-login-test`. */
export const statusLine = (input: StatusInput): string =>
  [
    input.project,
    PROJECT_SOURCE_WORDS[input.source],
    input.harness,
    stateWords(input.state, input.recorded),
    input.branch,
    ...(input.change === null ? [] : [changeWords(input.change)]),
  ].join(" · ");

/** The one status message, which Mend edits in place as the session moves. */
export const statusMessage = (input: StatusInput): SlackMessage => {
  const line = escapeSlack(statusLine(input));
  return {
    text: line,
    blocks: [
      {
        type: "section",
        text: { type: "mrkdwn", text: line },
        accessory: {
          type: "button",
          action_id: SLACK_ACTIONS.openSession,
          text: plain("Open in Mend"),
          url: input.url,
        },
      },
    ],
  };
};

/** Every reaction Mend puts on a request, so the reporter can take the previous one off. */
export const SLACK_REACTIONS = ["hourglass_flowing_sand", "white_check_mark", "x"] as const;
export type SlackReaction = (typeof SLACK_REACTIONS)[number];

/**
 * The reaction on the request: ⏳ while the session runs, ✅ when it completes, ❌ when it fails or
 * the request is refused. A stopped session is the person's own hand and carries none.
 */
export const reactionFor = (state: SlackSessionState | "refused"): SlackReaction | null => {
  switch (state) {
    case "starting":
    case "running":
    case "waiting":
      return "hourglass_flowing_sand";
    case "completed":
      return "white_check_mark";
    case "failed":
    case "refused":
      return "x";
    case "stopped":
      return null;
  }
};

// ---------------------------------------------------------------------------
// Agent messages.
// ---------------------------------------------------------------------------

export const AGENT_MESSAGE_LIMIT = 3_000;

/**
 * An agent message cut at 3,000 characters, with a link to the rest. The cut prefers a line or a
 * word boundary in the last tenth, and a code fence it leaves open is closed.
 */
export const clipAgentMessage = (
  text: string,
  url: string,
): { readonly text: string; readonly clipped: boolean } => {
  const body = text.trim();
  if (body.length <= AGENT_MESSAGE_LIMIT) return { text: body, clipped: false };
  let cut = body.slice(0, AGENT_MESSAGE_LIMIT);
  const floor = AGENT_MESSAGE_LIMIT * 0.9;
  const line = cut.lastIndexOf("\n");
  const word = cut.lastIndexOf(" ");
  if (line >= floor) cut = cut.slice(0, line);
  else if (word >= floor) cut = cut.slice(0, word);
  const last = cut.charCodeAt(cut.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut = cut.slice(0, -1);
  cut = cut.trimEnd();
  const fences = cut.match(/^```/gm)?.length ?? 0;
  const closed = fences % 2 === 1 ? `${cut}\n\`\`\`` : cut;
  return { text: `${closed}\n\n… [The full message is in Mend](${url})`, clipped: true };
};

/** An agent message as a reply in the thread, in a Markdown block so its formatting survives. */
export const agentMessage = (text: string, url: string): SlackMessage => {
  const clipped = clipAgentMessage(text, url);
  return {
    text: escapeSlack(clip(clipped.text, AGENT_MESSAGE_LIMIT)),
    blocks: [{ type: "markdown", text: clipped.text }],
  };
};

// ---------------------------------------------------------------------------
// Asking for a project.
// ---------------------------------------------------------------------------

export interface PickableProject {
  readonly id: string;
  readonly name: string;
}

/** How many of the likeliest projects get a button of their own. */
export const PICKER_BUTTON_LIMIT = 5;
/** Slack's cap on a select's options. */
export const PICKER_OPTION_LIMIT = 100;

/**
 * Buttons for the likeliest projects, and "Other…" with the full list. `requestKey` identifies the
 * request the choice answers (see {@link projectPickerBlockId}). `reason` says why Mend asks:
 * nothing answered, or several projects did.
 */
export const projectPicker = (input: {
  readonly requestKey: string;
  readonly reason: "none" | "several";
  readonly likeliest: ReadonlyArray<PickableProject>;
  readonly all: ReadonlyArray<PickableProject>;
}): SlackMessage => {
  if (input.all.length === 0) {
    const text = "No projects to pick from. In a channel, Mend offers shared projects only.";
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  const text =
    input.reason === "none"
      ? "No project named in the request or the thread, and no default set. Pick one to start the session."
      : "More than one project matches. Pick one to start the session.";
  const buttons: ReadonlyArray<ButtonElement> = input.likeliest
    .slice(0, PICKER_BUTTON_LIMIT)
    .map((project, index) => ({
      type: "button",
      action_id: pickProjectActionId(index),
      text: plain(clip(project.name, 75)),
      value: project.id,
    }));
  const actions: ActionsBlock = {
    type: "actions",
    block_id: projectPickerBlockId(input.requestKey),
    elements: [
      ...buttons,
      {
        type: "static_select",
        action_id: SLACK_ACTIONS.otherProject,
        placeholder: plain("Other…"),
        options: input.all.slice(0, PICKER_OPTION_LIMIT).map((project) => ({
          text: plain(clip(project.name, 75)),
          value: project.id,
        })),
      },
    ],
  };
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }, actions] };
};

// ---------------------------------------------------------------------------
// Replies only the person sees.
// ---------------------------------------------------------------------------

/** `@mend help`: the options and commands. */
export const helpMessage = (input: {
  readonly botName: string;
  readonly harnesses: ReadonlyArray<string>;
}): SlackMessage => {
  const at = `@${input.botName}`;
  const harnesses = input.harnesses.map((harness) => `\`with ${harness}\``).join(", ");
  const text = [
    `*${at} <request>* starts a session for you. Mend reads the thread as context and reports in it.`,
    `\`${at} fix the flaky login test\``,
    `\`${at} in billing-api with codex, make the retry limit configurable\``,
    `\`${at} project=billing-api branch=release/2.3 harness=codex effort=high make the retry limit configurable\``,
    "",
    "*Options.* Inline options win over natural ones, and a later one wins over an earlier one.",
    "• `project=` or `in <project>`: a project name, or its repository (`acme/api`)",
    "• `branch=` or `from <branch>`, `on <branch>`: the base branch; the project's default otherwise",
    `• \`harness=\` or ${harnesses}: the harness; your default otherwise`,
    "• `model=` or `with <model>`: the harness's model",
    `• \`effort=\` or \`with high effort\`: ${EFFORT_LEVELS.join(", ")}`,
    "",
    "*Commands*",
    `• \`${at} new <request>\`: another session in this thread`,
    `• \`${at} list\`: your sessions started from Slack`,
    `• \`${at} settings\`: this channel's default project`,
    `• \`${at} help\`: this message`,
    "",
    `In a thread with a session, \`${at} <request>\` is a follow-up to its latest session. A reply without a mention stays between people.`,
  ].join("\n");
  return {
    text: escapeSlack(`${at} help`),
    blocks: [{ type: "section", text: { type: "mrkdwn", text: escapeSlack(text) } }],
  };
};

/**
 * The reply to a mention from someone who has not linked their account: a button to
 * `/slack/link/<code>`. Once they link, Mend runs the request they made.
 */
export const linkPrompt = (url: string): SlackMessage => {
  const text =
    "Mend starts sessions only for a linked Mend account, and runs them as that account. Link yours and Mend runs this request. The link works once, for 10 minutes.";
  return {
    text: "Link your Mend account to start sessions from Slack.",
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "actions",
        elements: [
          {
            type: "button",
            action_id: SLACK_ACTIONS.linkAccount,
            text: plain("Link your Mend account"),
            url,
            style: "primary",
          },
        ],
      },
    ],
  };
};

/** The reply to a mention from someone outside the install's Slack workspace. */
export const outsiderMessage = (teamName: string): SlackMessage => {
  const text = `Only members of ${escapeSlack(teamName)} can use Mend here.`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
};
