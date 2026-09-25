import { AgentTurnId, ChangeId, ChangeLandingId, ProjectId, SessionId, Sha } from "@mend/domain";
import { ChangeLanding } from "@mend/domain/workbench";
import { describe, expect, it } from "vitest";

import {
  agentMessage,
  AGENT_MESSAGE_LIMIT,
  approvalMessage,
  channelDefaultActionId,
  channelDefaultChanged,
  channelSettingsBlockId,
  channelSettingsMessage,
  changeUrl,
  changeWords,
  clipAgentMessage,
  DIFF_FILE_LIMIT,
  diffMessages,
  disclosureFor,
  helpMessage,
  landButtonLabel,
  landedMessage,
  landingLine,
  landingStatusLines,
  landOfferMessage,
  landOfferOf,
  linkPrompt,
  linkUrl,
  notLanded,
  outsiderMessage,
  pickProjectActionId,
  planText,
  projectPicker,
  projectPickerBlockId,
  questionMessage,
  reactionFor,
  requestKeyOfPicker,
  reviewMessage,
  sessionListMessage,
  setsChannelDefault,
  SLACK_ACTIONS,
  sessionUrl,
  statusLine,
  splitDiff,
  statusMessage,
  SUMMARY_PROVENANCE,
  threadOfChannelSettings,
  type StatusInput,
} from "./format.ts";

const status: StatusInput = {
  project: "billing-api",
  source: "thread-inference",
  harness: "claude",
  branch: "mend/flaky-login-test",
  state: "running",
  recorded: true,
  change: null,
  url: "https://mend.example/sessions/s1",
};

/** Every piece of copy a message carries, for the voice checks. */
const copyOf = (message: { readonly text: string; readonly blocks: ReadonlyArray<unknown> }) =>
  JSON.stringify(message);

const VERDICTS = /\b(done|looks good|safe to merge|success(ful)?|approved|passed)\b/i;

describe("the status message", () => {
  it("reads project, why, harness, observed state and branch", () => {
    expect(statusLine(status)).toBe(
      "billing-api · from the thread · claude · running · mend/flaky-login-test",
    );
    expect(
      statusLine({
        ...status,
        source: "channel-default",
        state: "completed",
        change: { files: 4, additions: 120, deletions: 30 },
      }),
    ).toBe(
      "billing-api · channel default · claude · completed · observed · mend/flaky-login-test · 4 files · +120 −30",
    );
  });

  it("claims observed only when a run stands behind the session", () => {
    expect(statusLine({ ...status, state: "completed", recorded: false })).toContain(
      "· completed ·",
    );
    expect(statusLine({ ...status, state: "failed", recorded: true })).toContain(
      "failed · observed",
    );
    expect(statusLine({ ...status, state: "waiting" })).toContain("waiting for input");
  });

  it("counts one file in the singular", () => {
    expect(changeWords({ files: 1, additions: 2, deletions: 0 })).toBe("1 file · +2 −0");
  });

  it("carries an Open in Mend button and escapes Slack's control characters", () => {
    const message = statusMessage({ ...status, project: "a<b>&c" });
    expect(message.text).toBe(
      "a&lt;b&gt;&amp;c · from the thread · claude · running · mend/flaky-login-test",
    );
    expect(message.blocks).toEqual([
      {
        type: "section",
        text: { type: "mrkdwn", text: message.text },
        accessory: {
          type: "button",
          action_id: SLACK_ACTIONS.openSession,
          text: { type: "plain_text", text: "Open in Mend", emoji: true },
          url: "https://mend.example/sessions/s1",
        },
      },
    ]);
  });

  it("offers Switch project for the session it names, and no button otherwise", () => {
    expect(statusMessage({ ...status, switchSession: null }).blocks).toHaveLength(1);
    expect(statusMessage({ ...status, switchSession: "s1" }).blocks[1]).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_ACTIONS.switchProject,
          text: { type: "plain_text", text: "Switch project", emoji: true },
          value: "s1",
        },
      ],
    });
  });

  it("builds links from the install's web origin", () => {
    expect(sessionUrl("https://mend.example/", "s 1")).toBe("https://mend.example/sessions/s%201");
    expect(linkUrl("http://100.64.0.1:3000", "msl_abc")).toBe(
      "http://100.64.0.1:3000/slack/link/msl_abc",
    );
  });
});

describe("the reaction on the request", () => {
  it("is an hourglass while the session runs, a check when it completes, an x otherwise", () => {
    expect(reactionFor("starting")).toBe("hourglass_flowing_sand");
    expect(reactionFor("running")).toBe("hourglass_flowing_sand");
    expect(reactionFor("waiting")).toBe("hourglass_flowing_sand");
    expect(reactionFor("completed")).toBe("white_check_mark");
    expect(reactionFor("failed")).toBe("x");
    expect(reactionFor("refused")).toBe("x");
    expect(reactionFor("stopped")).toBeNull();
  });
});

describe("agent messages", () => {
  const url = "https://mend.example/sessions/s1";

  it("posts a short message whole, as Markdown", () => {
    expect(agentMessage("**Plan**\n1. read the test", url)).toEqual({
      text: "**Plan**\n1. read the test",
      blocks: [{ type: "markdown", text: "**Plan**\n1. read the test" }],
    });
  });

  it("cuts a long message at 3,000 characters on a boundary, with a link to the rest", () => {
    const words = Array.from({ length: 800 }, (_, index) => `word${index}`).join(" ");
    const clipped = clipAgentMessage(words, url);
    expect(clipped.clipped).toBe(true);
    const [body, link] = clipped.text.split("\n\n… ");
    expect(body?.length).toBeLessThanOrEqual(AGENT_MESSAGE_LIMIT);
    expect(body?.length).toBeGreaterThan(AGENT_MESSAGE_LIMIT * 0.9);
    expect(words.startsWith(`${body} `)).toBe(true);
    expect(link).toBe(`[The full message is in Mend](${url})`);
  });

  it("closes a code fence the cut leaves open", () => {
    const text = `Here is the diff:\n\`\`\`ts\n${"const a = 1;\n".repeat(400)}\`\`\``;
    const clipped = clipAgentMessage(text, url);
    const body = clipped.text.split("\n\n… ")[0] ?? "";
    expect(body.match(/^```/gm)).toHaveLength(2);
    expect(body.endsWith("\n```")).toBe(true);
  });

  it("never splits a surrogate pair", () => {
    const text = `${"a".repeat(AGENT_MESSAGE_LIMIT - 1)}😀${"b".repeat(10)}`;
    const body = clipAgentMessage(text, url).text.split("\n\n… ")[0] ?? "";
    expect(body).toBe("a".repeat(AGENT_MESSAGE_LIMIT - 1));
  });
});

describe("asking for a project", () => {
  const all = Array.from({ length: 120 }, (_, index) => ({
    id: `p${index}`,
    name: `project-${index}`,
  }));

  it("offers buttons for the likeliest projects and Other… with the full list", () => {
    const message = projectPicker({
      requestKey: "C1:1700000100.000000",
      reason: "none",
      likeliest: all.slice(0, 7),
      all,
    });
    const actions = message.blocks[1];
    expect(actions?.type).toBe("actions");
    if (actions?.type !== "actions") return;
    expect(actions.block_id).toBe(projectPickerBlockId("C1:1700000100.000000"));
    expect(requestKeyOfPicker(actions.block_id ?? "")).toBe("C1:1700000100.000000");
    const buttons = actions.elements.filter((element) => element.type === "button");
    expect(buttons.map((button) => [button.action_id, button.value])).toEqual(
      [0, 1, 2, 3, 4].map((index) => [pickProjectActionId(index), `p${index}`]),
    );
    const select = actions.elements.find((element) => element.type === "static_select");
    expect(select?.action_id).toBe(SLACK_ACTIONS.otherProject);
    expect(select?.options).toHaveLength(100);
    expect(select?.placeholder.text).toBe("Other…");
  });

  it("says why it asks", () => {
    const likeliest = all.slice(0, 2);
    expect(projectPicker({ requestKey: "k", reason: "several", likeliest, all }).text).toBe(
      "More than one project matches. Pick one to start the session.",
    );
    expect(projectPicker({ requestKey: "k", reason: "switch", likeliest, all }).text).toBe(
      "Pick the project to restart this request in. The session already started for it is stopped once the new one is created.",
    );
    expect(
      projectPicker({ requestKey: "k", reason: "none", likeliest: [], all: [] }).blocks,
    ).toHaveLength(1);
    expect(requestKeyOfPicker("something_else")).toBeNull();
  });

  it("clips a long project name to fit a button", () => {
    const long = { id: "p", name: "n".repeat(90) };
    const message = projectPicker({
      requestKey: "k",
      reason: "none",
      likeliest: [long],
      all: [long],
    });
    const actions = message.blocks[1];
    if (actions?.type !== "actions") throw new Error("expected actions");
    const button = actions.elements[0];
    expect(button?.type === "button" ? button.text.text : "").toHaveLength(75);
  });
});

describe("replies only the person sees", () => {
  it("lists the options and commands, escaped for mrkdwn", () => {
    const message = helpMessage({ botName: "mend", harnesses: ["claude", "codex"] });
    const text = message.blocks[0]?.type === "section" ? message.blocks[0].text.text : "";
    expect(text).toContain("*@mend &lt;request&gt;* starts a session for you.");
    expect(text).toContain("`with claude`, `with codex`");
    expect(text).toContain("low, medium, high, xhigh, max");
    for (const command of ["new", "list", "settings", "help"]) {
      expect(text).toContain(`\`@mend ${command}`);
    }
    expect(text).toContain("`autopr=true` or `autopr=false`");
  });

  it("asks an unlinked person to link, with a button to the link page", () => {
    const url = "https://mend.example/slack/link/msl_abc";
    const message = linkPrompt(url);
    expect(message.blocks[1]).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_ACTIONS.linkAccount,
          text: { type: "plain_text", text: "Link your Mend account", emoji: true },
          url,
          style: "primary",
        },
      ],
    });
    expect(copyOf(message)).toContain("The link works once, for 10 minutes.");
  });

  it("tells someone from another workspace who can use Mend", () => {
    expect(outsiderMessage("Acme & Co").text).toBe(
      "Only members of Acme &amp; Co can use Mend here.",
    );
  });

  it("gives no verdicts", () => {
    const messages = [
      statusMessage({
        ...status,
        state: "completed",
        change: { files: 2, additions: 1, deletions: 1 },
        switchSession: "s1",
      }),
      projectPicker({
        requestKey: "k",
        reason: "none",
        likeliest: [],
        all: [{ id: "p", name: "p" }],
      }),
      projectPicker({
        requestKey: "k",
        reason: "switch",
        likeliest: [],
        all: [{ id: "p", name: "p" }],
      }),
      helpMessage({ botName: "mend", harnesses: ["claude"] }),
      linkPrompt("https://mend.example/slack/link/x"),
      outsiderMessage("Acme"),
    ];
    for (const message of messages) expect(copyOf(message)).not.toMatch(VERDICTS);
  });
});

describe("what the reporter posts", () => {
  const url = "https://mend.example/sessions/s1";
  const settings = { showAgentMessages: true, showDiffs: false, externalChannels: false };

  it("keeps a Slack Connect channel to status and links unless the owner opens it", () => {
    expect(disclosureFor(settings, false)).toEqual({ agentMessages: true, diffs: false });
    expect(disclosureFor({ ...settings, showDiffs: true }, false)).toEqual({
      agentMessages: true,
      diffs: true,
    });
    expect(disclosureFor({ ...settings, showDiffs: true }, true)).toEqual({
      agentMessages: false,
      diffs: false,
    });
    expect(disclosureFor({ ...settings, showDiffs: true, externalChannels: true }, true)).toEqual({
      agentMessages: true,
      diffs: true,
    });
    expect(disclosureFor({ ...settings, showAgentMessages: false }, false)).toEqual({
      agentMessages: false,
      diffs: false,
    });
  });

  it("names the owner in a question, and leaves its text out where agent messages are off", () => {
    const questions = [
      {
        header: "Retry",
        question: "Keep <3 retries?",
        options: [
          { label: "Yes", description: "as today" },
          { label: "No", description: null },
        ],
      },
    ];
    const shown = questionMessage({ ownerSlackUserId: "U-alice", questions, showText: true, url });
    const body = shown.blocks[0]?.type === "section" ? shown.blocks[0].text.text : "";
    expect(body).toBe(
      "<@U-alice> the agent asks:\n*Retry* Keep &lt;3 retries?\n• Yes · as today\n• No",
    );
    expect(copyOf(shown)).toContain(`<${url}|open the session>`);
    expect(copyOf(shown)).toContain("Mention Mend here with the answer, or answer in Mend");
    const twice = questionMessage({
      ownerSlackUserId: "U-alice",
      questions: [...questions, { header: null, question: "Which branch?", options: [] }],
      showText: true,
      url,
    });
    expect(copyOf(twice)).toContain("one answer per line, in order");
    const hidden = questionMessage({
      ownerSlackUserId: "U-alice",
      questions,
      showText: false,
      url,
    });
    expect(hidden.text).toBe(
      "<@U-alice> the agent asked a question · answer it in Mend, or mention Mend here with the answer",
    );
    expect(copyOf(hidden)).not.toContain("retries");
  });

  it("words an approval as a status line with a link, its title only where allowed", () => {
    expect(
      approvalMessage({ kind: "command-approval", title: "pnpm test", showText: true, url }).text,
    ).toBe("approval requested · a command · `pnpm test` · answered in Mend");
    const hidden = approvalMessage({
      kind: "file-change-approval",
      title: "src/secret.ts",
      showText: false,
      url,
    });
    expect(hidden.text).toBe("approval requested · a file change · answered in Mend");
    expect(hidden.blocks[0]).toMatchObject({ accessory: { url } });
  });

  it("counts what the review pass drafted, zero included, with a Review in Mend button", () => {
    const review = changeUrl("https://mend.example/", "chg 1");
    expect(review).toBe("https://mend.example/changes/chg%201");
    const message = reviewMessage({
      summary: null,
      drafts: { drafts: 3, suggestions: 1 },
      url: review,
    });
    expect(message?.text).toBe("Mend read the change · 3 draft comments · 1 with a suggested edit");
    expect(message?.blocks).toHaveLength(1);
    expect(message?.blocks[0]).toMatchObject({
      accessory: {
        action_id: SLACK_ACTIONS.reviewChange,
        text: { text: "Review in Mend" },
        url: review,
      },
    });
    const counted = (drafts: number, suggestions: number) =>
      reviewMessage({ summary: null, drafts: { drafts, suggestions }, url: review })?.text;
    expect(counted(0, 0)).toBe("Mend read the change · no draft comments");
    expect(counted(1, 0)).toBe("Mend read the change · 1 draft comment");
  });

  it("leads with the tour's summary and approach, says where they came from, and ends on the count", () => {
    const review = changeUrl("https://mend.example", "chg-1");
    const message = reviewMessage({
      summary: {
        summary: "Bounds the login retry at three attempts.",
        approach: "Read the flaky test, then ran it 20 times.",
      },
      drafts: { drafts: 2, suggestions: 0 },
      url: review,
    });
    expect(message?.text).toBe("Mend read the change · 2 draft comments");
    expect(message?.blocks).toEqual([
      {
        type: "markdown",
        text: "**Summary**\nBounds the login retry at three attempts.\n\n**Approach**\nRead the flaky test, then ran it 20 times.",
      },
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: SUMMARY_PROVENANCE }],
      },
      {
        type: "section",
        text: { type: "mrkdwn", text: "Mend read the change · 2 draft comments" },
        accessory: {
          type: "button",
          action_id: SLACK_ACTIONS.reviewChange,
          text: { type: "plain_text", text: "Review in Mend", emoji: true },
          url: review,
        },
      },
    ]);

    // A tour with no approach, and no review pass: the summary and the button.
    const tourOnly = reviewMessage({
      summary: { summary: "Bounds the retry.", approach: null },
      drafts: null,
      url: review,
    });
    expect(tourOnly?.text).toBe("Mend read the change");
    expect(tourOnly?.blocks[0]).toEqual({
      type: "markdown",
      text: "**Summary**\nBounds the retry.",
    });
    expect(tourOnly?.blocks.at(-1)).toMatchObject({ accessory: { url: review } });

    // Nothing to say: no reply.
    expect(reviewMessage({ summary: null, drafts: null, url: review })).toBeNull();
  });

  it("writes a plan's todo list as a short checklist, and keeps a plan's own text", () => {
    const todoWrite = {
      type: "tool_use",
      id: "toolu_1",
      name: "TodoWrite",
      input: {
        todos: [
          { content: "Read the flaky test", status: "completed", activeForm: "Reading the test" },
          { content: "Bound the retry", status: "in_progress", activeForm: "Bounding the retry" },
          { content: "Run the suite", status: "pending", activeForm: "Running the suite" },
        ],
      },
    };
    expect(planText({ text: null, data: todoWrite })).toBe(
      "**Plan**\n- ☑ Read the flaky test\n- ☐ Bound the retry · in progress\n- ☐ Run the suite",
    );
    expect(
      planText({
        text: null,
        data: {
          type: "todo_list",
          items: [
            { text: "read the test", completed: true },
            { text: "fix it", completed: false },
          ],
        },
      }),
    ).toBe("**Plan**\n- ☑ read the test\n- ☐ fix it");
    expect(planText({ text: "1. read the test", data: todoWrite })).toBe("1. read the test");
    // A plan-kind item with nothing to show: a subagent's Task call, an empty list, no data.
    expect(
      planText({ text: null, data: { name: "Task", input: { prompt: "look around" } } }),
    ).toBeNull();
    expect(planText({ text: " ", data: { input: { todos: [] } } })).toBeNull();
    expect(planText({ text: null, data: null })).toBeNull();
  });

  it("splits a diff per file and cuts each at 3,000 characters", () => {
    const diff = [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-old",
      "+new",
      "diff --git a/gone.ts b/gone.ts",
      "deleted file mode 100644",
      "--- a/gone.ts",
      "+++ /dev/null",
      "@@ -1 +0,0 @@",
      "-bye",
      "",
    ].join("\n");
    const split = splitDiff(diff);
    expect([...split.keys()]).toEqual(["src/a.ts", "gone.ts"]);
    expect(split.get("src/a.ts")?.endsWith("+new")).toBe(true);

    const big = `diff --git a/big.ts b/big.ts\n${"+x\n".repeat(3_000)}`;
    const [message, ...more] = diffMessages(
      [
        { path: "src/a.ts", additions: 1, deletions: 1, diff: split.get("src/a.ts") ?? null },
        { path: "big.ts", additions: 3_000, deletions: 0, diff: big },
        { path: "logo.png", additions: 0, deletions: 0, diff: null },
      ],
      url,
    );
    expect(more).toEqual([]);
    expect(message?.text).toBe("diff · 3 files");
    const text = message?.blocks[0]?.type === "markdown" ? message.blocks[0].text : "";
    expect(text).toContain("**src/a.ts** · +1 −1\n\n```diff\ndiff --git a/src/a.ts");
    expect(text).toContain(`[The rest of this file's diff is in Mend](${url})`);
    expect(text).toContain("**logo.png** · +0 −0\n\nNo text diff.");
    const bigSection = text.split("**big.ts**")[1] ?? "";
    expect(bigSection.length).toBeLessThan(DIFF_FILE_LIMIT + 200);
  });

  it("names the files past the first twenty by count, and splits at Slack's limit", () => {
    const files = Array.from({ length: 23 }, (_, index) => ({
      path: `f${index}.ts`,
      additions: 1,
      deletions: 0,
      diff: `diff --git a/f${index}.ts b/f${index}.ts\n${"+y\n".repeat(1_400)}`,
    }));
    const messages = diffMessages(files, url);
    expect(messages.length).toBeGreaterThan(1);
    for (const message of messages) {
      const text = message.blocks[0]?.type === "markdown" ? message.blocks[0].text : "";
      expect(text.length).toBeLessThanOrEqual(12_000);
    }
    const last = messages.at(-1);
    const text = last?.blocks[0]?.type === "markdown" ? last.blocks[0].text : "";
    expect(text.endsWith(`3 more files are in [Mend](${url}).`)).toBe(true);
  });

  it("gives no verdicts", () => {
    const messages = [
      questionMessage({ ownerSlackUserId: "U1", questions: [], showText: true, url }),
      approvalMessage({ kind: "tool-permission", title: null, showText: true, url }),
      reviewMessage({
        summary: { summary: "Bounds the retry.", approach: "Ran the test." },
        drafts: { drafts: 0, suggestions: 0 },
        url,
      }),
    ].flatMap((message) => (message === null ? [] : [message]));
    expect(messages).toHaveLength(3);
    for (const message of messages) expect(copyOf(message)).not.toMatch(VERDICTS);
  });
});

describe("landing in the thread", () => {
  const AT = new Date("2026-09-24T12:00:00.000Z");
  const landing = (
    id: string,
    outcome: ChangeLanding["outcome"],
    options: {
      readonly pullRequest?: { readonly number: number; readonly state: "open" | "merged" };
      readonly message?: string;
      readonly createdAt?: Date;
    } = {},
  ) =>
    new ChangeLanding({
      id: ChangeLandingId.make(id),
      changeId: ChangeId.make("chg-1"),
      sessionId: SessionId.make("s1"),
      projectId: ProjectId.make("p1"),
      checkpointId: null,
      checkpointRef: null,
      checkpointSha: null,
      commitSha: null,
      remoteBranch: "mend/fix-login",
      pushedSha:
        outcome === "refused" || (outcome === "failed" && options.pullRequest === undefined)
          ? null
          : Sha.make("3f2a1c0".padEnd(40, "0")),
      trigger: "automatic",
      pullRequest:
        options.pullRequest === undefined
          ? null
          : {
              number: options.pullRequest.number,
              url: `https://github.com/acme/api/pull/${options.pullRequest.number}`,
              state: options.pullRequest.state,
              observedAt: AT,
            },
      outcome,
      message: options.message ?? null,
      userId: "alice",
      createdAt: options.createdAt ?? AT,
    });
  const open412 = { number: 412, state: "open" } as const;

  it("reads a pull request opened outside Mend as such, and from whose fork", () => {
    const adopted = new ChangeLanding({
      ...landing("l-adopted", "adopted", { pullRequest: { number: 367, state: "merged" } }),
      pushedSha: null,
      trigger: "adopted",
      pullRequestCrossRepository: true,
      pullRequestHeadOwner: "anna",
    });
    expect(landingLine(adopted, [])).toBe(
      "pull request #367 · merged · opened outside Mend · from anna's fork",
    );
    const onOrigin = new ChangeLanding({ ...adopted, pullRequestCrossRepository: false });
    expect(landingLine(onOrigin, [])).toBe("pull request #367 · merged · opened outside Mend");
  });

  it("reads a landing as the branch and the pull request, opened then updated", () => {
    const first = landing("l1", "pull-request", { pullRequest: open412 });
    expect(landingLine(first, [])).toBe("pushed · mend/fix-login · pull request #412 · opened");
    expect(landingLine(landing("l2", "pull-request", { pullRequest: open412 }), [first])).toBe(
      "pushed · mend/fix-login · pull request #412 · updated",
    );
    // What the landing reported doing wins: it may have adopted a pull request the agent opened.
    expect(landingLine(first, [], "updated")).toBe(
      "pushed · mend/fix-login · pull request #412 · updated",
    );
    expect(
      landingLine(
        landing("l3", "pull-request", { pullRequest: { number: 412, state: "merged" } }),
        [first],
      ),
    ).toBe("pushed · mend/fix-login · pull request #412 · merged");
    expect(landingLine(landing("l4", "pushed"), [])).toBe("pushed · mend/fix-login");
  });

  it("gives a refusal or a failure in the remote's words, on one line", () => {
    expect(
      landingLine(
        landing("l1", "refused", {
          message: "remote: GH006: Protected branch update failed\n ! [remote rejected]",
        }),
        [],
      ),
    ).toBe(
      "push refused · mend/fix-login · remote: GH006: Protected branch update failed ! [remote rejected]",
    );
    expect(landingLine(landing("l2", "failed", { message: "the checkpoint failed" }), [])).toBe(
      "landing failed · the checkpoint failed",
    );
    expect(
      landingLine(
        new ChangeLanding({
          ...landing("l3", "failed", { message: "gh: not logged in" }),
          pushedSha: Sha.make("a".repeat(40)),
        }),
        [],
      ),
    ).toBe("pushed · mend/fix-login · pull request step failed · gh: not logged in");
    expect(landingLine(landing("l4", "refused", { message: "  " }), [])).toBe(
      "push refused · mend/fix-login · no reason given",
    );
  });

  it("states the latest landing, and a turn that did not land until a landing answers it", () => {
    const question = { landing: "question", intentSource: "read", endedAt: AT } as const;
    expect(landingStatusLines({ landings: [], latestTurn: question })).toEqual([
      "changes not landed · the request read as a question",
    ]);
    const earlier = landing("l1", "pull-request", {
      pullRequest: open412,
      createdAt: new Date(AT.getTime() - 60_000),
    });
    expect(landingStatusLines({ landings: [earlier], latestTurn: question })).toEqual([
      "pushed · mend/fix-login · pull request #412 · opened",
      "changes not landed · the request read as a question",
    ]);
    const answered = landing("l2", "pull-request", { pullRequest: open412 });
    expect(landingStatusLines({ landings: [answered, earlier], latestTurn: question })).toEqual([
      "pushed · mend/fix-login · pull request #412 · updated",
    ]);
    expect(
      landingStatusLines({
        landings: [answered],
        latestTurn: { landing: "attempted", intentSource: "unread", endedAt: AT },
      }),
    ).toEqual(["pushed · mend/fix-login · pull request #412 · opened", "intent not read"]);
    expect(landingStatusLines({ landings: [], latestTurn: null })).toEqual([]);
  });

  it("offers to land a turn that did not, once per turn, until a landing answers it", () => {
    const turn = { id: AgentTurnId.make("turn-3"), landing: "off", endedAt: AT } as const;
    const offer = landOfferOf({ sessionId: "s1", turn, landings: [] });
    expect(offer).toEqual({ sessionId: "s1", turnId: "turn-3", reason: "off", updates: false });
    expect(landButtonLabel({ updates: false })).toBe("Push and open pull request");
    expect(
      landOfferOf({
        sessionId: "s1",
        turn,
        landings: [landing("l1", "pull-request", { pullRequest: open412, createdAt: new Date(0) })],
      })?.updates,
    ).toBe(true);
    expect(landButtonLabel({ updates: true })).toBe("Push and update pull request");
    expect(landOfferOf({ sessionId: "s1", turn, landings: [landing("l2", "pushed")] })).toBeNull();
    for (const decided of ["attempted", "skipped", null] as const) {
      expect(
        landOfferOf({ sessionId: "s1", turn: { ...turn, landing: decided }, landings: [] }),
      ).toBeNull();
    }
    expect(landOfferOf({ sessionId: "s1", turn: null, landings: [] })).toBeNull();
  });

  it("puts the offer's button on a reply everyone sees, naming the owner it acts for", () => {
    const offer = { sessionId: "s1", turnId: "t1", reason: "not-owner", updates: false } as const;
    const message = landOfferMessage(offer, "U-alice");
    expect(message.text).toBe("changes not landed · the turn was not sent by the owner");
    expect(message.blocks[1]).toEqual({
      type: "actions",
      elements: [
        {
          type: "button",
          action_id: SLACK_ACTIONS.landChange,
          text: { type: "plain_text", text: "Push and open pull request", emoji: true },
          value: "s1",
          style: "primary",
        },
      ],
    });
    expect(copyOf(message)).toContain("<@U-alice>");

    const reply = reviewMessage({
      summary: null,
      drafts: { drafts: 1, suggestions: 0 },
      url: "https://mend.example/changes/chg-1",
      offer: { offer, ownerSlackUserId: "U-alice" },
    });
    expect(reply?.text).toBe("Mend read the change · 1 draft comment");
    expect(JSON.stringify(reply)).toContain(SLACK_ACTIONS.landChange);
    // With nothing else to say, the reply is the offer.
    expect(
      reviewMessage({
        summary: null,
        drafts: null,
        url: "https://mend.example/changes/chg-1",
        offer: { offer, ownerSlackUserId: "U-alice" },
      }),
    ).toEqual(message);
  });

  it("carries the landing under the status line, and gives no verdicts", () => {
    const message = statusMessage({
      ...status,
      state: "completed",
      landing: ["pushed · mend/fix-login · pull request #412 · opened"],
    });
    expect(message.text).toBe(
      `${statusLine({ ...status, state: "completed" })}\npushed · mend/fix-login · pull request #412 · opened`,
    );
    const messages = [
      message,
      landOfferMessage(
        { sessionId: "s1", turnId: "t1", reason: "question", updates: true },
        "U-alice",
      ),
      notLanded("the session is gone"),
      landedMessage("pushed · mend/fix-login · pull request #412 · opened", null),
      landedMessage(
        "pushed · mend/fix-login · pull request #412 · opened",
        "https://github.com/acme/api/pull/412",
      ),
    ];
    for (const each of messages) expect(copyOf(each)).not.toMatch(VERDICTS);
  });
});

describe("@mend settings", () => {
  const projects = Array.from({ length: 7 }, (_, index) => ({
    id: `p-${index}`,
    name: `project-${index}`,
  }));

  it("shows the channel default, with a button per project, Other… and Clear", () => {
    const message = channelSettingsMessage({
      threadTs: "1.1",
      current: { project: "billing-api", setBy: "<@U-bob>", setOn: "2026-09-23" },
      projects,
    });
    expect(message.text).toBe("channel default · billing-api · set by <@U-bob> on 2026-09-23");
    const actions = message.blocks[1];
    expect(actions?.type === "actions" ? actions.block_id : null).toBe(
      channelSettingsBlockId("1.1"),
    );
    const ids = actions?.type === "actions" ? actions.elements.map((e) => e.action_id) : [];
    expect(ids).toEqual([
      ...Array.from({ length: 5 }, (_, index) => channelDefaultActionId(index)),
      SLACK_ACTIONS.otherChannelDefault,
      SLACK_ACTIONS.clearChannelDefault,
    ]);
    expect(ids.filter(setsChannelDefault)).toHaveLength(6);
    expect(setsChannelDefault(SLACK_ACTIONS.clearChannelDefault)).toBe(false);
    expect(threadOfChannelSettings(channelSettingsBlockId("1.1"))).toBe("1.1");
    expect(threadOfChannelSettings(projectPickerBlockId("1.1/1.1"))).toBeNull();
  });

  it("says when there is no default, hides a project the person cannot see, and offers no Clear then", () => {
    const none = channelSettingsMessage({ threadTs: "1.1", current: null, projects: [] });
    expect(none.text).toBe("channel default · none");
    expect(none.blocks).toHaveLength(1);
    expect(copyOf(none)).toContain("No shared projects you can see to set it to.");
    const hidden = channelSettingsMessage({
      threadTs: "1.1",
      current: { project: null, setBy: "a member", setOn: "2026-09-23" },
      projects: projects.slice(0, 2),
    });
    expect(hidden.text).toContain("a project you cannot see");
    expect(copyOf(hidden)).not.toContain(SLACK_ACTIONS.otherChannelDefault);
    expect(channelDefaultChanged("web").text).toBe("channel default · web · set by you");
    expect(channelDefaultChanged(null).text).toBe("channel default · cleared by you");
  });
});

describe("@mend list", () => {
  it("lists each session with its state, channel and link, and says when there are older ones", () => {
    const message = sessionListMessage({
      sessions: [
        {
          project: "billing-api",
          label: "retry | storm",
          branch: "mend/retry",
          state: "completed",
          channelId: "C-general",
          url: "https://mend.example/sessions/s2",
        },
        {
          project: "web",
          label: null,
          branch: "mend/header",
          state: "waiting",
          channelId: "D-alice",
          url: "https://mend.example/sessions/s1",
        },
      ],
      more: true,
    });
    const body = message.blocks[0]?.type === "section" ? message.blocks[0].text.text : "";
    expect(body.split("\n")).toEqual([
      "Your sessions started from Slack, newest first:",
      "• <https://mend.example/sessions/s2|retry   storm> · billing-api · completed · <#C-general>",
      "• <https://mend.example/sessions/s1|mend/header> · web · waiting for input · <#D-alice>",
      "Older sessions are in Mend.",
    ]);
    expect(message.text).toBe("2 sessions started from Slack");
    expect(copyOf(message)).not.toMatch(VERDICTS);
    expect(sessionListMessage({ sessions: [], more: false }).text).toBe(
      "No sessions you started from Slack in this workspace.",
    );
  });
});
