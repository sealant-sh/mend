import { beforeEach, describe, expect, it, vi } from "vitest";

import { RequestPrompts, requestToAnswer, WRITE_AN_ANSWER } from "./answer-prompt.js";
import { MendApiError } from "./mend-http.js";
import { Answers, requestView, toastChoices, type AgentResponse } from "./request-answer.js";
import { pendingRequest, requestWait, whichDatabase } from "./test-requests.js";
import { fake, window } from "./test-vscode.js";

vi.mock("vscode", () => import("./test-vscode.js"));

beforeEach(() => fake.reset());

const NAME = "add-rate-limit";

/**
 * Mend as the prompts meet it: `listed` are the requests still pending, each respond answers as
 * `answers` says in turn, and the session reads `line` once it is read again.
 */
const mend = (
  options: {
    readonly listed?: ReadonlyArray<string>;
    readonly answers?: Array<() => Promise<void>>;
    readonly read?: () => Promise<ReadonlyArray<{ readonly id: string }>>;
    readonly line?: string;
  } = {},
) => {
  const answers = options.answers ?? [];
  const respond = vi.fn(async (_id: string, _response: AgentResponse) => {
    await (answers.shift() ?? (async () => {}))();
  });
  const pending = vi.fn(
    options.read ?? (async () => (options.listed ?? ["r1"]).map((id) => ({ id }))),
  );
  const reread = vi.fn(async (_sessionId: string) => {});
  const view = { name: NAME, line: options.line ?? "running · pnpm db:migrate" };
  const prompts = new RequestPrompts(new Answers({ pending, respond }), {
    reread,
    model: () => ({ sessions: new Map([["s", view]]) }),
  });
  return { prompts, respond, pending, reread };
};

const bash = requestView(pendingRequest());
const database = requestView(whichDatabase());
const [allow, deny] = toastChoices(bash.ask);

const quickPickItems = (call = 0): ReadonlyArray<unknown> => {
  const items = window.showQuickPick.mock.calls[call]?.[0];
  return Array.isArray(items) ? items : [];
};

const pickLabelled = (label: string) =>
  window.showQuickPick.mockImplementationOnce(async (items: unknown) =>
    Array.isArray(items) ? items.find((item) => Reflect.get(item, "label") === label) : undefined,
  );

describe("the toast's buttons", () => {
  it("are Allow, Deny and More… for a decision, and the options for a short question", () => {
    expect(toastChoices(bash.ask).map((choice) => choice.label)).toEqual([
      "Allow",
      "Deny",
      "More…",
    ]);
    expect(toastChoices(database.ask).map((choice) => choice.label)).toEqual([
      "Postgres",
      "SQLite",
      "More…",
    ]);
  });

  it("send what they say: Allow accepts, Deny declines, an option answers its question", async () => {
    const server = mend();
    if (allow === undefined || deny === undefined) throw new Error("no buttons");
    await server.prompts.chose(bash, NAME, allow);
    expect(server.respond.mock.calls).toEqual([["r1", { decision: "accept" }]]);
    const declined = mend();
    await declined.prompts.chose(bash, NAME, deny);
    expect(declined.respond.mock.calls).toEqual([["r1", { decision: "decline" }]]);
    const [postgres] = toastChoices(database.ask);
    if (postgres === undefined) throw new Error("no option");
    const answered = mend();
    await answered.prompts.chose(database, NAME, postgres);
    expect(answered.respond.mock.calls).toEqual([["r1", { answers: { q1: ["Postgres"] } }]]);
  });

  it("offer only Answer… for a question that does not fit on a toast, and nothing without one", () => {
    const many = requestView(
      whichDatabase({
        questions: [
          {
            id: "q1",
            header: null,
            question: "Which databases?",
            options: [{ label: "Postgres", description: null }],
            multiSelect: true,
          },
        ],
      }),
    );
    expect(toastChoices(many.ask).map((choice) => choice.label)).toEqual(["Answer…"]);
    expect(toastChoices(requestView(whichDatabase({ questions: null })).ask)).toEqual([]);
  });
});

describe("More…", () => {
  it("lists the three decisions under the toast's words, and sends the one she picks", async () => {
    const server = mend();
    pickLabelled("Allow for this session");
    await server.prompts.answer(bash, NAME);
    expect(quickPickItems().map((item) => Reflect.get(Object(item), "label"))).toEqual([
      "Allow once",
      "Allow for this session",
      "Deny",
    ]);
    expect(window.showQuickPick.mock.calls[0]?.[1]).toMatchObject({
      title: "add-rate-limit asks: run pnpm db:migrate?",
    });
    expect(server.respond.mock.calls).toEqual([["r1", { decision: "accept-for-session" }]]);
  });

  it("lists the question's options and a typed answer, and sends what she typed", async () => {
    const server = mend();
    pickLabelled(WRITE_AN_ANSWER);
    window.showInputBox.mockResolvedValueOnce("MySQL");
    await server.prompts.answer(database, NAME);
    expect(quickPickItems()).toEqual([
      { label: "Postgres", description: "The one in docker-compose", choice: "Postgres" },
      { label: "SQLite", choice: "SQLite" },
      { label: "Write an answer…", choice: null },
    ]);
    expect(server.respond.mock.calls).toEqual([["r1", { answers: { q1: ["MySQL"] } }]]);
  });

  it("asks each of several questions in turn, many choices where it may pick many", async () => {
    const server = mend();
    const two = requestView(
      whichDatabase({
        questions: [
          {
            id: "q1",
            header: null,
            question: "Which database?",
            options: [{ label: "Postgres", description: null }],
            multiSelect: false,
          },
          {
            id: "q2",
            header: null,
            question: "Which caches?",
            options: [{ label: "Redis", description: null }],
            multiSelect: true,
          },
        ],
      }),
    );
    pickLabelled("Postgres");
    window.showQuickPick.mockImplementationOnce(async (items: unknown) =>
      Array.isArray(items) ? items : undefined,
    );
    window.showInputBox.mockResolvedValueOnce("memcached");
    await server.prompts.answer(two, NAME);
    expect(window.showQuickPick.mock.calls.map(([, options]) => options)).toMatchObject([
      { title: "add-rate-limit asks: Which database? · 1 more question (1/2)" },
      { title: "add-rate-limit asks: Which database? · 1 more question (2/2)", canPickMany: true },
    ]);
    expect(server.respond.mock.calls).toEqual([
      ["r1", { answers: { q1: ["Postgres"], q2: ["Redis", "memcached"] } }],
    ]);
  });

  it("sends nothing when she presses Escape", async () => {
    const server = mend();
    await server.prompts.answer(bash, NAME);
    pickLabelled(WRITE_AN_ANSWER);
    await server.prompts.answer(database, NAME);
    expect(server.respond).not.toHaveBeenCalled();
    expect(server.pending).not.toHaveBeenCalled();
  });

  it("opens once for two gestures at the same request", async () => {
    const server = mend();
    const shown = Promise.withResolvers<void>();
    window.showQuickPick.mockImplementationOnce(async (items: unknown) => {
      await shown.promise;
      return Array.isArray(items) ? items[0] : undefined;
    });
    const first = server.prompts.answer(bash, NAME);
    const second = server.prompts.answer(bash, NAME);
    shown.resolve();
    await Promise.all([first, second]);
    expect(window.showQuickPick).toHaveBeenCalledTimes(1);
    expect(server.respond).toHaveBeenCalledTimes(1);
  });
});

describe("the row's Answer (rule 8)", () => {
  const terminal = {
    via: "terminal" as const,
    key: "permission:2026-10-19T08:59:00.000Z",
    words: "claude needs your permission to use Bash",
    since: "2026-10-19T08:59:00.000Z",
  };

  it("opens the quick pick for a conversation she may answer, and attaches a terminal agent", () => {
    expect(requestToAnswer({ needsYou: true, wait: requestWait() })).toEqual(bash);
    expect(requestToAnswer({ needsYou: true, wait: terminal })).toBeNull();
  });

  it("answers nothing she may not answer: Ana's request without shared control", () => {
    expect(requestToAnswer({ needsYou: false, wait: requestWait() })).toBeNull();
    expect(requestToAnswer(undefined)).toBeNull();
  });
});

describe("an answer Mend no longer waits for", () => {
  it("sends nothing to a request already answered, and says how the session reads now", async () => {
    const server = mend({ listed: [], line: "running · pnpm db:migrate" });
    if (allow === undefined) throw new Error("no Allow");
    await server.prompts.chose(bash, NAME, allow);
    expect(server.respond).not.toHaveBeenCalled();
    expect(server.reread).toHaveBeenCalledWith("s");
    expect(window.setStatusBarMessage).toHaveBeenCalledWith(
      "add-rate-limit · running · pnpm db:migrate",
      5_000,
    );
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });

  it("sends one response for a double click", async () => {
    const held = Promise.withResolvers<void>();
    const server = mend({ answers: [() => held.promise] });
    if (allow === undefined) throw new Error("no Allow");
    const clicks = [
      server.prompts.chose(bash, NAME, allow),
      server.prompts.chose(bash, NAME, allow),
    ];
    held.resolve();
    await Promise.all(clicks);
    expect(server.respond).toHaveBeenCalledTimes(1);
  });
});

describe("an answer that failed", () => {
  it("offers Retry when Mend was not reached, and Retry sends the same response once", async () => {
    const server = mend({
      answers: [
        async () => {
          throw new MendApiError("Cannot reach Mend at http://mend-mini:3105.", null);
        },
      ],
    });
    window.showErrorMessage.mockResolvedValueOnce("Retry");
    if (deny === undefined) throw new Error("no Deny");
    await server.prompts.chose(bash, NAME, deny);
    expect(window.showErrorMessage.mock.calls).toEqual([
      [
        "Mend did not send your answer to add-rate-limit · Cannot reach Mend at http://mend-mini:3105.",
        "Retry",
      ],
    ]);
    expect(server.respond.mock.calls).toEqual([
      ["r1", { decision: "decline" }],
      ["r1", { decision: "decline" }],
    ]);
  });

  it("says Mend's refusal with no Retry", async () => {
    const server = mend({
      answers: [
        async () => {
          throw new MendApiError("Only Ana can answer this; send a turn instead.", 403);
        },
      ],
    });
    if (allow === undefined) throw new Error("no Allow");
    await server.prompts.chose(bash, NAME, allow);
    expect(window.showErrorMessage.mock.calls).toEqual([
      [
        "Mend did not send your answer to add-rate-limit · Only Ana can answer this; send a turn instead.",
      ],
    ]);
  });

  it("says only that Mend is offline when the re-read cannot reach it, and sends nothing", async () => {
    const server = mend({
      read: async () => {
        throw new MendApiError("Cannot reach Mend at http://mend-mini:3105.", null);
      },
    });
    if (allow === undefined) throw new Error("no Allow");
    await server.prompts.chose(bash, NAME, allow);
    expect(server.respond).not.toHaveBeenCalled();
    expect(window.setStatusBarMessage).toHaveBeenCalledWith("Mend is offline", 5_000);
    expect(window.showErrorMessage).not.toHaveBeenCalled();
  });
});
