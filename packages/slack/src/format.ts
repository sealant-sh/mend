import {
  EFFORT_LEVELS,
  landingFactLine,
  landingFacts,
  notLandedReasonOf,
  type AgentTurn,
  type ChangeLanding,
  type DecidedTurn,
  type NotLandedReason,
  type SlackProjectSource,
  type SlackSessionState,
} from "@mend/domain/workbench";
import { Option, Schema } from "effect";

import type {
  ActionsBlock,
  ButtonElement,
  PlainText,
  SlackBlock,
  SlackMessage,
  StaticSelectElement,
} from "./blocks.ts";
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
  setChannelDefault: "mend_set_channel_default",
  otherChannelDefault: "mend_other_channel_default",
  clearChannelDefault: "mend_clear_channel_default",
  landChange: "mend_land_change",
  openPullRequest: "mend_open_pull_request",
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

/** Settings → Slack, where a person sets their own default project and links their account. */
export const settingsUrl = (webOrigin: string): string => `${origin(webOrigin)}/settings#slack`;

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
  /**
   * The change's landing as the thread reads it (`landingStatusLines`), each on a line of its own
   * under the status line; absent or empty says nothing about landing.
   */
  readonly landing?: ReadonlyArray<string>;
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
 * requester picks. Once the change lands, or a turn's change does not, the lines under it say so
 * (docs/adr/0007-landing.md, "What the thread sees"), and a later landing edits them in place.
 */
export const statusMessage = (input: StatusInput): SlackMessage => {
  const line = [statusLine(input), ...(input.landing ?? [])].map(escapeSlack).join("\n");
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

/** Claude's `TodoWrite` call, as the adapter records it: the tool-use block with its todo list. */
const TodoWriteCall = Schema.Struct({
  input: Schema.Struct({
    todos: Schema.Array(Schema.Struct({ content: Schema.String, status: Schema.String })),
  }),
});

/** Codex's todo list item: its entries and whether each is done. */
const CodexTodoList = Schema.Struct({
  items: Schema.Array(Schema.Struct({ text: Schema.String, completed: Schema.Boolean })),
});

const decodeTodoWrite = Schema.decodeUnknownOption(TodoWriteCall);
const decodeCodexTodoList = Schema.decodeUnknownOption(CodexTodoList);

const checklist = (entries: ReadonlyArray<{ readonly text: string; readonly mark: string }>) =>
  entries.length === 0
    ? null
    : ["**Plan**", ...entries.map((entry) => `- ${entry.mark} ${entry.text.trim()}`)].join("\n");

/**
 * A plan item as text: its own text when the agent wrote one (Codex's plan), or its todo list as a
 * short checklist (Claude's `TodoWrite`, Codex's todo list), ☑ for done and ☐ for the rest. Null
 * when the item carries neither.
 */
export const planText = (item: {
  readonly text: string | null;
  readonly data: unknown;
}): string | null => {
  if (item.text !== null && item.text.trim() !== "") return item.text;
  const claude = decodeTodoWrite(item.data);
  if (Option.isSome(claude)) {
    return checklist(
      claude.value.input.todos.map((todo) => ({
        text: todo.status === "in_progress" ? `${todo.content} · in progress` : todo.content,
        mark: todo.status === "completed" ? "☑" : "☐",
      })),
    );
  }
  const codex = decodeCodexTodoList(item.data);
  if (Option.isSome(codex)) {
    return checklist(
      codex.value.items.map((entry) => ({
        text: entry.text,
        mark: entry.completed ? "☑" : "☐",
      })),
    );
  }
  return null;
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
 * A question the agent asked, as a reply that names the owner. The owner answers with their next
 * mention in the thread, or in Mend. With agent messages off, the reply names the owner and says
 * there is a question, without its text.
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
      `${owner} the agent asked a question · answer it in Mend, or mention Mend here with the answer`,
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
          {
            type: "mrkdwn",
            text: `${input.questions.length > 1 ? "Mention Mend here with one answer per line, in order" : "Mention Mend here with the answer"}, or answer in Mend: <${input.url}|open the session>`,
          },
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

// ---------------------------------------------------------------------------
// Landing (docs/adr/0007-landing.md): the status message's landing lines, and the offer to land a
// change a completed turn did not.
// ---------------------------------------------------------------------------

/** The remote's or `gh`'s words run to a line of their own; the status message cuts them here. */
const LANDING_WORDS_LIMIT = 300;

/** The remote's own words for a refusal or a failure, on one line. */
const remoteWords = (message: string | null): string => {
  const words = (message ?? "").replace(/\s+/g, " ").trim();
  return clip(words === "" ? "no reason given" : words, LANDING_WORDS_LIMIT);
};

type LandingSeen = Pick<
  ChangeLanding,
  "outcome" | "remoteBranch" | "pushedSha" | "pullRequest" | "message"
>;

/**
 * One landing as the thread reads it: `pushed · mend/fix-login · pull request #412 · opened`,
 * `… · updated` when an earlier landing recorded the same pull request, its state once it is
 * merged or closed, or the refusal or failure in the remote's own words. `earlier` are the
 * change's landings before this one; `how` is what the landing itself reported doing with the
 * pull request, when the caller has it, and wins over what the record implies.
 */
export const landingLine = (
  landing: LandingSeen,
  earlier: ReadonlyArray<LandingSeen>,
  how: "opened" | "updated" | null = null,
): string => {
  if (landing.outcome === "refused") {
    return `push refused · ${landing.remoteBranch} · ${remoteWords(landing.message)}`;
  }
  if (landing.pushedSha === null) return `landing failed · ${remoteWords(landing.message)}`;
  const pushed = `pushed · ${landing.remoteBranch}`;
  if (landing.outcome === "failed") {
    return `${pushed} · pull request step failed · ${remoteWords(landing.message)}`;
  }
  const pullRequest = landing.pullRequest;
  if (pullRequest === null) return pushed;
  const recorded = earlier.some((before) => before.pullRequest?.number === pullRequest.number);
  const done =
    pullRequest.state === "open" ? (how ?? (recorded ? "updated" : "opened")) : pullRequest.state;
  return `${pushed} · pull request #${pullRequest.number} · ${done}`;
};

/**
 * What the status message says about landing: the latest landing, then, when the latest turn Mend
 * decided about left its change unlanded and nothing landed since, why (`changes not landed · the
 * request read as a question`), or `intent not read` when a landing went ahead without a reading.
 * `landings` are newest first.
 */
export const landingStatusLines = (input: {
  readonly landings: ReadonlyArray<ChangeLanding>;
  readonly latestTurn: DecidedTurn | null;
}): ReadonlyArray<string> => {
  const [latest, ...earlier] = input.landings;
  const facts = landingFacts({
    landings: input.landings,
    originCommitsUnseen: null,
    filesChangedSinceLanding: null,
    agentRefUpdates: [],
    latestTurn: input.latestTurn,
  });
  const turnLines = facts.flatMap((fact) =>
    fact._tag === "not-landed" || fact._tag === "intent-not-read"
      ? [landingFactLine(fact, new Date(0))]
      : [],
  );
  return [...(latest === undefined ? [] : [landingLine(latest, earlier)]), ...turnLines];
};

/** A completed turn's change that did not land, which the owner can land from the thread. */
export interface LandOffer {
  readonly sessionId: string;
  /** The turn whose change it is: the thread offers it once. */
  readonly turnId: string;
  readonly reason: NotLandedReason;
  /** A pull request Mend opened is still open, and the landing updates it. */
  readonly updates: boolean;
}

/**
 * The offer for the latest turn Mend decided about, or null: only when the turn left its change
 * unlanded (a question, `autopr=false`, automatic landing off, someone other than the owner) and
 * no landing was made since it ended. `landings` are newest first.
 */
export const landOfferOf = (input: {
  readonly sessionId: string;
  readonly turn: Pick<AgentTurn, "id" | "landing" | "endedAt"> | null;
  readonly landings: ReadonlyArray<Pick<ChangeLanding, "createdAt" | "pullRequest">>;
}): LandOffer | null => {
  const { turn } = input;
  if (turn === null || turn.endedAt === null) return null;
  const reason = notLandedReasonOf(turn.landing);
  if (reason === null) return null;
  const endedAt = turn.endedAt;
  if (input.landings.some((landing) => landing.createdAt >= endedAt)) return null;
  return {
    sessionId: input.sessionId,
    turnId: turn.id,
    reason,
    updates: input.landings.some((landing) => landing.pullRequest?.state === "open"),
  };
};

/** The button's words: the ADR's, or "update" once an open pull request is recorded. */
export const landButtonLabel = (offer: Pick<LandOffer, "updates">): string =>
  offer.updates ? "Push and update pull request" : "Push and open pull request";

/**
 * The offer's blocks: why the change did not land, and "Push and open pull request". Everyone in
 * the thread sees the button; it lands only for the session's owner, as them, and tells anyone
 * else so where only they read it.
 */
export const landOfferBlocks = (
  offer: LandOffer,
  ownerSlackUserId: string,
): ReadonlyArray<SlackBlock> => [
  {
    type: "section",
    text: {
      type: "mrkdwn",
      text: escapeSlack(landingFactLine({ _tag: "not-landed", reason: offer.reason }, new Date(0))),
    },
  },
  {
    type: "actions",
    elements: [
      {
        type: "button",
        action_id: SLACK_ACTIONS.landChange,
        text: plain(landButtonLabel(offer)),
        value: offer.sessionId,
        style: "primary",
      },
    ],
  },
  {
    type: "context",
    elements: [
      {
        type: "mrkdwn",
        text: `lands as the session's owner, <@${ownerSlackUserId}> · only they can use it`,
      },
    ],
  },
];

/** The offer as a reply of its own. */
export const landOfferMessage = (offer: LandOffer, ownerSlackUserId: string): SlackMessage => ({
  text: escapeSlack(landingFactLine({ _tag: "not-landed", reason: offer.reason }, new Date(0))),
  blocks: landOfferBlocks(offer, ownerSlackUserId),
});

/** A press of the button that landed nothing, in the reason's own words; only the presser sees it. */
export const notLanded = (reason: string): SlackMessage => {
  const text = escapeSlack(`not pushed · ${reason}`);
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
};

/** What a landing from the button did, as its line; only the owner who pressed it sees this. */
export const landedMessage = (line: string, pullRequestUrl: string | null): SlackMessage => {
  const text = escapeSlack(line);
  return pullRequestUrl === null
    ? { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] }
    : lineWithButton(text, {
        type: "button",
        action_id: SLACK_ACTIONS.openPullRequest,
        text: plain("Open the pull request"),
        url: pullRequestUrl,
      });
};

/** The review tour's own words, as Mend wrote them with inference from the diff and the record. */
export interface TourSummary {
  readonly summary: string;
  readonly approach: string | null;
}

/** What the machine review pass drafted over the change. */
export interface DraftCounts {
  readonly drafts: number;
  readonly suggestions: number;
}

/** Says where the summary came from, under it. */
export const SUMMARY_PROVENANCE =
  "summary · written by Mend using inference on the diff and the session record";

/**
 * The end-of-session reply, once Mend's passes over the change have run: the review tour's summary
 * and approach, then what the review pass drafted, with a "Review in Mend" button. Either part may
 * be missing: the summary where agent messages are not shown or the tour did not run, the count
 * where no review pass ran. Zero drafts is said out loud; it is an outcome, not silence. When the
 * turn's change did not land, the reply ends with the offer to land it (`landOfferBlocks`). Null
 * when there is none of these.
 */
export const reviewMessage = (input: {
  readonly summary: TourSummary | null;
  readonly drafts: DraftCounts | null;
  readonly url: string;
  readonly offer?: { readonly offer: LandOffer; readonly ownerSlackUserId: string } | null;
}): SlackMessage | null => {
  const { summary, drafts } = input;
  const offer = input.offer ?? null;
  if (summary === null && drafts === null) {
    return offer === null ? null : landOfferMessage(offer.offer, offer.ownerSlackUserId);
  }
  const offered = offer === null ? [] : landOfferBlocks(offer.offer, offer.ownerSlackUserId);
  const counted =
    drafts === null
      ? ""
      : ` · ${
          drafts.drafts === 0
            ? "no draft comments"
            : `${drafts.drafts} draft ${drafts.drafts === 1 ? "comment" : "comments"}`
        }${drafts.suggestions === 0 ? "" : ` · ${drafts.suggestions} with a suggested edit`}`;
  const review = lineWithButton(`Mend read the change${counted}`, {
    type: "button",
    action_id: SLACK_ACTIONS.reviewChange,
    text: plain("Review in Mend"),
    url: input.url,
  });
  if (summary === null) return { text: review.text, blocks: [...review.blocks, ...offered] };
  const approach = summary.approach?.trim() ?? "";
  const body = [
    `**Summary**\n${summary.summary.trim()}`,
    ...(approach === "" ? [] : [`**Approach**\n${approach}`]),
  ].join("\n\n");
  return {
    text: review.text,
    blocks: [
      { type: "markdown", text: clip(body, AGENT_MESSAGE_LIMIT) },
      { type: "context", elements: [{ type: "mrkdwn", text: SUMMARY_PROVENANCE }] },
      ...review.blocks,
      ...offered,
    ],
  };
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
// `@mend settings`: the channel's default project.
// ---------------------------------------------------------------------------

/** A channel-default button's `action_id`: unique within its block. */
export const channelDefaultActionId = (index: number): string =>
  `${SLACK_ACTIONS.setChannelDefault}_${index}`;

/** Whether an `action_id` sets the channel default: a button, or the "Other…" select. */
export const setsChannelDefault = (actionId: string): boolean =>
  actionId === SLACK_ACTIONS.otherChannelDefault ||
  actionId.startsWith(`${SLACK_ACTIONS.setChannelDefault}_`);

const CHANNEL_SETTINGS_BLOCK_PREFIX = "mend_channel:";

/**
 * The settings reply's `block_id`, which carries the thread the command was made in, so the
 * confirmation lands beside it: an interaction on an ephemeral message does not say.
 */
export const channelSettingsBlockId = (threadTs: string): string =>
  `${CHANNEL_SETTINGS_BLOCK_PREFIX}${threadTs}`;

/** The thread in a settings reply's `block_id`; null for any other block. */
export const threadOfChannelSettings = (blockId: string): string | null =>
  blockId.startsWith(CHANNEL_SETTINGS_BLOCK_PREFIX)
    ? blockId.slice(CHANNEL_SETTINGS_BLOCK_PREFIX.length)
    : null;

export interface ChannelDefaultView {
  /** The project's name; null when the person asking cannot see it. */
  readonly project: string | null;
  /** Who set it, as Slack markup (`<@U…>`) or plain words. */
  readonly setBy: string;
  /** When, as `YYYY-MM-DD`. */
  readonly setOn: string;
}

/**
 * `@mend settings` in a channel: its default project, and buttons to set or clear it. Any member
 * may, and the choices are the shared projects that member can see.
 */
export const channelSettingsMessage = (input: {
  readonly threadTs: string;
  readonly current: ChannelDefaultView | null;
  readonly projects: ReadonlyArray<PickableProject>;
}): SlackMessage => {
  const current =
    input.current === null
      ? "channel default · none"
      : `channel default · ${input.current.project === null ? "a project you cannot see" : escapeSlack(input.current.project)} · set by ${input.current.setBy} on ${input.current.setOn}`;
  const about =
    "A mention here runs in the channel default when neither the request nor the thread names a project. Any member sets it, from the shared projects they can see.";
  const clear: ReadonlyArray<ButtonElement> =
    input.current === null
      ? []
      : [
          {
            type: "button",
            action_id: SLACK_ACTIONS.clearChannelDefault,
            text: plain("Clear"),
            value: "clear",
          },
        ];
  const buttons = input.projects.slice(0, PICKER_BUTTON_LIMIT).map(
    (project, index): ButtonElement => ({
      type: "button",
      action_id: channelDefaultActionId(index),
      text: plain(clip(project.name, 75)),
      value: project.id,
    }),
  );
  const other: ReadonlyArray<StaticSelectElement> =
    input.projects.length > PICKER_BUTTON_LIMIT
      ? [
          {
            type: "static_select",
            action_id: SLACK_ACTIONS.otherChannelDefault,
            placeholder: plain("Other…"),
            options: input.projects.slice(0, PICKER_OPTION_LIMIT).map((project) => ({
              text: plain(clip(project.name, 75)),
              value: project.id,
            })),
          },
        ]
      : [];
  const elements = [...buttons, ...other, ...clear];
  const choices: ReadonlyArray<ActionsBlock> =
    elements.length === 0
      ? []
      : [{ type: "actions", block_id: channelSettingsBlockId(input.threadTs), elements }];
  const none = input.projects.length === 0 ? "\nNo shared projects you can see to set it to." : "";
  return {
    text: current,
    blocks: [
      { type: "section", text: { type: "mrkdwn", text: `${current}\n${about}${none}` } },
      ...choices,
    ],
  };
};

/** The channel default after a click: set to a project, or cleared. */
export const channelDefaultChanged = (project: string | null): SlackMessage => {
  const text =
    project === null
      ? "channel default · cleared by you"
      : `channel default · ${escapeSlack(project)} · set by you`;
  return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
};

// ---------------------------------------------------------------------------
// `@mend list`: the person's sessions started from Slack.
// ---------------------------------------------------------------------------

export interface ListedSession {
  readonly project: string;
  /** The session's label; its branch stands in until it has one. */
  readonly label: string | null;
  readonly branch: string;
  readonly state: SlackSessionState;
  /** The channel its thread is in. */
  readonly channelId: string;
  /** The session in Mend. */
  readonly url: string;
}

/** How many sessions `@mend list` shows; the rest are in Mend. */
export const LISTED_SESSIONS = 10;

/** Link text Slack cannot misread: no `|` or `>`, and entities escaped. */
const linkText = (text: string): string => escapeSlack(text.replace(/[|>]/g, " "));

/** `@mend list`: newest first, each with its state, channel and a link to it in Mend. */
export const sessionListMessage = (input: {
  readonly sessions: ReadonlyArray<ListedSession>;
  /** Whether there are older sessions than the listed ones. */
  readonly more: boolean;
}): SlackMessage => {
  if (input.sessions.length === 0) {
    const text = "No sessions you started from Slack in this workspace.";
    return { text, blocks: [{ type: "section", text: { type: "mrkdwn", text } }] };
  }
  const lines = input.sessions.map(
    (session) =>
      `• <${session.url}|${linkText(session.label ?? session.branch)}> · ${escapeSlack(session.project)} · ${stateWords(session.state, false)} · <#${session.channelId}>`,
  );
  const more = input.more ? ["Older sessions are in Mend."] : [];
  const text = clip(
    ["Your sessions started from Slack, newest first:", ...lines, ...more].join("\n"),
    AGENT_MESSAGE_LIMIT,
  );
  return {
    text: `${input.sessions.length} ${input.sessions.length === 1 ? "session" : "sessions"} started from Slack`,
    blocks: [{ type: "section", text: { type: "mrkdwn", text } }],
  };
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
    "• `autopr=true` or `autopr=false`: whether this request's change is pushed and its pull request opened when a turn completes; the Slack app's setting otherwise",
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
