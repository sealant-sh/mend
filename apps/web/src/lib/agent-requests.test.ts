import type { AgentInputQuestionDto, AgentItemDto } from "@mend/agent-conversation";
import { describe, expect, it } from "vitest";

import {
  answererOf,
  answered,
  approvalShape,
  approvalTitle,
  NOTHING_PICKED,
  OTHER,
  pick,
  questionHint,
  questionPlaceholder,
  requestAnswers,
  settledLine,
  waitingLine,
  waitingRequest,
} from "./agent-requests.ts";
import type { RequestView } from "./conversation.ts";

const retry: AgentInputQuestionDto = {
  id: "q-retry",
  header: "Stripe sends a 409 when a request with the same key is still being processed.",
  question: "Should the retry back off on a 409?",
  options: [
    { label: "Treat 409 as final", description: "Return the error." },
    { label: "Back off and retry", description: "Retry 3 times." },
  ],
  multiSelect: false,
};

const wait: AgentInputQuestionDto = {
  id: "q-wait",
  header: null,
  question: "How long should a refund wait in total?",
  options: [
    { label: "2 seconds", description: null },
    { label: "10 seconds", description: null },
  ],
  multiSelect: false,
};

const request = (overrides: Partial<RequestView>): RequestView => ({
  id: "r-1",
  turnId: "t-1",
  kind: "user-input",
  title: null,
  detail: null,
  questions: [retry],
  status: "pending",
  decision: null,
  answers: null,
  createdAt: "2026-11-18T10:00:00.000Z",
  decidedBy: null,
  decidedAt: null,
  ...overrides,
});

const names = (id: string) => (id === "grace" ? "Grace Hopper" : null);

describe("the request the card answers", () => {
  it("is the oldest still waiting", () => {
    const newer = request({ id: "r-2", createdAt: "2026-11-18T10:05:00.000Z" });
    const older = request({ id: "r-1", createdAt: "2026-11-18T10:01:00.000Z" });
    const settled = request({
      id: "r-0",
      status: "resolved",
      createdAt: "2026-11-18T09:00:00.000Z",
    });
    expect(waitingRequest([newer, settled, older])?.id).toBe("r-1");
    expect(waitingRequest([settled])).toBeUndefined();
  });
});

describe("picking a choice", () => {
  it("replaces the choice on a question that takes one, and Something else clears it", () => {
    const first = pick(NOTHING_PICKED, "Treat 409 as final", false);
    const second = pick(first, "Back off and retry", false);
    expect(second).toEqual({ choices: ["Back off and retry"], other: false });
    expect(pick(second, OTHER, false)).toEqual({ choices: [], other: true });
  });

  it("toggles each choice on a question that takes several", () => {
    const both = pick(pick(NOTHING_PICKED, "Charges", true), "Refunds", true);
    expect(both.choices).toEqual(["Charges", "Refunds"]);
    expect(pick(both, "Charges", true).choices).toEqual(["Refunds"]);
  });

  it("is an answer on its own, while Something else needs words", () => {
    expect(answered(pick(NOTHING_PICKED, "Back off and retry", false), "")).toBe(true);
    expect(answered(pick(NOTHING_PICKED, OTHER, false), "  ")).toBe(false);
    expect(answered(pick(NOTHING_PICKED, OTHER, false), "Only for charges")).toBe(true);
    expect(answered(NOTHING_PICKED, "Only for charges")).toBe(true);
  });
});

describe("the answers a request is sent", () => {
  it("sends a choice with the note written beside it", () => {
    const picked = { [retry.id]: pick(NOTHING_PICKED, "Back off and retry", false) };
    expect(requestAnswers([retry], picked, {}, "Cap the total wait at 2 seconds.")).toEqual({
      [retry.id]: ["Back off and retry", "Cap the total wait at 2 seconds."],
    });
  });

  it("sends the person's own words when they picked Something else", () => {
    const picked = { [retry.id]: pick(NOTHING_PICKED, OTHER, false) };
    expect(requestAnswers([retry], picked, {}, " Only for charges. ")).toEqual({
      [retry.id]: ["Only for charges."],
    });
  });

  it("sends every part of a question with two parts, the last note going with both", () => {
    const picked = {
      [retry.id]: pick(NOTHING_PICKED, "Back off and retry", false),
      [wait.id]: pick(NOTHING_PICKED, "2 seconds", false),
    };
    expect(requestAnswers([retry, wait], picked, { [retry.id]: "" }, "Refunds only.")).toEqual({
      [retry.id]: ["Back off and retry", "Refunds only."],
      [wait.id]: ["2 seconds", "Refunds only."],
    });
  });

  it("keeps an earlier part's own words with that part alone", () => {
    const picked = {
      [retry.id]: pick(NOTHING_PICKED, OTHER, false),
      [wait.id]: pick(NOTHING_PICKED, OTHER, false),
    };
    expect(
      requestAnswers([retry, wait], picked, { [retry.id]: "Charges only" }, "Five seconds"),
    ).toEqual({ [retry.id]: ["Charges only"], [wait.id]: ["Five seconds"] });
  });
});

describe("what the card says while a question waits", () => {
  const at = (picked: typeof NOTHING_PICKED, words = "", step = 0, steps = 1) =>
    questionHint({ question: retry, picked, words, step, steps });

  it("says what each key does, as the frames do", () => {
    expect(at(NOTHING_PICKED)).toBe("Press 1, 2 or 3, or write your own answer below.");
    const chosen = pick(NOTHING_PICKED, "Back off and retry", false);
    expect(at(chosen)).toBe("Press Enter to send your answer, or add a note below.");
    expect(at(chosen, "Cap it")).toBe("Press Enter to send your answer with the note.");
    expect(at(pick(NOTHING_PICKED, OTHER, false))).toBe(
      "Write your answer below, then press Enter.",
    );
    expect(at(NOTHING_PICKED, "", 0, 2)).toBe(
      "Pick one, or write your own answer and press Enter, to go on to question 2.",
    );
    expect(at(chosen, "", 1, 2)).toBe("Press Enter to send both answers. A note goes with both.");
  });

  it("says what the field takes", () => {
    const chosen = pick(NOTHING_PICKED, "Back off and retry", false);
    expect(questionPlaceholder({ picked: NOTHING_PICKED, last: true, steps: 1 })).toBe(
      "Or write your own answer",
    );
    expect(questionPlaceholder({ picked: chosen, last: true, steps: 1 })).toBe(
      "Add a note (optional)",
    );
    expect(questionPlaceholder({ picked: chosen, last: true, steps: 2 })).toBe(
      "Add a note to both answers (optional)",
    );
  });

  it("says in the conversation whose answer it waits for", () => {
    expect(waitingLine(request({}), null)).toBe("Asked you a question · Waiting for your answer");
    expect(waitingLine(request({ questions: [retry, wait] }), null)).toBe(
      "Asked you 2 questions · Waiting for your answers",
    );
    const command = request({
      kind: "command-approval",
      questions: null,
      detail: { command: "ls" },
    });
    expect(waitingLine(command, "Ada Lovelace")).toBe(
      "Wants to run a command · Waiting for Ada Lovelace's approval",
    );
  });
});

describe("what an approval shows", () => {
  it("shows Codex's command and where it runs", () => {
    const shape = approvalShape(
      request({
        kind: "command-approval",
        questions: null,
        title: "terraform apply",
        detail: { command: ["terraform", "apply"], cwd: "/workspace/infra", reason: null },
      }),
      [],
    );
    expect(shape).toEqual({
      kind: "command",
      command: "terraform apply",
      cwd: "/workspace/infra",
      rule: null,
      reason: null,
    });
    expect(approvalTitle("Codex", shape)).toBe("Codex wants to run a command");
  });

  it("shows Claude's Bash command and the rule Always allow would add", () => {
    const shape = approvalShape(
      request({
        kind: "tool-permission",
        questions: null,
        detail: {
          toolName: "Bash",
          command: "terraform apply -target=module.staging_db",
          description: "Apply the staging change",
          suggestions: [
            { type: "addRules", rules: [{ toolName: "Bash", ruleContent: "terraform apply:*" }] },
          ],
        },
      }),
      [],
    );
    expect(shape).toMatchObject({ kind: "command", rule: "terraform apply" });
  });

  it("shows Claude's edit as a diff of what it replaces and writes", () => {
    const shape = approvalShape(
      request({
        kind: "tool-permission",
        questions: null,
        detail: {
          toolName: "Edit",
          file_path: "src/retry.ts",
          old_string: "sleep(100)",
          new_string: "sleep(backoff(attempt))",
        },
      }),
      [],
    );
    expect(shape).toEqual({
      kind: "edit",
      files: [{ path: "src/retry.ts", diff: "-sleep(100)\n+sleep(backoff(attempt))" }],
      reason: null,
    });
  });

  it("reads Codex's edit from the turn's file-change item", () => {
    const item: AgentItemDto = {
      id: "i-1",
      seq: 4,
      turnId: "t-1",
      kind: "file-change",
      status: "in-progress",
      title: "migrations/0043.sql",
      text: null,
      data: { changes: [{ path: "migrations/0043.sql", diff: "@@ -1 +1 @@\n-a\n+b" }] },
      createdAt: "2026-11-18T10:00:00.000Z",
      updatedAt: "2026-11-18T10:00:00.000Z",
    };
    const shape = approvalShape(
      request({ kind: "file-change-approval", questions: null, detail: { itemId: "x" } }),
      [item],
    );
    expect(shape).toEqual({
      kind: "edit",
      files: [{ path: "migrations/0043.sql", diff: "@@ -1 +1 @@\n-a\n+b" }],
      reason: null,
    });
  });

  it("shows an MCP tool by its server and name, with its arguments", () => {
    const shape = approvalShape(
      request({
        kind: "tool-permission",
        questions: null,
        detail: {
          toolName: "mcp__linear__create_issue",
          team: "NW",
          labels: ["payments"],
          suggestions: [],
        },
      }),
      [],
    );
    expect(shape).toEqual({
      kind: "tool",
      name: "linear · create_issue",
      server: "linear",
      entries: [
        ["team", "NW"],
        ["labels", '["payments"]'],
      ],
    });
  });
});

describe("a settled request's line", () => {
  it("names the choice the viewer made, and the note as their words", () => {
    const settled = request({
      status: "resolved",
      answers: { [retry.id]: ["Back off and retry", "Cap the wait"] },
      decidedBy: "ada",
    });
    expect(settledLine(settled, answererOf(settled, "ada", names))).toEqual({
      title: "You chose Back off and retry",
      code: null,
      description: "Should the retry back off on a 409?",
      words: "Cap the wait",
    });
  });

  it("says when someone else answered in their own words", () => {
    const settled = request({
      status: "resolved",
      answers: { [retry.id]: ["Only for charges"] },
      decidedBy: "grace",
    });
    expect(settledLine(settled, answererOf(settled, "ada", names))).toMatchObject({
      title: "Grace Hopper answered in their own words",
      words: "Only for charges",
    });
  });

  it("says how an approval was decided, naming the command", () => {
    const base = request({
      kind: "command-approval",
      questions: null,
      title: "terraform apply",
      detail: { command: "terraform apply" },
      status: "resolved",
      decidedBy: "ada",
    });
    const you = { kind: "you" } as const;
    expect(settledLine({ ...base, decision: "accept" }, you)).toMatchObject({
      title: "You approved the command once",
      code: "terraform apply",
    });
    expect(settledLine({ ...base, decision: "accept-for-session" }, you).title).toBe(
      "You allowed the command for this session",
    );
    expect(settledLine({ ...base, decision: "decline" }, you)).toMatchObject({
      title: "You denied",
      code: "terraform apply",
    });
  });

  it("says a request nobody answered was withdrawn", () => {
    const withdrawn = request({ status: "cancelled" });
    expect(settledLine(withdrawn, answererOf(withdrawn, "ada", names)).title).toBe(
      "The question was withdrawn",
    );
  });
});
