import { describe, expect, it } from "vitest";

import { mainTestFixtures } from "./main-test-fixtures.ts";
import { encodeReceipt, turnReceipt } from "./message-test-fixtures.ts";

const { json, spawning, startCli, startFakeMend } = mainTestFixtures();
const id = "11111111-1111-4111-8111-111111111111";
const session = { id, worktree: "fix-login", branch: "mend/fix-login", status: "running" };
const turn = {
  id: "turn-2",
  sessionId: id,
  ordinal: 2,
  input: "fix login",
  status: "completed",
  createdAt: "2026-11-04T00:00:00Z",
  startedAt: null,
  endedAt: null,
};
const request = {
  id: "request-1",
  sessionId: id,
  turnId: turn.id,
  kind: "command-approval",
  status: "pending",
  title: "Run tests",
  questions: null,
  detail: { command: "pnpm test", apiKey: "private-grant-sentinel" },
  createdAt: turn.createdAt,
};

describe("shell conversation commands without a terminal", spawning, () => {
  it("launches an explicit conversation and returns ids without attaching or prompting", async () => {
    const writes: Array<{ url: string | undefined; body: unknown }> = [];
    const fake = await startFakeMend(async (req, res) => {
      if (req.url === "/api/projects") return json(res, [{ id: "project", name: "mend" }]);
      let body = "";
      for await (const chunk of req) body += String(chunk);
      writes.push({ url: req.url, body: JSON.parse(body) });
      json(res, session);
    });
    try {
      const cli = startCli(fake.url, [
        "claude",
        "--project",
        "mend",
        "--detach",
        "--conversation",
        "--json",
        "fix login",
      ]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toEqual({
        v: 1,
        status: "done",
        data: {
          sessionId: id,
          worktree: "fix-login",
          branch: "mend/fix-login",
          url: `${fake.url}/sessions/${id}`,
        },
      });
      expect(writes).toEqual([
        {
          url: "/api/projects/project/sessions",
          body: { harness: "claude", label: null, name: null, base: null },
        },
        { url: `/api/sessions/${id}/launch`, body: { mode: "protocol", prompt: "fix login" } },
      ]);
    } finally {
      await fake.close();
    }
  });

  it.each([
    ["history", "--json"],
    ["wait", "--turn", "--json"],
    ["respond", "--json"],
    ["interrupt", "--json"],
    ["stop", "--json"],
    ["claude", "--json"],
  ])("returns usage for missing explicit inputs in %j", async (...args) => {
    const cli = startCli("http://127.0.0.1:1", args);
    expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 2 });
    expect(JSON.parse(cli.stdout())).toMatchObject({
      v: 1,
      status: "usage",
      error: { code: expect.any(String), fix: expect.any(String) },
    });
  });

  it.each(["completed", "failed", "running"])(
    "observes a %s turn and returns human requests before waiting further",
    async (status) => {
      const fake = await startFakeMend((req, res) => {
        if (req.url?.endsWith("/turns")) return json(res, [{ ...turn, status }]);
        if (req.url?.includes("/requests?"))
          return json(res, status === "running" ? [request] : []);
        json(res, { session });
      });
      try {
        const cli = startCli(fake.url, ["wait", id, "--turn", "--json", "--timeout", "5s"]);
        expect(await cli.exited, cli.stderr()).toEqual({
          kind: "exit",
          code: status === "completed" ? 0 : status === "failed" ? 1 : 3,
        });
        expect(JSON.parse(cli.stdout())).toMatchObject({
          v: 1,
          data: { turn: { id: turn.id, status }, url: `${fake.url}/sessions/${id}` },
        });
        if (status === "running") {
          expect(JSON.parse(cli.stdout())).toMatchObject({
            status: "waiting",
            url: `${fake.url}/sessions/${id}`,
            data: { requests: [{ id: request.id, detail: { command: "pnpm test" } }] },
          });
        }
        expect(cli.stdout() + cli.stderr()).not.toContain("private-grant-sentinel");
      } finally {
        await fake.close();
      }
    },
  );

  it("bounds session resolution with the turn timeout", async () => {
    const fake = await startFakeMend(() => undefined);
    try {
      const cli = startCli(fake.url, ["wait", id, "--turn", "--json", "--timeout", ".05s"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 124 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "timeout",
        error: { code: "timeout" },
      });
    } finally {
      await fake.close();
    }
  });

  it.each(["resolved", "cancelled"])("finishes waiting after a request is %s", async (status) => {
    const saved = { ...request, status };
    const fake = await startFakeMend((req, res) => {
      const url = new URL(req.url ?? "/", "http://fixture");
      if (url.pathname.endsWith("/turns")) return json(res, [turn]);
      if (url.pathname.endsWith("/requests"))
        return json(res, url.searchParams.get("pending") === "1" ? [] : [saved]);
      json(res, { session });
    });
    try {
      const cli = startCli(fake.url, ["wait", id, "--turn", "--json", "--timeout", "5s"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { turn: { id: turn.id, status: "completed" }, requests: [] },
      });
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("preserves steering delivery, message correlation and recorded answers in history", async () => {
    const steer = {
      id: "steer-1",
      sessionId: id,
      processId: "process-1",
      turnId: turn.id,
      author: "person",
      ordinal: 1,
      input: "Also cover the Safari case",
      delivery: {
        _tag: "Accepted",
        evidence: "provider-acknowledged",
        apiKey: "private-grant-sentinel",
      },
      queuedTurnId: null,
      clientSteerId: "client-steer-1",
      clientMessageId: "client-follow-up",
      createdAt: turn.createdAt,
      updatedAt: turn.createdAt,
      apiKey: "private-grant-sentinel",
    };
    const savedTurn = {
      ...turn,
      clientMessageId: "client-original",
      steers: [steer],
      steerSender: "person",
      fromSteer: "earlier-steer",
    };
    const decision = {
      ...request,
      status: "resolved",
      decision: "accept",
      decidedBy: "person",
      answers: null,
      decidedAt: turn.createdAt,
    };
    const answer = {
      ...decision,
      id: "request-2",
      kind: "user-input",
      title: "Which browser?",
      decision: null,
      answers: { browser: ["Safari"] },
    };
    const fake = await startFakeMend((req, res) => {
      if (req.url?.includes("/history/items?")) return json(res, { items: [], next: null });
      if (req.url?.includes("/history/turns?"))
        return json(res, { turns: [savedTurn], next: null });
      if (req.url?.includes("/history/requests?"))
        return json(res, { requests: [decision, answer], next: null });
      json(res, { session });
    });
    try {
      const cli = startCli(fake.url, ["history", id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: {
          turns: [
            {
              id: turn.id,
              clientMessageId: "client-original",
              steerSender: "person",
              fromSteer: "earlier-steer",
              steers: [
                {
                  id: steer.id,
                  input: "Also cover the Safari case",
                  delivery: { _tag: "Accepted", evidence: "provider-acknowledged" },
                  clientSteerId: "client-steer-1",
                  clientMessageId: "client-follow-up",
                  createdAt: turn.createdAt,
                  updatedAt: turn.createdAt,
                },
              ],
            },
          ],
          requests: [
            {
              id: request.id,
              status: "resolved",
              decision: "accept",
              decidedBy: "person",
              answers: null,
              decidedAt: turn.createdAt,
            },
            {
              id: "request-2",
              status: "resolved",
              decision: null,
              decidedBy: "person",
              answers: { browser: ["Safari"] },
              decidedAt: turn.createdAt,
            },
          ],
        },
      });
      expect(cli.stdout() + cli.stderr()).not.toContain("private-grant-sentinel");
      expect(cli.stderr()).toBe("");
    } finally {
      await fake.close();
    }
  });

  it("reads every window of a starting turn and filters by ordinal, never UUID spelling", async () => {
    const older = { ...turn, id: "z-old", ordinal: 1 };
    const urls: Array<string | undefined> = [];
    const fake = await startFakeMend((req, res) => {
      urls.push(req.url);
      if (!req.url?.includes("/history/")) return json(res, { session });
      const page = req.url.includes("before=older");
      if (req.url.includes("/items?"))
        return json(res, {
          items: [
            {
              id: page ? "first" : "last",
              turnId: turn.id,
              seq: page ? 1 : 2,
              kind: "file-change",
              status: "completed",
              title: "src/auth.ts",
              text: null,
              data: { path: "src/auth.ts", token: "private-grant-sentinel" },
              createdAt: turn.createdAt,
              updatedAt: turn.createdAt,
            },
          ],
          next: page ? null : "older",
        });
      if (req.url.includes("/turns?"))
        return json(res, { turns: page ? [older, turn] : [turn], next: page ? null : "older" });
      json(res, { requests: [], next: null });
    });
    try {
      const cli = startCli(fake.url, ["history", id, "--since", turn.id, "--json"]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      const result = JSON.parse(cli.stdout());
      expect(result.data.turns).toHaveLength(1);
      expect(result.data.items.map((item: { id: string }) => item.id)).toEqual(["first", "last"]);
      expect(urls.filter((url) => url?.includes("before=older"))).toHaveLength(3);
      expect(cli.stdout()).not.toContain("private-grant-sentinel");
    } finally {
      await fake.close();
    }
  });

  it("forwards exactly the person's stdin answers and interrupts the recorded running turn", async () => {
    const posts: Array<{ url: string | undefined; body: unknown }> = [];
    const fake = await startFakeMend(async (req, res) => {
      if (req.method === "POST") {
        let body = "";
        for await (const chunk of req) body += String(chunk);
        posts.push({ url: req.url, body: body === "" ? null : JSON.parse(body) });
        return json(res, { ...request, status: "resolved" });
      }
      if (req.url?.endsWith("/turns")) return json(res, [{ ...turn, status: "running" }]);
      json(res, { session });
    });
    try {
      const reply = startCli(
        fake.url,
        ["respond", request.id, "--answers", "-", "--json"],
        {},
        undefined,
        '{"q1":["Please use Safari"]}',
      );
      expect(await reply.exited, reply.stderr()).toEqual({ kind: "exit", code: 0 });
      const interrupt = startCli(fake.url, ["interrupt", id, "--json"]);
      expect(await interrupt.exited, interrupt.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(posts).toEqual([
        {
          url: `/api/requests/${request.id}/respond`,
          body: { answers: { q1: ["Please use Safari"] } },
        },
        { url: `/api/turns/${turn.id}/interrupt`, body: null },
      ]);
      expect(JSON.parse(interrupt.stdout())).toMatchObject({
        v: 1,
        data: { turnId: turn.id, interruptRequested: true },
      });
    } finally {
      await fake.close();
    }
  });

  it("sends resume once with a correlated message and omits message text from its receipt", async () => {
    const bodies: Array<unknown> = [];
    const fake = await startFakeMend(async (req, res) => {
      if (req.method !== "POST") return json(res, { session });
      let body = "";
      for await (const chunk of req) body += String(chunk);
      bodies.push(JSON.parse(body));
      json(res, encodeReceipt(turnReceipt()));
    });
    try {
      const cli = startCli(fake.url, [
        "message",
        id,
        "private message words",
        "--resume",
        "--json",
      ]);
      expect(await cli.exited, cli.stderr()).toEqual({ kind: "exit", code: 0 });
      expect(bodies).toEqual([
        { input: "private message words", clientMessageId: expect.any(String), resume: true },
      ]);
      expect(JSON.parse(cli.stdout())).toMatchObject({
        v: 1,
        status: "done",
        data: { clientMessageId: expect.any(String), result: { _tag: "Turn" } },
      });
      expect(cli.stdout()).not.toContain("private message words");
    } finally {
      await fake.close();
    }
  });
});
