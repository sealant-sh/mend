import {
  EFFORT_LEVELS,
  type SlackProjectSource,
  type SlackSessionState,
} from "@mend/domain/workbench";

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
  reviewChange: "mend_review_change",
  switchProject: "mend_switch_project",
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

/** The change's review page. */
export const changeUrl = (webOrigin: string, changeId: string): string =>
  `${origin(webOrigin)}/changes/${encodeURIComponent(changeId)}`;

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
export type { SlackSessionState };

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
  /**
   * The session "Switch project" restarts in another project, while that is offered (until the
   * session's first turn completes; see `switchOffered`). Absent or null offers no button.
   */
  readonly switchSession?: string | null;
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

/**
 * The one status message, which Mend edits in place as the session moves. Until the first turn
 * completes it also offers "Switch project", which restarts the request in a project the
 * requester picks.
 */
export const statusMessage = (input: StatusInput): SlackMessage => {
  const line = escapeSlack(statusLine(input));
  const switchSession = input.switchSession ?? null;
  const switching: ReadonlyArray<ActionsBlock> =
    switchSession === null
      ? []
      : [
          {
            type: "actions",
            elements: [
              {
                type: "button",
                action_id: SLACK_ACTIONS.switchProject,
                text: plain("Switch project"),
                value: switchSession,
              },
            ],
          },
        ];
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
      ...switching,
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
// What the reporter posts as the session moves.
// ---------------------------------------------------------------------------

/**
 * How much of a session goes into a thread (docs/adr/0006-slack.md, the display settings). Status,
 * reactions and links always do. In a Slack Connect channel the other two apply only when the
 * owner turned on external channels.
 */
export interface SlackDisclosure {
  /** The plan, closing messages and the text of questions and approvals. */
  readonly agentMessages: boolean;
  /** The diff of each changed file. */
  readonly diffs: boolean;
}

export const disclosureFor = (
  settings: {
    readonly showAgentMessages: boolean;
    readonly showDiffs: boolean;
    readonly externalChannels: boolean;
  },
  external: boolean,
): SlackDisclosure => {
  const here = !external || settings.externalChannels;
  return {
    agentMessages: here && settings.showAgentMessages,
    diffs: here && settings.showDiffs,
  };
};

const openButton = (url: string): ButtonElement => ({
  type: "button",
  action_id: SLACK_ACTIONS.openSession,
  text: plain("Open in Mend"),
  url,
});

/** One line of copy with a link button beside it. */
const lineWithButton = (line: string, button: ButtonElement): SlackMessage => ({
  text: line,
  blocks: [{ type: "section", text: { type: "mrkdwn", text: line }, accessory: button }],
});

export interface AgentQuestion {
  readonly header: string | null;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string | null;
  }>;
}

/**
 * A question the agent asked, as a reply that names the owner. Answers are given in Mend. With
 * agent messages off, the reply names the owner and says there is a question, without its text.
 */
export const questionMessage = (input: {
  readonly ownerSlackUserId: string;
  readonly questions: ReadonlyArray<AgentQuestion>;
  readonly showText: boolean;
  readonly url: string;
}): SlackMessage => {
  const owner = `<@${input.ownerSlackUserId}>`;
  if (!input.showText || input.questions.length === 0) {
    return lineWithButton(
      `${owner} the agent asked a question · it is answered in Mend`,
      openButton(input.url),
    );
  }
  const body = input.questions
    .map((question) =>
      [
        question.header === null || question.header === ""
          ? escapeSlack(question.question)
          : `*${escapeSlack(question.header)}* ${escapeSlack(question.question)}`,
        ...question.options.map(
          (option) =>
            `• ${escapeSlack(option.label)}${option.description === null || option.description === "" ? "" : ` · ${escapeSlack(option.description)}`}`,
        ),
      ].join("\n"),
    )
    .join("\n\n");
  const text = clip(`${owner} the agent asks:\n${body}`, AGENT_MESSAGE_LIMIT);
  return {
    text: clip(`${owner} the agent asks: ${escapeSlack(input.questions[0]?.question ?? "")}`, 300),
    blocks: [
      { type: "section", text: { type: "mrkdwn", text } },
      {
        type: "context",
        elements: [
          { type: "mrkdwn", text: `It is answered in Mend: <${input.url}|open the session>` },
        ],
      },
    ],
  };
};

/** What an approval asks for, in the status line's words. */
const APPROVAL_WORDS: Readonly<Record<string, string>> = {
  "command-approval": "a command",
  "file-change-approval": "a file change",
  "tool-permission": "a tool",
};

/**
 * An approval the agent asked for, as a status line with a link: it is answered in Mend. The
 * request's own title (a command, a path) appears only where agent messages do.
 */
export const approvalMessage = (input: {
  readonly kind: string;
  readonly title: string | null;
  readonly showText: boolean;
  readonly url: string;
}): SlackMessage => {
  const what = APPROVAL_WORDS[input.kind] ?? "a request";
  const title =
    input.showText && input.title !== null && input.title.trim() !== ""
      ? ` · \`${clip(input.title.trim().replaceAll("`", "'"), 200)}\``
      : "";
  return lineWithButton(
    escapeSlack(`approval requested · ${what}`) +
      (title === "" ? "" : escapeSlack(title)) +
      " · answered in Mend",
    openButton(input.url),
  );
};

/**
 * After the machine review pass (Mend reads the change): what it drafted, with a "Review in Mend"
 * button. Zero is said out loud; it is an outcome, not silence.
 */
export const reviewMessage = (input: {
  readonly drafts: number;
  readonly suggestions: number;
  readonly url: string;
}): SlackMessage => {
  const drafted =
    input.drafts === 0
      ? "no draft comments"
      : `${input.drafts} draft ${input.drafts === 1 ? "comment" : "comments"}`;
  const suggested = input.suggestions === 0 ? "" : ` · ${input.suggestions} with a suggested edit`;
  return lineWithButton(`Mend read the change · ${drafted}${suggested}`, {
    type: "button",
    action_id: SLACK_ACTIONS.reviewChange,
    text: plain("Review in Mend"),
    url: input.url,
  });
};

/** Each changed file's diff is cut at this many characters. */
export const DIFF_FILE_LIMIT = 3_000;
/** How many files' diffs a thread gets; the rest are in Mend. */
export const DIFF_FILES_SHOWN = 20;
/** Slack's cap on the Markdown blocks of one message. */
const MARKDOWN_MESSAGE_LIMIT = 12_000;

export interface FileDiff {
  readonly path: string;
  readonly additions: number;
  readonly deletions: number;
  /** The file's unified diff; null when there is none to show (a binary file). */
  readonly diff: string | null;
}

/**
 * A rendered `git diff`, split per file. The path is the new one (`+++ b/…`), or the old one for
 * a deleted file.
 */
export const splitDiff = (diff: string): ReadonlyMap<string, string> => {
  const files = new Map<string, string>();
  const chunks = diff.split(/^(?=diff --git )/m).filter((chunk) => chunk.startsWith("diff --git "));
  for (const chunk of chunks) {
    const added = /^\+\+\+ b\/(.+)$/m.exec(chunk)?.[1];
    const removed = /^--- a\/(.+)$/m.exec(chunk)?.[1];
    const header = /^diff --git a\/.+ b\/(.+)$/m.exec(chunk)?.[1];
    const path = added ?? removed ?? header;
    if (path !== undefined) files.set(path, chunk.trimEnd());
  }
  return files;
};

/** A fence the diff's own text cannot close. */
const fenced = (text: string): string =>
  `\`\`\`diff\n${text.replaceAll("```", "``\u200b`")}\n\`\`\``;

/**
 * The diff of each changed file, each cut at 3,000 characters, as few replies as Slack's Markdown
 * limit allows. Files past the first twenty are named by count, with the rest in Mend.
 */
export const diffMessages = (
  files: ReadonlyArray<FileDiff>,
  url: string,
): ReadonlyArray<SlackMessage> => {
  const sections = files.slice(0, DIFF_FILES_SHOWN).map((file) => {
    const title = `**${file.path}** · +${file.additions} −${file.deletions}`;
    if (file.diff === null) return `${title}\n\nNo text diff.`;
    const cut = clip(file.diff, DIFF_FILE_LIMIT);
    const rest = cut === file.diff ? "" : `\n\n… [The rest of this file's diff is in Mend](${url})`;
    return `${title}\n\n${fenced(cut)}${rest}`;
  });
  const hidden = files.length - DIFF_FILES_SHOWN;
  if (hidden > 0) {
    sections.push(`${hidden} more ${hidden === 1 ? "file is" : "files are"} in [Mend](${url}).`);
  }
  const messages: Array<Array<string>> = [];
  for (const section of sections) {
    const current = messages.at(-1);
    const size = current?.reduce((total, part) => total + part.length + 2, 0) ?? 0;
    if (current !== undefined && size + section.length <= MARKDOWN_MESSAGE_LIMIT) {
      current.push(section);
    } else {
      messages.push([section]);
    }
  }
  const count = `${files.length} ${files.length === 1 ? "file" : "files"}`;
  return messages.map((parts) => ({
    text: escapeSlack(`diff · ${count}`),
    blocks: [{ type: "markdown", text: parts.join("\n\n") }],
  }));
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

/** Why Mend asks for a project, as the picker words it. */
const PICKER_REASONS = {
  none: "No project named in the request or the thread, and no default set. Pick one to start the session.",
  several: "More than one project matches. Pick one to start the session.",
  switch:
    "Pick the project to restart this request in. The session already started for it is stopped once the new one is created.",
} as const;

/**
 * Buttons for the likeliest projects, and "Other…" with the full list. `requestKey` identifies the
 * request the choice answers (see {@link projectPickerBlockId}). `reason` says why Mend asks:
 * nothing answered, several projects did, or the requester is switching the session's project.
 */
export const projectPicker = (input: {
  readonly requestKey: string;
  readonly reason: keyof typeof PICKER_REASONS;
  readonly likeliest: ReadonlyArray<PickableProject>;
  readonly all: ReadonlyArray<PickableProject>;
}): SlackMessage => {
  if (input.all.length === 0) {
    const text = "No projects to pick from. In a channel, Mend offers shared projects only.";
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  const text = PICKER_REASONS[input.reason];
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
