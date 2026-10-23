import { describe, expect, it, vi } from "vitest";

import { MendClient } from "./client.js";
import { MendApiError } from "./mend-http.js";
import { Answers, requestView, type AgentResponse } from "./request-answer.js";
import { pendingRequest, whichDatabase } from "./test-requests.js";
import { json, serve, switchable, type Heard } from "./test-servers.js";

vi.mock("vscode", () => import("./test-vscode.js"));

describe("what a request asks", () => {
  it("says Claude's Bash permission as the command it would run", () => {
    expect(requestView(pendingRequest())).toMatchObject({
      question: "run pnpm db:migrate?",
      ask: { kind: "decision" },
    });
  });

  it("says any other tool permission by its tool", () => {
    const edit = pendingRequest({ title: "Edit", detail: { toolName: "Edit", input: {} } });
    expect(requestView(edit).question).toBe("use Edit?");
  });

  it("says Codex's command approval as its command", () => {
    const codex = pendingRequest({ kind: "command-approval", title: "pnpm test", detail: null });
    expect(requestView(codex)).toMatchObject({
      question: "run pnpm test?",
      ask: { kind: "decision" },
    });
  });

  it("asks a question in its own words, and offers its options", () => {
    const view = requestView(whichDatabase());
    expect(view.question).toBe("Which database?");
    expect(view.ask).toMatchObject({ kind: "answers", questions: [{ id: "q1" }] });
  });

  it("has nothing to answer when a user-input request came without a question", () => {
    expect(requestView(whichDatabase({ questions: null })).ask).toEqual({ kind: "unanswerable" });
  });
});

const ALLOW: AgentResponse = { decision: "accept" };

/** A server that lists `listed` as pending and answers each respond as `answers` says in turn. */
const server = (
  listed: ReadonlyArray<string>,
  answers: Array<() => Promise<void>> = [],
  read: () => Promise<ReadonlyArray<{ readonly id: string }>> = async () =>
    listed.map((id) => ({ id })),
) => {
  const pending = vi.fn(read);
  const respond = vi.fn(async (_id: string, _response: AgentResponse) => {
    await (answers.shift() ?? (async () => {}))();
  });
  return {
    pending,
    respond,
    answers: new Answers(async () => ({ pendingRequests: pending, respond })),
  };
};

const request = { id: "r1", sessionId: "s" };

describe("an answer", () => {
  it("sends nothing to a request no longer pending, and nothing again later", async () => {
    const mend = server([]);
    expect(await mend.answers.send(request, ALLOW)).toEqual({ kind: "gone" });
    expect(await mend.answers.send(request, ALLOW)).toEqual({ kind: "gone" });
    expect(mend.respond).not.toHaveBeenCalled();
    expect(mend.pending).toHaveBeenCalledTimes(1);
  });

  it("sends one response for two sends at once", async () => {
    const held = Promise.withResolvers<void>();
    const mend = server(["r1"], [() => held.promise]);
    const first = mend.answers.send(request, ALLOW);
    const second = mend.answers.send(request, { decision: "decline" });
    await vi.waitFor(() =>
      expect(mend.answers.state("r1")).toEqual({ kind: "sending", response: ALLOW }),
    );
    held.resolve();
    expect(await Promise.all([first, second])).toEqual([
      { kind: "answered", response: ALLOW },
      { kind: "answered", response: ALLOW },
    ]);
    expect(mend.respond).toHaveBeenCalledTimes(1);
    expect(mend.pending).toHaveBeenCalledTimes(1);
    await mend.answers.send(request, ALLOW);
    expect(mend.respond).toHaveBeenCalledTimes(1);
  });

  it("is gone when Mend says the request already has an answer", async () => {
    const mend = server(
      ["r1"],
      [
        async () => {
          throw new MendApiError(
            "That request already has an answer.",
            409,
            "AgentRequestResolved",
          );
        },
      ],
    );
    expect(await mend.answers.send(request, ALLOW)).toEqual({ kind: "gone" });
  });

  it("fails retryably when Mend is not reached, and a retry sends the same response once", async () => {
    const unreached = new MendApiError("Cannot reach Mend at http://mend-mini:3105.", null);
    const mend = server(
      ["r1"],
      [
        async () => {
          throw unreached;
        },
      ],
    );
    const failed = await mend.answers.send(request, ALLOW);
    expect(failed).toEqual({
      kind: "failed",
      response: ALLOW,
      words: "Cannot reach Mend at http://mend-mini:3105.",
      retryable: true,
      cause: unreached,
    });
    expect(await mend.answers.send(request, ALLOW)).toEqual({ kind: "answered", response: ALLOW });
    expect(mend.respond.mock.calls).toEqual([
      ["r1", ALLOW],
      ["r1", ALLOW],
    ]);
  });

  it("fails for good, in Mend's words, when Mend refuses who answers", async () => {
    const mend = server(
      ["r1"],
      [
        async () => {
          throw new MendApiError(
            "Only Ana can answer this; send a turn instead.",
            403,
            "SessionTurnRefused",
          );
        },
      ],
    );
    expect(await mend.answers.send(request, ALLOW)).toMatchObject({
      kind: "failed",
      words: "Only Ana can answer this; send a turn instead.",
      retryable: false,
    });
  });

  it("fails retryably while the conversation is not live yet, as just after Mend restarts", async () => {
    const notLive = new MendApiError(
      "The agent's conversation is not live.",
      409,
      "ProtocolSessionNotLive",
    );
    const mend = server(
      ["r1"],
      [
        async () => {
          throw notLive;
        },
      ],
    );
    expect(await mend.answers.send(request, ALLOW)).toEqual({
      kind: "failed",
      response: ALLOW,
      words: "Mend has not reattached to the agent yet",
      retryable: true,
      cause: notLive,
    });
    expect(await mend.answers.send(request, ALLOW)).toEqual({ kind: "answered", response: ALLOW });
  });

  it("sends nothing and keeps the request as it was when the re-read cannot reach Mend", async () => {
    const mend = server([], [], async () => {
      throw new MendApiError("Cannot reach Mend at http://mend-mini:3105.", null);
    });
    expect(await mend.answers.send(request, ALLOW)).toEqual({ kind: "unreachable" });
    expect(mend.answers.state("r1")).toEqual({ kind: "pending" });
    expect(mend.respond).not.toHaveBeenCalled();
  });
});

describe("an answer after VS Code connects to another server", () => {
  it("sends her words nowhere when the switch lands during the send's read", async () => {
    const heard = { A: new Array<Heard>(), B: new Array<Heard>() };
    const reached = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const a = await serve(heard.A, async (req, res) => {
      if (req.method === "GET") {
        reached.resolve();
        await release.promise;
        return json(res, 200, [pendingRequest({ id: "r1", sessionId: "s" })]);
      }
      json(res, 200, {});
    });
    const b = await serve(heard.B, (_req, res) => json(res, 404, { _tag: "NotFound" }));
    const connection = switchable(a);
    const client = new MendClient(connection.connections);
    const answers = new Answers(() => client.bind());

    const sent = answers.send(request, { answers: { q1: ["Postgres, as we agreed"] } });
    await reached.promise;
    connection.switchTo(b);
    release.resolve();

    expect(await sent).toMatchObject({ kind: "failed", retryable: true });
    expect(heard.A.filter((one) => one.method === "POST")).toEqual([]);
    expect(heard.B).toEqual([]);
  });
});
