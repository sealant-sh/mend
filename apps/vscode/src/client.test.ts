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
