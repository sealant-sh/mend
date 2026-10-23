import { afterEach, describe, expect, it, vi } from "vitest";

import { MendClient } from "./client.js";

vi.mock("vscode", () => import("./test-vscode.js"));

afterEach(() => {
  vi.unstubAllGlobals();
});

const client = () =>
  new MendClient({
    get: async () => ({ url: "http://mend-mini:3105", token: "secret" }),
    refused: async () => {},
    held: async () => ({
      connection: { url: "http://mend-mini:3105", token: "secret" },
      current: () => true,
    }),
  });

const row = (id: string, status: string) => ({
  id,
  sessionId: "s",
  processId: "p",
  turnId: "t",
  kind: "tool-permission",
  providerRequestId: `provider-${id}`,
  providerItemId: null,
  title: "Bash",
  detail: null,
  questions: null,
  status,
  decision: status === "resolved" ? "accept" : null,
  decidedBy: null,
  answers: null,
  createdAt: "2026-10-20T08:00:00.000Z",
  decidedAt: null,
});

describe("a conversation's pending requests", () => {
  it("asks the server to filter with pending=1, and drops any row that is not pending", async () => {
    const fetch = vi.fn(
      async (_url: string) =>
        new Response(
          JSON.stringify([row("r1", "resolved"), row("r2", "pending"), row("r3", "cancelled")]),
        ),
    );
    vi.stubGlobal("fetch", fetch);
    const requests = await client().pendingRequests("s");
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      "http://mend-mini:3105/api/sessions/s/requests?pending=1",
    ]);
    expect(requests.map((request) => request.id)).toEqual(["r2"]);
    expect(requests[0]).toMatchObject({ sessionId: "s", processId: "p", kind: "tool-permission" });
  });

  it("answers one with POST /requests/:id/respond and the response as its body", async () => {
    const fetch = vi.fn(async (_url: string, _init?: RequestInit) => new Response("{}"));
    vi.stubGlobal("fetch", fetch);
    await client().respond("r 1", { answers: { q1: ["Postgres"] } });
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(url).toBe("http://mend-mini:3105/api/requests/r%201/respond");
    expect(init?.method).toBe("POST");
    expect(init?.body).toBe(JSON.stringify({ answers: { q1: ["Postgres"] } }));
  });
});

/** A process row as the server sends it; an older server sends no `runsAs`. */
const processRow = (id: string, runsAs?: string) => ({
  id,
  kind: "agent-protocol",
  harness: "claude",
  status: "running",
  exitedAt: null,
  providerSessionId: null,
  ...(runsAs === undefined ? {} : { runsAs }),
});

describe("a session's processes", () => {
  it("say whom each runs as, and nobody from an older server", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              session: {
                id: "s",
                projectId: "p1",
                harness: "claude",
                label: null,
                worktree: "w",
                branch: "b",
                status: "waiting",
                createdAt: "2026-10-20T08:00:00.000Z",
              },
              processes: [processRow("p", "ana"), processRow("q")],
              currentAgent: null,
            }),
          ),
      ),
    );
    const detail = await client().sessionDetail("s");
    expect(detail.processes.map((one) => one.runsAs)).toEqual(["ana", null]);
  });
});

const detailWith = (extra: Record<string, unknown>) =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          session: {
            id: "s",
            projectId: "p1",
            harness: "claude",
            label: null,
            worktree: "w",
            branch: "b",
            status: "idle",
            createdAt: "2026-10-20T08:00:00.000Z",
          },
          processes: [],
          currentAgent: null,
          ...extra,
        }),
      ),
  );

describe("how a server admits a Retry of a launch it never answered", () => {
  it.each([
    { said: "agentRan", read: "agentRan" },
    { said: "somethingLater", read: null },
    { said: undefined, read: null },
  ])("reads $said as $read", async ({ said, read }) => {
    vi.stubGlobal("fetch", detailWith(said === undefined ? {} : { launchAdmission: said }));
    expect((await client().sessionDetail("s")).launchAdmission).toBe(read);
  });
});

const CHECKPOINT = "0123456789abcdef0123456789abcdef01234567";

const worktreeRow = (handoff?: unknown) => ({
  id: "w1",
  name: "fix-login",
  directory: "/store/newsroom-api/worktrees/fix-login",
  branch: "fix-login",
  baseSha: "a".repeat(40),
  baseRef: "refs/heads/main",
  createdAt: "2026-10-22T07:42:09.000Z",
  ...(handoff === undefined ? {} : { handoff }),
});

const projectRead = (worktree: unknown) =>
  vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          project: {
            id: "p1",
            name: "newsroom-api",
            originUrl: null,
            storePath: "/store/newsroom-api",
            defaultBranch: "main",
          },
          sessions: [],
          worktrees: [worktree],
        }),
      ),
  );

describe("a worktree's handoff", () => {
  it("reads none when the server sends no handoff, or null", async () => {
    for (const worktree of [worktreeRow(), worktreeRow(null)]) {
      vi.stubGlobal("fetch", projectRead(worktree));
      const detail = await client().projectDetail("p1");
      expect(detail.worktrees?.map((one) => one.handoff)).toEqual([null]);
    }
  });

  it("reads where a handed-off worktree came from", async () => {
    vi.stubGlobal(
      "fetch",
      projectRead(
        worktreeRow({
          machine: "dana-mbp",
          localBranch: "fix-login",
          cutAt: "2026-10-22T07:42:05.000Z",
          head: "c".repeat(40),
          checkpoint: CHECKPOINT,
        }),
      ),
    );
    const detail = await client().projectDetail("p1");
    expect(detail.worktrees?.map((one) => one.handoff)).toEqual([
      { machine: "dana-mbp", cutAt: "2026-10-22T07:42:05.000Z", checkpoint: CHECKPOINT },
    ]);
  });

  const valid = {
    machine: "dana-mbp",
    cutAt: "2026-10-22T07:42:05.000Z",
    checkpoint: CHECKPOINT,
  };

  it.each([
    ["not an object", "dana-mbp"],
    ["a machine that is not a string", { ...valid, machine: 7 }],
    ["an empty machine", { ...valid, machine: "" }],
    ["a blank machine", { ...valid, machine: "   " }],
    ["a machine with a newline", { ...valid, machine: "dana\nmbp" }],
    ["a 65-character machine", { ...valid, machine: "m".repeat(65) }],
    ["a cutAt that is no instant", { ...valid, cutAt: "yesterday" }],
    ["a cutAt not in canonical ISO form", { ...valid, cutAt: "2026-10-22T07:42:05Z" }],
    ["a checkpoint that is no SHA", { ...valid, checkpoint: "HEAD" }],
  ])(
    "fails the read on a handoff with %s, rather than show the row without it",
    async (_, handoff) => {
      vi.stubGlobal("fetch", projectRead(worktreeRow(handoff)));
      await expect(client().projectDetail("p1")).rejects.toThrow(
        "Mend returned an invalid handoff.",
      );
    },
  );

  it("reads a 64-character machine", async () => {
    vi.stubGlobal("fetch", projectRead(worktreeRow({ ...valid, machine: "m".repeat(64) })));
    const detail = await client().projectDetail("p1");
    expect(detail.worktrees?.map((one) => one.handoff?.machine)).toEqual(["m".repeat(64)]);
  });
});

describe("whose a sign-in is", () => {
  it("reads it through that sign-in's own token, says unknown when Mend cannot answer, and keeps an answer per server and token", async () => {
    let up = true;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      if (!up) throw new TypeError("fetch failed");
      const token = new Headers(init?.headers).get("authorization");
      return new Response(JSON.stringify({ userId: token === "Bearer dana" ? "dana" : "erin" }));
    });
    vi.stubGlobal("fetch", fetch);
    const mend = client();
    const url = "http://mend-mini:3105";
    expect(await mend.accountOf({ url, token: "dana" })).toBe("dana");
    expect(await mend.accountOf({ url, token: "erin" })).toBe("erin");
    up = false;
    expect(await mend.accountOf({ url, token: "dana" })).toBe("dana");
    expect(await mend.accountOf({ url, token: "dana-again" })).toBeNull();
    expect(await mend.accountOf({ url: "http://other", token: "dana" })).toBeNull();
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it("throws Mend's refusal when Mend refused the token, rather than reading it as unknown", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ message: "Sign in" }), { status: 401 })),
    );
    await expect(
      client().accountOf({ url: "http://mend-mini:3105", token: null }),
    ).rejects.toMatchObject({
      status: 401,
    });
  });
});
